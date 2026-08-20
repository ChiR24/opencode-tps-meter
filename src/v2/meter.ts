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

import { createTracker } from "../tracker.js";
import { createIncrementalCounter, type IncrementalCounter } from "../tokenCounter.js";
import { createMetrics } from "./metrics.js";
import {
  CLEANUP_INTERVAL_MS,
  INVALID_FINISH_REASONS,
  MAX_MESSAGE_AGE_MS,
  MAX_RETAINED_SNAPSHOTS,
  DEFAULT_UPDATE_INTERVAL_MS,
  TOOL_CALL_FINISH_REASON,
  V2_EWMA_HALF_LIFE_MS,
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
  V2SessionTextDelta,
  V2SessionUsageUpdated,
  V2UnknownEvent,
} from "./types.js";

/** Event types the meter reacts to. Anything else is ignored. */
const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set<V2AnyMeterEvent["type"]>([
  "session.text.delta",
  "session.reasoning.delta",
  "session.step.ended",
  "session.usage.updated",
  "session.idle",
  "session.step.started",
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
  /** Tokens per second excluding tool execution time — the model's true rate. */
  generationTps: number;
  /** `providerID/modelID[#variant]`, or "default" before attribution arrives. */
  modelKey: string;
  /** Agent that produced the current step, when known. */
  agent?: string;
  /** Calibration samples backing this model's live estimate. 0 = uncalibrated. */
  calibrationSamples: number;
  /** True when the turn was aborted; the reading is not trustworthy. */
  interrupted: boolean;
}

/** One settled step, emitted for durable rollups. Interrupted turns are never emitted. */
export interface V2StepMeasurement {
  sessionID: string;
  modelKey: string;
  agent?: string;
  tokens: number;
  /** Elapsed with tool execution subtracted. */
  generationMs: number;
  cost: number;
  ttftMs: number;
}

export interface V2MeterHooks {
  readonly onStepSettled?: (measurement: V2StepMeasurement) => void;
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
  lastPublishedAt: number;
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
  const metrics = createMetrics();
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
  const listeners = new Set<(snapshots: ReadonlyMap<string, V2Snapshot>) => void>();
  /** Last time each session produced an event, for the stale sweep. */
  const lastActivityAt = new Map<string, number>();
  /** Usage accounting that survives per-turn resets. */
  const sessionUsage = new Map<string, SessionUsage>();

  function getSessionUsage(sessionID: string): SessionUsage {
    let usage = sessionUsage.get(sessionID);
    if (!usage) {
      usage = { cumulativeTokens: 0, observedStepTokens: 0 };
      sessionUsage.set(sessionID, usage);
    }
    return usage;
  }

  let snapshots: ReadonlyMap<string, V2Snapshot> = new Map();
  let lastSweepAt = 0;

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
        ewmaHalfLifeMs: V2_EWMA_HALF_LIFE_MS,
      }),
      firstTokenAt: null,
      lastTokenAt: null,
      lastPublishedAt: 0,
      lastPublishedWallAt: 0,
      firstTokenWallAt: null,
      dirty: false,
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

  function resetSession(sessionID: string): void {
    clearPublishTimer(sessionID);
    sessions.delete(sessionID);
    streamText.delete(sessionID);
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
   * quiet minutes. Only the heavy state (tracker, stream counters, metrics, usage) is freed;
   * retained readings are capped separately so churn cannot grow them without bound.
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
    }
    mutateSnapshots((draft) => {
      for (const sessionID of evict) {
        draft.delete(sessionID);
      }
    });
  }

  /**
   * Fields derived from turn decomposition and attribution.
   *
   * generationTps subtracts tool execution from the elapsed window, so a turn that spent
   * 8s of its 10s running a shell command reports the model's real rate rather than an
   * average diluted by waiting. v1 had no event timestamps and so could not do this.
   */
  /** Elapsed measured on the host clock, falling back to the tracker before two samples. */
  function elapsedFor(state: SessionState): number {
    if (state.firstTokenAt !== null && state.lastTokenAt !== null) {
      const span = state.lastTokenAt - state.firstTokenAt;
      if (span > 0) {
        return span;
      }
    }
    return state.tracker.getElapsedMs();
  }

  function derivedFields(sessionID: string, totalTokens: number, elapsedMs: number) {
    const turn = metrics.turnOf(sessionID);
    const attribution = metrics.attributionOf(sessionID);
    const generationMs = Math.max(0, elapsedMs - turn.toolMs);
    return {
      ttftMs: turn.ttftMs,
      toolMs: turn.toolMs,
      generationTps: generationMs > 0 ? totalTokens / (generationMs / 1000) : 0,
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

    const totalTokens = state.tracker.getTotalTokens();
    if (totalTokens === 0) {
      return;
    }

    clearPublishTimer(sessionID);
    state.lastPublishedAt = now;
    state.lastPublishedWallAt = Date.now();
    state.dirty = false;
    mutateSnapshots((draft) => {
      const elapsedMs = elapsedFor(state);
      draft.set(sessionID, {
        sessionID,
        instantTps: state.tracker.getSmoothedTPS(),
        avgTps: elapsedMs > 0 ? totalTokens / (elapsedMs / 1000) : state.tracker.getAverageTPS(),
        totalTokens,
        elapsedMs,
        active,
        overheadTokens: overheadFor(sessionID),
        ...derivedFields(sessionID, totalTokens, elapsedMs),
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

  function publishFinal(
    sessionID: string,
    totalTokens: number,
    avgTps: number,
    elapsedMs: number,
    overheadTokens: number
  ): void {
    if (totalTokens === 0 || elapsedMs < config.initialDisplayDelayMs) {
      return;
    }
    mutateSnapshots((draft) => {
      draft.set(sessionID, {
        sessionID,
        instantTps: 0,
        avgTps,
        totalTokens,
        elapsedMs,
        active: false,
        overheadTokens,
        ...derivedFields(sessionID, totalTokens, elapsedMs),
      });
    });
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
   */
  function persistIdleSnapshot(sessionID: string, now: number): void {
    const state = sessions.get(sessionID);
    if (state && state.tracker.getTotalTokens() > 0) {
      if (state.firstTokenAt !== null && now - state.firstTokenAt >= config.initialDisplayDelayMs) {
        publish(sessionID, false, now);
        return;
      }
    }

    const current = snapshots.get(sessionID);
    if (current?.active) {
      mutateSnapshots((draft) => {
        draft.set(sessionID, { ...current, active: false });
      });
    }
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

  function recordTokens(sessionID: string, tokenCount: number, at: number): void {
    if (tokenCount <= 0) {
      return;
    }
    const now = at;
    const state = getSessionState(sessionID);
    if (state.firstTokenAt === null) {
      state.firstTokenAt = now;
      state.firstTokenWallAt = Date.now();
    }
    state.lastTokenAt = now;
    state.tracker.recordTokens(tokenCount, now);
    maybePublishActive(sessionID, now);
  }

  function handleDelta(event: V2SessionTextDelta | V2SessionReasoningDelta): void {
    const { sessionID, assistantMessageID, ordinal, delta } = event.data;
    if (typeof delta !== "string" || delta.length === 0) {
      return;
    }
    const kind = event.type === "session.reasoning.delta" ? "reasoning" : "text";
    const at = eventTime(event, Date.now());
    const raw = countDelta(sessionID, assistantMessageID, ordinal, kind, delta);
    metrics.onFirstToken(sessionID, at);
    // scale() applies the model's learned chars-per-token factor and carries the fractional
    // remainder, so calibration never silently drops sub-token amounts.
    recordTokens(sessionID, metrics.scale(sessionID, raw), at);
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
  }

  function handleToolCalled(event: V2SessionToolCalled): void {
    metrics.onToolCalled(event.data.sessionID, event.data.id, eventTime(event, Date.now()));
  }

  function handleToolSettled(event: V2SessionToolSettled): void {
    metrics.onToolSettled(event.data.sessionID, event.data.id, eventTime(event, Date.now()));
  }

  function handleExecutionStarted(event: V2SessionExecutionStarted): void {
    metrics.onExecutionStarted(event.data.sessionID, eventTime(event, Date.now()));
  }

  function handleExecutionSettled(event: V2SessionExecutionSettled): void {
    metrics.onExecutionSettled(
      event.data.sessionID,
      event.type === "session.execution.interrupted"
    );
  }

  function handleStepEnded(event: V2SessionStepEnded): void {
    const { sessionID, finish, tokens } = event.data;
    const now = eventTime(event, Date.now());

    // Every settled step consumed tokens, including one that ends to run tools — record it
    // before any early return or the overhead residual overcounts.
    const settledTokens = toTokenCount(tokens?.output) + toTokenCount(tokens?.reasoning);
    if (settledTokens > 0) {
      getSessionUsage(sessionID).observedStepTokens += settledTokens;
    }
    // One closed calibration loop per step: heuristic tokens streamed vs provider truth.
    metrics.calibrate(sessionID, settledTokens);

    // A step that ends to run tools is not the end of the turn — hold the last reading
    // on screen so the meter does not blink out between tool calls.
    if (finish === TOOL_CALL_FINISH_REASON) {
      persistIdleSnapshot(sessionID, now);
      resetSession(sessionID);
      return;
    }

    if (finish && INVALID_FINISH_REASONS.has(finish)) {
      resetSession(sessionID);
      clearActiveSnapshot(sessionID);
      return;
    }

    const state = sessions.get(sessionID);
    const stepTokens = settledTokens;
    const trackedTokens = state?.tracker.getTotalTokens() ?? 0;
    // Fall back to the streamed heuristic, never to the cumulative session total —
    // session.usage.updated is a whole-session figure and would wildly overstate one step.
    const totalTokens = stepTokens > 0 ? stepTokens : trackedTokens;
    const elapsedMs = state?.firstTokenAt ? Math.max(0, now - state.firstTokenAt) : 0;
    const avgTps = elapsedMs > 0 ? totalTokens / (elapsedMs / 1000) : 0;

    publishFinal(sessionID, totalTokens, avgTps, elapsedMs, overheadFor(sessionID));

    // Feed the durable rollup. An aborted turn is excluded: its elapsed window is truncated
    // at an arbitrary point, so folding it in would drag every average down.
    const turn = metrics.turnOf(sessionID);
    if (!turn.interrupted && totalTokens > 0) {
      const attribution = metrics.attributionOf(sessionID);
      hooks?.onStepSettled?.({
        sessionID,
        modelKey: attribution.key,
        agent: attribution.agent,
        tokens: totalTokens,
        generationMs: Math.max(0, elapsedMs - turn.toolMs),
        cost: typeof event.data.cost === "number" && event.data.cost > 0 ? event.data.cost : 0,
        ttftMs: turn.ttftMs,
      });
    }

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
        case "session.idle":
          persistIdleSnapshot(event.data.sessionID, eventTime(event, Date.now()));
          resetSession(event.data.sessionID);
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
      sessions.clear();
      streamText.clear();
      lastActivityAt.clear();
      sessionUsage.clear();
      metrics.dispose();
      listeners.clear();
      snapshots = new Map();
      lastSweepAt = 0;
    },
  };
}
