/**
 * Session tracking core for OpenCode v2.
 *
 * Framework-free so both the v2 TUI entry and the v2 server entry can drive it.
 * Mirrors the v1 TUI state machine (see src/tui.tsx) so displayed numbers stay
 * consistent across hosts, but consumes the v2 event vocabulary:
 *
 *   v1 message.part.delta (field "text")  -> v2 session.text.delta
 *   v1 message.part.updated               -> v2 session.text.delta / session.reasoning.delta
 *   v1 message.updated (time.completed)   -> v2 session.step.ended
 *   v1 session.idle                       -> v2 session.idle  (unchanged)
 *
 * Unlike v1 there is no role filtering: text/reasoning deltas are assistant output by
 * construction, so the message-role and part-type caches are gone.
 *
 * @module v2/meter
 */

import { correctedAverage, createTracker } from "../tracker.js";
import { createIncrementalCounter, type IncrementalCounter } from "../tokenCounter.js";
import { createMetrics, type Calibration } from "./metrics.js";
import {
  CLEANUP_INTERVAL_MS,
  INVALID_FINISH_REASONS,
  MAX_MESSAGE_AGE_MS,
  MAX_RETAINED_SNAPSHOTS,
  DEFAULT_UPDATE_INTERVAL_MS,
  STALL_REPUBLISH_MS,
  TOOL_CALL_FINISH_REASON,
  V2_UPDATE_INTERVAL_MS,
} from "../constants.js";
import type { Config, TPSTracker } from "../types.js";
import type {
  V2AnyMeterEvent,
  V2SessionExecutionSettled,
  V2SessionExecutionStarted,
  V2SessionStepStarted,
  V2SessionToolCalled,
  V2SessionToolSettled,
  V2SessionReasoningDelta,
  V2SessionStepEnded,
  V2SessionStepFailed,
  V2SessionTextDelta,
  V2SessionToolInputDelta,
  V2SessionToolInputEnded,
  V2SessionUsageUpdated,
  V2UnknownEvent,
} from "./types.js";

/** Event types the meter reacts to. Anything else is ignored. */
const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set<V2AnyMeterEvent["type"]>([
  "session.text.delta",
  "session.reasoning.delta",
  "session.step.ended",
  "session.step.failed",
  "session.usage.updated",
  "session.idle",
  "session.step.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/** A rendered view of one session's throughput. */
export interface V2Snapshot {
  sessionID: string;
  instantTps: number;
  avgTps: number;
  totalTokens: number;
  elapsedMs: number;
  /** True while tokens are actively streaming; false once the turn settles. */
  active: boolean;
  /**
   * Tokens the session spent that no step reported: auto-title generation and context
   * compaction. Derived as (cumulative session usage - sum of observed step deltas), so it
   * is only meaningful once at least one session.usage.updated has arrived. 0 when unknown.
   */
  overheadTokens: number;
  /** Milliseconds from turn start to first streamed token. 0 when unknown. */
  ttftMs: number;
  /** Milliseconds this turn spent inside tool execution. */
  toolMs: number;
  /**
   * The model's generation rate. Tool execution happens between steps, never inside a
   * step's measured window, so this equals the step average; kept for the dashboard.
   */
  generationTps: number;
  /** `providerID/modelID[#variant]`, or "default" before attribution arrives. */
  modelKey: string;
  /** Agent that produced the current step, when known. */
  agent?: string;
  /** Calibration samples backing this model's live estimate. 0 = uncalibrated. */
  calibrationSamples: number;
  /** True when the turn was aborted; the reading is not trustworthy. */
  interrupted: boolean;
  /** Prompt tokens served from the cache this step (provider-reported). */
  cacheReadTokens: number;
  /** Prompt tokens written to the cache this step (provider-reported). */
  cacheWriteTokens: number;
  /** Uncached prompt input tokens this step (provider-reported). */
  inputTokens: number;
  /** Cached prompt tokens summed over every reported step this session. */
  sessionCacheReadTokens: number;
  /** Prompt tokens written to the cache over every reported step this session. */
  sessionCacheWriteTokens: number;
  /** Uncached prompt input tokens over every reported step this session. */
  sessionInputTokens: number;
  /**
   * LOCAL wall-clock time of this session's most recent token (or of its settling step end).
   *
   * Lets consumers age out readings themselves (the footer drops finished subagents after
   * a few seconds) without re-deriving activity from event streams they never see. It is
   * deliberately NOT the host event clock that token maths uses: consumers compare it
   * against their own Date.now(), and a remote or containerised service can be seconds off.
   */
  lastActivityAt: number;
  /**
   * Host-clock time of this session's first token in its current RUN — surviving the
   * per-step resets between tool calls, cleared when the session goes idle. The footer
   * renders children in this order, so columns hold still through tool calls, while a
   * finished session that is re-dispatched rejoins at the end. Only ever compared against
   * sibling stamps, which share the host clock.
   */
  startedAt: number;
}

/** Provider cache accounting for a single settled step. */
type StepCacheFields = Pick<
  V2Snapshot,
  "cacheReadTokens" | "cacheWriteTokens" | "inputTokens"
>;

/** One settled step, emitted for durable rollups. Interrupted turns are never emitted. */
export interface V2StepMeasurement {
  sessionID: string;
  modelKey: string;
  agent?: string;
  tokens: number;
  /** Time spent generating `tokens`, implied by the step's measured rate. */
  generationMs: number;
  cost: number;
  ttftMs: number;
}

export interface V2MeterHooks {
  readonly onStepSettled?: (measurement: V2StepMeasurement) => void;
  /** Per-model token calibration saved by an earlier session. */
  readonly initialCalibration?: Readonly<Record<string, Calibration>>;
  /** A model's calibration changed; persist it so the next session starts calibrated. */
  readonly onCalibrated?: (modelKey: string, calibration: Calibration) => void;
}

export interface V2Meter {
  /** Feeds one event in. Unrecognised events are ignored. */
  handleEvent(event: V2UnknownEvent): void;
  /** Current snapshot per session. */
  getSnapshots(): ReadonlyMap<string, V2Snapshot>;
  /** Subscribes to snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: (snapshots: ReadonlyMap<string, V2Snapshot>) => void): () => void;
  /** Clears all timers and state. */
  dispose(): void;
}

interface SessionState {
  tracker: TPSTracker;
  firstTokenAt: number | null;
  /**
   * Wall-clock time of the last publish.
   *
   * Deliberately NOT the host event clock: timers fire on wall time, so throttling has to be
   * decided on the same clock or the two disagree and updates are skipped. Token maths still
   * uses host time (firstTokenAt / lastTokenAt).
   */
  lastPublishedWallAt: number;
  /** Wall-clock time of the first token, for the startup-delay gate. */
  firstTokenWallAt: number | null;
  /** Tokens have been recorded since the last publish. */
  dirty: boolean;
  /**
   * Host time of the most recent token.
   *
   * The shared tracker measures elapsed with its own Date.now(), which would mix the local
   * clock with the host-stamped event clock we record tokens against. v2 derives elapsed
   * from these two host timestamps instead so both ends of the window share one clock.
   */
  lastTokenAt: number | null;
  /** Wall-clock time of the most recent token; feeds snapshot `lastActivityAt`. */
  lastTokenWallAt: number | null;
  lastPublishedAt: number;
  /**
   * Reasoning deltas arrived this step. When they did not, provider-reported reasoning
   * tokens were generated out of sight and must not be compared with what streamed.
   */
  sawReasoning: boolean;
  /** Prompt cache accounting from the latest step, for display.
   *
   * `input` here is OpenCode's `tokens.input`, which EXCLUDES cache reads and writes, so
   * the prompt-side total is `input + read + write`.
   */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
}

/**
 * Session-scoped usage accounting.
 *
 * Deliberately NOT part of SessionState: that is per-TURN and is destroyed on every
 * step end and idle, whereas cumulative usage and the observed-step sum must accumulate
 * across the whole session for the overhead residual to mean anything.
 */
interface SessionUsage {
  /**
   * Latest CUMULATIVE session usage from session.usage.updated. NOT a per-step figure:
   * the host publishes it from the accumulated session row, so it also includes auto-title
   * generation and compaction tokens.
   */
  cumulativeTokens: number;
  /** Sum of every per-step delta observed this session. */
  observedStepTokens: number;
  /** Prompt cache accounting summed over every reported step this session. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
}

/**
 * Coerces a provider-reported token field to a safe non-negative number.
 *
 * Guards the `output + reasoning` arithmetic: these values cross a process boundary from
 * the host, and a non-numeric field would silently turn the sum into string concatenation
 * ("100" + "50" -> "10050") and render as a bogus total.
 */
function toTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Resolves the timestamp to attribute an event's tokens to.
 *
 * The TUI delivers events in ~10ms batches, so `Date.now()` inside a handler is the FLUSH
 * time and every event in a batch shares it — which flattens the rolling window and skews
 * the instantaneous rate. Every v2 event carries a host-stamped `created` instead (v1 events
 * carried no timestamp at all, which is why v1 had to use local time).
 *
 * Falls back to local time if `created` is missing or implausible, so a payload change
 * degrades to v1-quality timing rather than producing garbage.
 */
function eventTime(event: { created?: unknown }, fallback: number): number {
  const created = event.created;
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) {
    return fallback;
  }
  // Guard against a foreign epoch or clock skew: anything more than a day out is not usable.
  if (Math.abs(created - fallback) > 86_400_000) {
    return fallback;
  }
  return created;
}

/** Narrows an arbitrary v2 event to one the meter understands. */
function asMeterEvent(event: V2UnknownEvent): V2AnyMeterEvent | undefined {
  if (!event || typeof event.type !== "string" || !HANDLED_EVENT_TYPES.has(event.type)) {
    return undefined;
  }
  const data = event.data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  // Every handled event carries a sessionID; without one there is nothing to attribute.
  const sessionID = (data as { sessionID?: unknown }).sessionID;
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    return undefined;
  }
  return event as unknown as V2AnyMeterEvent;
}

export function createMeter(config: Config, hooks?: V2MeterHooks): V2Meter {
  /**
   * Display throttle for v2.
   *
   * The host delivers events in ~10ms batches, so publishing faster than that cannot show
   * anything new — this is the useful floor. The v1 default (50ms) exists for the toast path,
   * which is far more expensive to update; an explicit user setting still wins.
   */
  const publishIntervalMs =
    config.updateIntervalMs === DEFAULT_UPDATE_INTERVAL_MS
      ? V2_UPDATE_INTERVAL_MS
      : config.updateIntervalMs;

  const algorithm =
    config.fallbackTokenHeuristic === "words_div_0_75"
      ? "word"
      : config.fallbackTokenHeuristic === "chars_div_3"
        ? "code"
        : "heuristic";

  const sessions = new Map<string, SessionState>();
  const metrics = createMetrics({
    initial: hooks?.initialCalibration,
    onCalibrated: hooks?.onCalibrated,
  });
  /**
   * One incremental counter per `${messageID}:${ordinal}:${kind}`.
   *
   * Previously this held the accumulated TEXT and re-counted it on every delta, which is
   * O(total) per delta and O(n^2) per response — the word heuristic took 10.2s to absorb a
   * 186k-character stream. Counters absorb each chunk once and never look back, which also
   * means the full response text is no longer retained in memory.
   */
  const streamText = new Map<string, Map<string, IncrementalCounter>>();
  const publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per session: fires when a live stream has gone quiet, to show its rate falling. */
  const stallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(snapshots: ReadonlyMap<string, V2Snapshot>) => void>();
  /** Last time each session produced an event, for the stale sweep. */
  const lastActivityAt = new Map<string, number>();
  /** Usage accounting that survives per-turn resets. */
  const sessionUsage = new Map<string, SessionUsage>();
  /**
   * Run-scoped first-token time. Feeds snapshot `startedAt`, which the footer sorts children
   * by; per-step `firstTokenAt` would move a subagent to the end of the line after every
   * tool-call break. Cleared on session.idle and by the stale sweep, so a re-dispatched
   * session counts as a new spawn and entries never outlive the session.
   */
  const sessionSpawnAt = new Map<string, number>();
  /**
   * Characters of each tool call's arguments already counted from input deltas, per session,
   * so input.ended (which repeats the full text) adds only the remainder.
   */
  const toolInputs = new Map<string, Map<string, number>>();
  /** Host time each session's current step started; the fallback window for its rate. */
  const stepStartedAt = new Map<string, number>();
  /** Sessions whose turn time-to-first-token has already gone to the ledger. */
  const ttftRecorded = new Set<string>();

  let snapshots: ReadonlyMap<string, V2Snapshot> = new Map();
  let lastSweepAt = 0;

  function getSessionUsage(sessionID: string): SessionUsage {
    let usage = sessionUsage.get(sessionID);
    if (!usage) {
      // A swept session can resume while its reading is still on screen: the stale sweep
      // frees usage but keeps the snapshot. Seed the cache totals from that retained reading
      // so the session rate continues instead of restarting from zero.
      const retained = snapshots.get(sessionID);
      usage = {
        cumulativeTokens: 0,
        observedStepTokens: 0,
        cacheReadTokens: retained?.sessionCacheReadTokens ?? 0,
        cacheWriteTokens: retained?.sessionCacheWriteTokens ?? 0,
        inputTokens: retained?.sessionInputTokens ?? 0,
      };
      sessionUsage.set(sessionID, usage);
    }
    return usage;
  }

  /**
   * Session-aggregated cache accounting, safe to read before any step has reported.
   *
   * Goes through getSessionUsage so a session the stale sweep freed is re-seeded from its
   * retained reading first. Reading the freed map directly would hand the session's next
   * live publish zeros, and that publish would overwrite the very totals it should carry on.
   */
  function sessionCacheFields(sessionID: string) {
    const usage = getSessionUsage(sessionID);
    return {
      sessionCacheReadTokens: usage.cacheReadTokens,
      sessionCacheWriteTokens: usage.cacheWriteTokens,
      sessionInputTokens: usage.inputTokens,
    };
  }

  function setSnapshots(next: ReadonlyMap<string, V2Snapshot>): void {
    snapshots = next;
    for (const listener of listeners) {
      listener(snapshots);
    }
  }

  function mutateSnapshots(mutate: (draft: Map<string, V2Snapshot>) => void): void {
    const draft = new Map(snapshots);
    mutate(draft);
    setSnapshots(draft);
  }

  function getStreamCache(sessionID: string): Map<string, IncrementalCounter> {
    const cache = streamText.get(sessionID) ?? new Map<string, IncrementalCounter>();
    streamText.set(sessionID, cache);
    return cache;
  }

  function getSessionState(sessionID: string): SessionState {
    let state = sessions.get(sessionID);
    if (state) {
      return state;
    }
    state = {
      tracker: createTracker({
        sessionId: sessionID,
        rollingWindowMs: config.rollingWindowMs,
      }),
      firstTokenAt: null,
      lastTokenAt: null,
      lastTokenWallAt: null,
      lastPublishedAt: 0,
      lastPublishedWallAt: 0,
      firstTokenWallAt: null,
      dirty: false,
      sawReasoning: false,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
    };
    sessions.set(sessionID, state);
    return state;
  }

  function clearPublishTimer(sessionID: string): void {
    const timer = publishTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      publishTimers.delete(sessionID);
    }
  }

  function clearStallTimer(sessionID: string): void {
    const timer = stallTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      stallTimers.delete(sessionID);
    }
  }

  /**
   * Republishes a live reading whose stream has gone quiet, with the rate as of now.
   *
   * The tracker can rate any moment, but a reading only changes when output arrives, so a
   * stalled stream kept showing its last speed. Wall time since the last chunk is carried
   * onto the host clock the tracker uses. Repeats until the rate reaches zero; the next
   * chunk, step end or idle takes over from there.
   */
  function republishStalled(sessionID: string): void {
    stallTimers.delete(sessionID);
    const state = sessions.get(sessionID);
    const current = snapshots.get(sessionID);
    if (!state || !current?.active || state.lastTokenAt === null || state.lastTokenWallAt === null) {
      return;
    }
    const hostNow = state.lastTokenAt + (Date.now() - state.lastTokenWallAt);
    const instantTps = state.tracker.getInstantTPS(hostNow);
    mutateSnapshots((draft) => {
      draft.set(sessionID, { ...current, instantTps });
    });
    if (instantTps > 0) {
      stallTimers.set(sessionID, setTimeout(() => republishStalled(sessionID), STALL_REPUBLISH_MS));
    }
  }

  function resetSession(sessionID: string): void {
    clearPublishTimer(sessionID);
    clearStallTimer(sessionID);
    sessions.delete(sessionID);
    streamText.delete(sessionID);
    toolInputs.delete(sessionID);
    stepStartedAt.delete(sessionID);
  }

  /**
   * Drops sessions that went quiet without a terminal event.
   *
   * A turn normally ends via session.step.ended or session.idle, both of which reset the
   * session. A crash, cancel, or dropped connection produces neither, which would strand the
   * per-session state for the life of the process.
   *
   * The last READING is deliberately kept: v1's TUI had no sweep and left the final numbers
   * on screen indefinitely, so dropping them here made the meter appear to forget after five
   * quiet minutes. Only the heavy state (tracker, stream counters, metrics, usage, spawn
   * stamp) is freed; retained readings are capped separately so churn cannot grow them
   * without bound. The reading stays untouched, `active` included — the footer judges
   * liveness by token recency (family.ts isGenerating), so a stranded flag cannot pass a
   * dead stream off as live throughput.
   */
  function sweepStaleSessions(now: number): void {
    if (now - lastSweepAt < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastSweepAt = now;

    const stale: string[] = [];
    for (const [sessionID, seenAt] of lastActivityAt) {
      if (now - seenAt > MAX_MESSAGE_AGE_MS) {
        stale.push(sessionID);
      }
    }
    if (stale.length === 0) {
      return;
    }

    for (const sessionID of stale) {
      resetSession(sessionID);
      sessionUsage.delete(sessionID);
      metrics.forget(sessionID);
      sessionSpawnAt.delete(sessionID);
      ttftRecorded.delete(sessionID);
      // Keep the activity stamp only while a reading survives, so it can be aged out later.
      if (!snapshots.has(sessionID)) {
        lastActivityAt.delete(sessionID);
      }
    }

    if (snapshots.size <= MAX_RETAINED_SNAPSHOTS) {
      return;
    }
    const oldestFirst = [...snapshots.keys()].sort(
      (a, b) => (lastActivityAt.get(a) ?? 0) - (lastActivityAt.get(b) ?? 0)
    );
    const evict = oldestFirst.slice(0, snapshots.size - MAX_RETAINED_SNAPSHOTS);
    for (const sessionID of evict) {
      lastActivityAt.delete(sessionID);
      sessionSpawnAt.delete(sessionID);
    }
    mutateSnapshots((draft) => {
      for (const sessionID of evict) {
        draft.delete(sessionID);
      }
    });
  }

  /** Fields derived from turn decomposition and attribution. */
  function derivedFields(sessionID: string, avgTps: number) {
    const turn = metrics.turnOf(sessionID);
    const attribution = metrics.attributionOf(sessionID);
    return {
      ttftMs: turn.ttftMs,
      toolMs: turn.toolMs,
      generationTps: avgTps,
      modelKey: attribution.key,
      agent: attribution.agent,
      calibrationSamples: metrics.samplesOf(sessionID),
      interrupted: turn.interrupted,
    };
  }

  function publish(sessionID: string, active: boolean, now: number): void {
    const state = sessions.get(sessionID);
    if (!state) {
      return;
    }

    // Nothing goes on screen until a rate is measurable: a figure computed over a few
    // milliseconds is noise, and it is exactly what produced five-digit readings.
    const totalTokens = state.tracker.getTotalTokens();
    if (totalTokens === 0 || !state.tracker.isRateReady()) {
      return;
    }

    clearPublishTimer(sessionID);
    state.lastPublishedAt = now;
    state.lastPublishedWallAt = Date.now();
    state.dirty = false;
    const avgTps = state.tracker.getAverageTPS();
    mutateSnapshots((draft) => {
      draft.set(sessionID, {
        sessionID,
        lastActivityAt: state.lastTokenWallAt ?? Date.now(),
        startedAt: sessionSpawnAt.get(sessionID) ?? state.firstTokenAt ?? now,
        instantTps: state.tracker.getSmoothedTPS(),
        avgTps,
        totalTokens,
        elapsedMs: state.tracker.getElapsedMs(),
        active,
        overheadTokens: overheadFor(sessionID),
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        inputTokens: state.inputTokens,
        ...sessionCacheFields(sessionID),
        ...derivedFields(sessionID, avgTps),
      });
    });
  }

  /**
   * Publishes terminal stats for a completed turn.
   * `totalTokens` is provider-reported where available, so the final figure is exact
   * rather than heuristic.
   */
  /**
   * Tokens billed to the session that no step accounted for.
   *
   * session.usage.updated is cumulative and includes work the user never asked for
   * (auto-title, compaction); session.step.ended deltas cover only real turns. The residual
   * between them IS that hidden overhead.
   */
  function overheadFor(sessionID: string): number {
    const usage = sessionUsage.get(sessionID);
    if (!usage || usage.cumulativeTokens <= 0) {
      return 0;
    }
    return Math.max(0, usage.cumulativeTokens - usage.observedStepTokens);
  }

  /**
   * The settled figures for a step that just ended.
   *
   * The rate comes from what streamed, timed by when it streamed, corrected by the provider's
   * count when the two agree (see correctedAverage). A step too short to time (one chunk, or
   * none) falls back to its whole duration from step start. That includes time to first
   * token, so it reads low rather than high.
   */
  function settledReading(
    sessionID: string,
    state: SessionState | undefined,
    providerTokens: number,
    providerVisible: number,
    endedAt: number
  ): { totalTokens: number; avgTps: number; elapsedMs: number } {
    const streamed = state?.tracker.getTotalTokens() ?? 0;
    const totalTokens = providerTokens > 0 ? providerTokens : streamed;
    const streamedAvg = state?.tracker.getAverageTPS() ?? 0;
    if (state && streamedAvg > 0) {
      return {
        totalTokens,
        avgTps: correctedAverage(streamedAvg, streamed, providerVisible),
        elapsedMs: state.tracker.getElapsedMs(),
      };
    }
    const startedAt = stepStartedAt.get(sessionID);
    const elapsedMs = startedAt !== undefined ? Math.max(0, endedAt - startedAt) : 0;
    return {
      totalTokens,
      avgTps: elapsedMs > 0 ? totalTokens / (elapsedMs / 1000) : 0,
      elapsedMs,
    };
  }

  function publishFinal(
    sessionID: string,
    reading: { totalTokens: number; avgTps: number; elapsedMs: number },
    overheadTokens: number,
    at: number,
    stepCache?: StepCacheFields
  ): boolean {
    const { totalTokens, avgTps, elapsedMs } = reading;
    if (totalTokens <= 0 || !(avgTps > 0)) {
      return false;
    }
    const state = sessions.get(sessionID);
    // Prefer the settled step's own accounting: a step with no deltas never created state,
    // and reading from it would drop that step's cache figures from the footer.
    const cacheFields = stepCache ?? {
      cacheReadTokens: state?.cacheReadTokens ?? 0,
      cacheWriteTokens: state?.cacheWriteTokens ?? 0,
      inputTokens: state?.inputTokens ?? 0,
    };
    mutateSnapshots((draft) => {
      draft.set(sessionID, {
        sessionID,
        lastActivityAt: Date.now(),
        startedAt: sessionSpawnAt.get(sessionID) ?? at,
        instantTps: 0,
        avgTps,
        totalTokens,
        elapsedMs,
        active: false,
        overheadTokens,
        ...cacheFields,
        ...sessionCacheFields(sessionID),
        ...derivedFields(sessionID, avgTps),
      });
    });
    return true;
  }

  /**
   * Merges cache accounting into an existing reading without touching TPS fields.
   *
   * Used when a settled step has no publishing path of its own — no deltas means no tracker
   * and no elapsed window — so its cache figures still reach the footer.
   */
  function mergeSnapshotCache(sessionID: string, stepCache: StepCacheFields): boolean {
    const current = snapshots.get(sessionID);
    if (!current) {
      return false;
    }
    mutateSnapshots((draft) => {
      draft.set(sessionID, { ...current, ...stepCache, ...sessionCacheFields(sessionID) });
    });
    return true;
  }

  function clearActiveSnapshot(sessionID: string): void {
    const current = snapshots.get(sessionID);
    if (current?.active) {
      mutateSnapshots((draft) => {
        draft.delete(sessionID);
      });
    }
  }

  /**
   * Freezes the meter at its last value instead of clearing it, so the reading stays
   * on screen between tool calls and after the turn ends.
   *
   * `stepCache` carries a settled step's provider cache accounting, so a step that produced
   * no deltas (and therefore never created session state) still updates the footer. Returns
   * whether a reading was written.
   */
  function persistIdleSnapshot(
    sessionID: string,
    now: number,
    stepCache?: StepCacheFields
  ): boolean {
    const state = sessions.get(sessionID);
    if (state?.tracker.isRateReady()) {
      publish(sessionID, false, now);
      return true;
    }

    const current = snapshots.get(sessionID);
    if (!current) {
      return false;
    }
    // Without step accounting there is nothing new to show unless the reading was active.
    if (!current.active && !stepCache) {
      return false;
    }
    mutateSnapshots((draft) => {
      draft.set(sessionID, {
        ...current,
        active: false,
        ...(stepCache ?? {}),
        ...sessionCacheFields(sessionID),
      });
    });
    return true;
  }

  /**
   * How long the startup delay has been open for.
   *
   * Measured as the larger of host-event elapsed and wall elapsed. In production the two
   * agree; they diverge only in degenerate cases — a single delta advances host time by
   * nothing, while a synchronous burst of host-timestamped events advances wall time by
   * nothing. Taking the max means neither case can stall the first reading.
   */
  function startupElapsed(state: SessionState, wallNow: number, hostNow: number): number {
    const host = state.firstTokenAt === null ? 0 : hostNow - state.firstTokenAt;
    const wall = state.firstTokenWallAt === null ? 0 : wallNow - state.firstTokenWallAt;
    return Math.max(host, wall);
  }

  /**
   * Ensures a publish happens once the throttle window closes.
   *
   * The timer publishes whatever is pending rather than re-testing the conditions that
   * scheduled it. Re-testing meant a timer could fire, fail a guard, and silently drop the
   * update — leaving the meter stale until the next delta happened to arrive.
   */
  function scheduleActivePublish(sessionID: string, delayMs: number): void {
    if (publishTimers.has(sessionID)) {
      return;
    }
    const timer = setTimeout(() => {
      publishTimers.delete(sessionID);
      const state = sessions.get(sessionID);
      if (
        state === undefined ||
        !state.dirty ||
        state.firstTokenAt === null ||
        state.lastTokenAt === null ||
        state.tracker.getTotalTokens() <= 0
      ) {
        return;
      }
      if (startupElapsed(state, Date.now(), state.lastTokenAt) < config.initialDisplayDelayMs) {
        return;
      }
      publish(sessionID, true, state.lastTokenAt);
    }, delayMs);
    publishTimers.set(sessionID, timer);
  }

  function maybePublishActive(sessionID: string, now: number): void {
    const state = sessions.get(sessionID);
    if (!state || state.firstTokenAt === null) {
      return;
    }
    state.dirty = true;

    if (state.tracker.getSmoothedTPS() < config.minVisibleTPS) {
      return;
    }

    // The throttle is decided on the wall clock, because that is the clock the timer fires
    // on — deciding it on host time made the two disagree and updates were skipped.
    const wallNow = Date.now();
    const initialDelayRemaining =
      config.initialDisplayDelayMs - startupElapsed(state, wallNow, now);
    const throttleDelayRemaining = publishIntervalMs - (wallNow - state.lastPublishedWallAt);

    if (initialDelayRemaining <= 0 && throttleDelayRemaining <= 0) {
      publish(sessionID, true, now);
      return;
    }

    scheduleActivePublish(sessionID, Math.max(1, initialDelayRemaining, throttleDelayRemaining));
  }

  /**
   * Counts the tokens a delta adds.
   *
   * Delegates to a per-stream incremental counter. Counting each chunk in isolation would
   * drift, because heuristics like chars/4 are not additive across chunk boundaries; the
   * counter keeps the running total instead, so the result matches counting the whole text
   * at once without ever re-reading it.
   */
  function countDelta(
    sessionID: string,
    messageID: string,
    ordinal: number,
    kind: "text" | "reasoning",
    delta: string
  ): number {
    const cache = getStreamCache(sessionID);
    const key = `${messageID}:${ordinal}:${kind}`;
    let counter = cache.get(key);
    if (!counter) {
      counter = createIncrementalCounter(algorithm);
      cache.set(key, counter);
    }
    return counter.add(delta);
  }

  /** Records tokens that arrived at `at` (host clock), rated over the gap since the last. */
  function recordTokens(sessionID: string, tokenCount: number, at: number): void {
    if (tokenCount <= 0) {
      return;
    }
    const state = getSessionState(sessionID);
    if (state.firstTokenAt === null) {
      state.firstTokenAt = at;
      state.firstTokenWallAt = Date.now();
    }
    if (!sessionSpawnAt.has(sessionID)) {
      sessionSpawnAt.set(sessionID, at);
    }
    state.lastTokenAt = at;
    state.lastTokenWallAt = Date.now();
    state.tracker.recordTokens(tokenCount, at);
    maybePublishActive(sessionID, at);
    clearStallTimer(sessionID);
    stallTimers.set(sessionID, setTimeout(() => republishStalled(sessionID), STALL_REPUBLISH_MS));
  }

  function handleDelta(event: V2SessionTextDelta | V2SessionReasoningDelta): void {
    const { sessionID, assistantMessageID, ordinal, delta } = event.data;
    if (typeof delta !== "string" || delta.length === 0) {
      return;
    }
    const kind = event.type === "session.reasoning.delta" ? "reasoning" : "text";
    const at = eventTime(event, Date.now());
    if (kind === "reasoning") {
      getSessionState(sessionID).sawReasoning = true;
    }
    const raw = countDelta(sessionID, assistantMessageID, ordinal, kind, delta);
    metrics.onFirstToken(sessionID, at);
    // scale() applies the model's learned chars-per-token factor and carries the fractional
    // remainder, so calibration never silently drops sub-token amounts.
    recordTokens(sessionID, metrics.scale(sessionID, raw), at);
  }

  function toolInputKey(event: { data: { assistantMessageID?: string; id: string } }): string {
    return `${event.data.assistantMessageID ?? ""}:tool:${event.data.id}`;
  }

  /**
   * Counts tool-call arguments: output the model generated, so it belongs in the total.
   *
   * They are rated like any other chunk, over the gap since the previous one. NOT from
   * session.tool.input.started: providers that do not stream tool arguments deliver the
   * whole call at once, and the host then emits started and ended ~100ms apart, so that
   * window read as 8,763 TPS for an 850-token call in live testing. A tool call that is the
   * step's first output is its opening chunk, and the step falls back to its whole duration.
   */
  function handleToolInput(event: V2SessionToolInputDelta | V2SessionToolInputEnded): void {
    const { sessionID } = event.data;
    if (typeof event.data.id !== "string") {
      return;
    }
    const at = eventTime(event, Date.now());
    const key = toolInputKey(event);
    const inputs = toolInputs.get(sessionID) ?? new Map<string, number>();
    toolInputs.set(sessionID, inputs);
    const counted = inputs.get(key) ?? 0;

    let added: string;
    if (event.type === "session.tool.input.delta") {
      added = typeof event.data.delta === "string" ? event.data.delta : "";
      // Remember how much was counted so input.ended adds only the remainder.
      inputs.set(key, counted + added.length);
    } else {
      const text = typeof event.data.text === "string" ? event.data.text : "";
      added = text.slice(counted);
      inputs.delete(key);
    }
    if (added.length === 0) {
      return;
    }

    const cache = getStreamCache(sessionID);
    let counter = cache.get(key);
    if (!counter) {
      counter = createIncrementalCounter(algorithm);
      cache.set(key, counter);
    }
    metrics.onFirstToken(sessionID, at);
    recordTokens(sessionID, metrics.scale(sessionID, counter.add(added)), at);
  }

  function handleUsageUpdated(event: V2SessionUsageUpdated): void {
    const { sessionID, tokens } = event.data;
    if (!tokens) {
      return;
    }
    getSessionUsage(sessionID).cumulativeTokens =
      toTokenCount(tokens.output) + toTokenCount(tokens.reasoning);
  }

  function handleStepStarted(event: V2SessionStepStarted): void {
    metrics.onStepStarted(event.data.sessionID, event.data.model, event.data.agent);
    // Prefer the step's own start stamp: the event is published with the first output, so its
    // `created` would leave a whole-call delivery's generation time out of the window.
    const created = eventTime(event, Date.now());
    const started = event.data.started;
    const plausible =
      typeof started === "number" &&
      Number.isFinite(started) &&
      started <= created &&
      created - started < 86_400_000;
    stepStartedAt.set(event.data.sessionID, plausible ? started : created);
  }

  function handleToolCalled(event: V2SessionToolCalled): void {
    metrics.onToolCalled(event.data.sessionID, event.data.id, eventTime(event, Date.now()));
  }

  function handleToolSettled(event: V2SessionToolSettled): void {
    metrics.onToolSettled(event.data.sessionID, event.data.id, eventTime(event, Date.now()));
  }

  function handleExecutionStarted(event: V2SessionExecutionStarted): void {
    metrics.onExecutionStarted(event.data.sessionID, eventTime(event, Date.now()));
    ttftRecorded.delete(event.data.sessionID);
  }

  function handleExecutionSettled(event: V2SessionExecutionSettled): void {
    metrics.onExecutionSettled(
      event.data.sessionID,
      event.type === "session.execution.interrupted"
    );
  }

  /**
   * Folds a settled step's provider usage into the session: cache accounting, the observed
   * total behind the overhead residual, and one calibration sample.
   *
   * Runs for every step that reports usage — including one that ends to run tools, and one
   * that never streamed anything — so none of them is missing from the session figures.
   */
  function foldStepUsage(
    sessionID: string,
    tokens: V2SessionStepEnded["data"]["tokens"] | undefined
  ): { stepCache: StepCacheFields; providerTokens: number; providerVisible: number } {
    const stepCache: StepCacheFields = {
      cacheReadTokens: toTokenCount(tokens?.cache?.read),
      cacheWriteTokens: toTokenCount(tokens?.cache?.write),
      inputTokens: toTokenCount(tokens?.input),
    };
    const state = sessions.get(sessionID);
    if (state) {
      state.cacheReadTokens = stepCache.cacheReadTokens;
      state.cacheWriteTokens = stepCache.cacheWriteTokens;
      state.inputTokens = stepCache.inputTokens;
    }

    const usage = getSessionUsage(sessionID);
    usage.cacheReadTokens += stepCache.cacheReadTokens;
    usage.cacheWriteTokens += stepCache.cacheWriteTokens;
    usage.inputTokens += stepCache.inputTokens;

    const output = toTokenCount(tokens?.output);
    const reasoning = toTokenCount(tokens?.reasoning);
    const providerTokens = output + reasoning;
    if (providerTokens > 0) {
      usage.observedStepTokens += providerTokens;
    }
    // Compare like with like: reasoning the host never streamed is in the provider's count
    // but not in the heuristic one, so it would skew both calibration and the step's rate.
    // And when reasoning streamed but the provider reports none, it either folded reasoning
    // into `output` or left it out; either way the count is not comparable, so it is unused
    // (0) rather than guessed at. Live testing hit exactly this and scaled rates down 40%.
    const providerVisible =
      state?.sawReasoning && reasoning === 0 ? 0 : output + (state?.sawReasoning ? reasoning : 0);
    metrics.calibrate(sessionID, providerVisible);
    return { stepCache, providerTokens, providerVisible };
  }

  function handleStepEnded(event: V2SessionStepEnded): void {
    const { sessionID, finish } = event.data;
    const now = eventTime(event, Date.now());
    const state = sessions.get(sessionID);
    const { stepCache, providerTokens, providerVisible } = foldStepUsage(
      sessionID,
      event.data.tokens
    );

    // A finish the host could not classify says nothing trustworthy about this step.
    if (finish && finish !== TOOL_CALL_FINISH_REASON && INVALID_FINISH_REASONS.has(finish)) {
      resetSession(sessionID);
      clearActiveSnapshot(sessionID);
      return;
    }

    // Every other step settles the same way, including one that ends to run tools: its
    // reading stays on screen, frozen, until the next step streams.
    const reading = settledReading(sessionID, state, providerTokens, providerVisible, now);
    if (!publishFinal(sessionID, reading, overheadFor(sessionID), now, stepCache)) {
      // Nothing measurable to show, but the step's cache accounting still belongs on screen.
      mergeSnapshotCache(sessionID, stepCache);
    }

    // Feed the durable rollup. An aborted turn is excluded: its window was cut off at an
    // arbitrary point, so folding it in would drag every average down.
    const turn = metrics.turnOf(sessionID);
    if (!turn.interrupted && reading.totalTokens > 0 && reading.avgTps > 0) {
      const attribution = metrics.attributionOf(sessionID);
      // Time to first token belongs to the turn, so it is recorded once, not once per step.
      const ttftMs = ttftRecorded.has(sessionID) ? 0 : turn.ttftMs;
      if (ttftMs > 0) {
        ttftRecorded.add(sessionID);
      }
      hooks?.onStepSettled?.({
        sessionID,
        modelKey: attribution.key,
        agent: attribution.agent,
        tokens: reading.totalTokens,
        generationMs: (reading.totalTokens / reading.avgTps) * 1000,
        cost: typeof event.data.cost === "number" && event.data.cost > 0 ? event.data.cost : 0,
        ttftMs,
      });
    }

    resetSession(sessionID);
  }

  /**
   * A step that ended on an error. Its usage still counts when the provider reported any;
   * the reading freezes where it was, since a failed step's rate is not one to settle on.
   */
  function handleStepFailed(event: V2SessionStepFailed): void {
    const { sessionID } = event.data;
    const { stepCache } = foldStepUsage(sessionID, event.data.tokens);
    persistIdleSnapshot(sessionID, eventTime(event, Date.now()), stepCache);
    resetSession(sessionID);
  }

  return {
    handleEvent(raw: V2UnknownEvent): void {
      const event = asMeterEvent(raw);
      if (!event) {
        return;
      }

      const now = Date.now();
      lastActivityAt.set(event.data.sessionID, now);
      sweepStaleSessions(now);

      switch (event.type) {
        case "session.text.delta":
        case "session.reasoning.delta":
          handleDelta(event);
          break;
        case "session.usage.updated":
          handleUsageUpdated(event);
          break;
        case "session.step.started":
          handleStepStarted(event);
          break;
        case "session.tool.called":
          handleToolCalled(event);
          break;
        case "session.tool.success":
        case "session.tool.failed":
          handleToolSettled(event);
          break;
        case "session.execution.started":
          handleExecutionStarted(event);
          break;
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          handleExecutionSettled(event);
          break;
        case "session.step.ended":
          handleStepEnded(event);
          break;
        case "session.step.failed":
          handleStepFailed(event);
          break;
        case "session.tool.input.delta":
        case "session.tool.input.ended":
          handleToolInput(event);
          break;
        case "session.idle":
          persistIdleSnapshot(event.data.sessionID, eventTime(event, Date.now()));
          resetSession(event.data.sessionID);
          // The run is over: a re-dispatch is a new spawn and rejoins the footer at the end.
          sessionSpawnAt.delete(event.data.sessionID);
          ttftRecorded.delete(event.data.sessionID);
          break;
      }
    },

    getSnapshots(): ReadonlyMap<string, V2Snapshot> {
      return snapshots;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      for (const timer of publishTimers.values()) {
        clearTimeout(timer);
      }
      publishTimers.clear();
      for (const timer of stallTimers.values()) {
        clearTimeout(timer);
      }
      stallTimers.clear();
      sessions.clear();
      streamText.clear();
      lastActivityAt.clear();
      sessionUsage.clear();
      sessionSpawnAt.clear();
      toolInputs.clear();
      stepStartedAt.clear();
      ttftRecorded.clear();
      metrics.dispose();
      listeners.clear();
      snapshots = new Map();
      lastSweepAt = 0;
    },
  };
}
