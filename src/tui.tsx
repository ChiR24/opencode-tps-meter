import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { agentNameFromMessage } from "./agentName.js";
import { createTracker } from "./tracker.js";
import { createTokenizer, createIncrementalCounter, type IncrementalCounter } from "./tokenCounter.js";
import { defaultConfig, loadConfigSync } from "./config.js";
import {
  AGGREGATE_TICK_INTERVAL_MS,
  COUNTABLE_PART_TYPES,
  INVALID_FINISH_REASONS,
  MAX_REMEMBERED_SESSIONS,
  TOOL_CALL_FINISH_REASON,
} from "./constants.js";
import { formatMeterText } from "./format.js";
import type { Config } from "./types.js";
import {
  aggregateReading,
  collectMeterEntries,
  formatAggregateLine,
  hasSubagentEntries,
  sameIDs,
} from "./v2/family.js";
import { setupTui as setupTuiV2 } from "./v2/tui.js";
import type { V2Cleanup, V2TuiContext } from "./v2/types.js";

type TrackerInstance = ReturnType<typeof createTracker>;
type Role = "assistant" | "user";

interface SessionState {
  tracker: TrackerInstance;
  firstTokenAt: number | null;
  /** Local time of the most recent token; feeds snapshot `lastActivityAt`. */
  lastTokenAt: number | null;
  lastPublishedAt: number;
}

interface TuiSnapshot {
  sessionId: string;
  instantTps: number;
  avgTps: number;
  totalTokens: number;
  elapsedMs: number;
  active: boolean;
  /**
   * Local-clock time of the last token (or of the completed message), so finished subagents
   * can be aged out of the aggregate. Never the server's `info.time.completed`: the footer
   * compares this against the local Date.now().
   */
  lastActivityAt: number;
  /**
   * Local-clock time of this session's first token in its current RUN — surviving the
   * per-message resets between tool calls, cleared on session.idle. The footer renders
   * children in this order: columns hold still through tool calls, and a finished session
   * that is re-dispatched rejoins at the end.
   */
  startedAt: number;
}

/** Longest parent chain walked; cycles and missing links end the walk sooner. */
const MAX_TREE_DEPTH = 16;

const IDLE_READING = { active: false, instantTps: 0 } as const;

function loadTuiConfig(): Config {
  try {
    return loadConfigSync();
  } catch {
    return defaultConfig;
  }
}

/** Sets a key in an insertion-ordered map used as an LRU, evicting the oldest beyond the cap. */
function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED_SESSIONS) {
    const oldest = map.keys().next();
    if (oldest.done) {
      break;
    }
    map.delete(oldest.value);
  }
}

function colorForSnapshot(
  theme: TuiPluginApi["theme"]["current"],
  config: Config,
  reading: { readonly active: boolean; readonly instantTps: number }
) {
  if (!reading.active) {
    return theme.textMuted;
  }
  if (!config.enableColorCoding) {
    return theme.text;
  }
  if (reading.instantTps < config.slowTpsThreshold) {
    return theme.error;
  }
  if (reading.instantTps > config.fastTpsThreshold) {
    return theme.success;
  }
  return theme.warning;
}

function MeterView(props: {
  api: TuiPluginApi;
  config: Config;
  sessionId: string;
  snapshots: () => ReadonlyMap<string, TuiSnapshot>;
  /**
   * Resolves the selected session's family among the sessions that have a reading.
   * Absent or throwing host APIs degrade to single-session.
   */
  familyOf: (
    sessionId: string,
    candidateIDs: readonly string[]
  ) => { rootID: string; memberIDs: readonly string[] };
  /** Bumped whenever a parent link is learned, so family resolution re-runs. */
  treeVersion: () => number;
  agentOf: (sessionId: string) => string | undefined;
  isRunning: (sessionId: string) => boolean | undefined;
}) {
  const current = createMemo(() => props.snapshots().get(props.sessionId));

  /** Which sessions have a reading. Notifies only when that set changes, not per publish. */
  const readingIDs = createMemo(() => [...props.snapshots().keys()], [], { equals: sameIDs });

  /**
   * The selected session's family. Mirrors the v2 footer's split: walking every session's
   * parent chain on each publish grew with every session the TUI had ever metered, so the
   * tree is resolved only when the set of readings or the known links change.
   */
  const family = createMemo(() => {
    props.treeVersion();
    return props.familyOf(props.sessionId, readingIDs());
  });

  /** Heartbeat for the recency filter; runs only while the aggregate line is on screen. */
  const [tick, setTick] = createSignal(0);

  /** Not gated on the selected session's own reading, exactly like the v2 footer. */
  const entries = createMemo(() => {
    const { rootID, memberIDs } = family();
    tick();
    return collectMeterEntries({
      rootID,
      memberIDs,
      snapshots: props.snapshots(),
      agentOf: props.agentOf,
      isRunning: props.isRunning,
      now: Date.now(),
      generatingWindowMs: props.config.rollingWindowMs,
    });
  });

  const aggregate = createMemo(() => {
    const rows = entries();
    return hasSubagentEntries(rows)
      ? { text: formatAggregateLine(rows), reading: aggregateReading(rows) }
      : undefined;
  });

  const showingAggregate = createMemo(() => aggregate() !== undefined);
  createEffect(() => {
    if (!showingAggregate()) {
      return;
    }
    const heartbeat = setInterval(() => setTick((value) => value + 1), AGGREGATE_TICK_INTERVAL_MS);
    onCleanup(() => clearInterval(heartbeat));
  });

  const line = createMemo(() => {
    const rows = aggregate();
    if (rows !== undefined) {
      return rows.text;
    }
    const snapshot = current();
    return snapshot ? formatMeterText(snapshot, props.config) : "";
  });

  // Coloured by what the line shows: the aggregate's own state, or the selected session.
  const reading = () => aggregate()?.reading ?? current() ?? IDLE_READING;

  return (
    <Show when={line()} fallback={<box flexShrink={0} />}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={colorForSnapshot(props.api.theme.current, props.config, reading())}>
          {line()}
        </text>
      </box>
    </Show>
  );
}

const tui: TuiPlugin = async (api) => {
  const config = loadTuiConfig();
  if (!config.enabled) {
    return;
  }

  const tokenizerAlgorithm =
    config.fallbackTokenHeuristic === "words_div_0_75"
      ? "word"
      : config.fallbackTokenHeuristic === "chars_div_3"
        ? "code"
        : "heuristic";
  const tokenizer = createTokenizer(tokenizerAlgorithm);
  const [snapshots, setSnapshots] = createSignal(new Map<string, TuiSnapshot>());
  const sessions = new Map<string, SessionState>();
  // Part-type keys hold accumulated TEXT (the full-part path diffs against it); the `:live`
  // key holds an incremental counter, since it was only ever read to compute a token
  // difference and re-counting the whole string per delta is O(total).
  const partTextCache = new Map<string, Map<string, string | IncrementalCounter>>();
  const messageRoles = new Map<string, Map<string, Role>>();
  const publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const disposers: Array<() => void> = [];
  /**
   * Parent links and agent names per session, for multi-session attribution.
   *
   * v1 has no synced family API like v2's `ctx.data.session`, but it does carry the real
   * tree: `session.created`/`session.updated` events expose `info.parentID`, and
   * `api.state.session.get()` serves the same `Session` shape synchronously. Agent names
   * ride on message payloads (`agent`, `mode`, or the legacy identity fields) — they are
   * cached here because parts never carry them.
   *
   * session.updated fires for every session in the project, so both maps are bounded LRUs;
   * `api.state.session` stays the primary source for parent links.
   */
  const sessionParents = new Map<string, string | null>();
  const sessionAgents = new Map<string, string>();
  const [treeVersion, setTreeVersion] = createSignal(0);
  /**
   * Run-scoped first-token time; feeds snapshot `startedAt` for stable child ordering.
   * Cleared on session.idle, and bounded because a crashed session never goes idle.
   */
  const sessionSpawnAt = new Map<string, number>();

  function parentOf(sessionId: string): string | undefined {
    try {
      const fromState = api.state?.session?.get?.(sessionId)?.parentID;
      if (typeof fromState === "string" && fromState.length > 0) {
        return fromState;
      }
    } catch {
      // State store unavailable; fall through to event-derived knowledge only.
    }
    return sessionParents.get(sessionId) ?? undefined;
  }

  function rememberParent(info: unknown): void {
    if (!info || typeof info !== "object") {
      return;
    }
    const record = info as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      return;
    }
    const parentID =
      typeof record.parentID === "string" && record.parentID.length > 0 ? record.parentID : null;
    if (sessionParents.has(record.id) && sessionParents.get(record.id) === parentID) {
      return;
    }
    rememberBounded(sessionParents, record.id, parentID);
    setTreeVersion((version) => version + 1);
  }

  /**
   * Walks parent links as far as they go; cycles and missing links terminate the walk.
   *
   * `resolved` memoises roots across the walks of one family resolution: siblings share
   * their ancestors, so each chain is walked once rather than once per descendant.
   */
  function walkToRoot(sessionId: string, resolved: Map<string, string>): string {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = sessionId;
    let root = resolved.get(current);
    while (root === undefined) {
      path.push(current);
      seen.add(current);
      const parent = path.length <= MAX_TREE_DEPTH ? parentOf(current) : undefined;
      if (!parent || seen.has(parent)) {
        root = current;
        break;
      }
      current = parent;
      root = resolved.get(current);
    }
    for (const id of path) {
      resolved.set(id, root);
    }
    return root;
  }

  /**
   * Resolves the selected session's family: every candidate whose own root chain lands on
   * the same topmost ancestor — including that ancestor itself, so "main" always renders.
   */
  function resolveFamily(
    sessionId: string,
    candidateIDs: readonly string[]
  ): { rootID: string; memberIDs: readonly string[] } {
    const resolved = new Map<string, string>();
    const rootID = walkToRoot(sessionId, resolved);
    const memberIDs: string[] = [];
    for (const id of new Set([sessionId, ...candidateIDs])) {
      if (walkToRoot(id, resolved) === rootID) {
        memberIDs.push(id);
      }
    }
    return { rootID, memberIDs };
  }

  /** Host run status: busy or retrying counts as running. Unknown when the store is absent. */
  function isRunning(sessionId: string): boolean | undefined {
    const status = api.state?.session?.status?.(sessionId);
    return status ? status.type !== "idle" : undefined;
  }

  function getPartTextCache(sessionId: string): Map<string, string | IncrementalCounter> {
    const cache =
      partTextCache.get(sessionId) ?? new Map<string, string | IncrementalCounter>();
    partTextCache.set(sessionId, cache);
    return cache;
  }

  function getSessionState(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (state) {
      return state;
    }
    state = {
      tracker: createTracker({ sessionId, rollingWindowMs: config.rollingWindowMs }),
      firstTokenAt: null,
      lastTokenAt: null,
      lastPublishedAt: 0,
    };
    sessions.set(sessionId, state);
    return state;
  }

  function publish(sessionId: string, active: boolean, now: number = Date.now()): void {
    const state = sessions.get(sessionId);
    if (!state) {
      return;
    }

    const totalTokens = state.tracker.getTotalTokens();
    if (totalTokens === 0) {
      return;
    }

    clearPublishTimer(sessionId);
    state.lastPublishedAt = now;
    const nextSnapshot = {
      sessionId,
      instantTps: state.tracker.getSmoothedTPS(),
      avgTps: state.tracker.getAverageTPS(),
      totalTokens,
      elapsedMs: state.tracker.getElapsedMs(),
      active,
      // `now` may be the server's completion time (persistIdleSnapshot); this must be local.
      lastActivityAt: state.lastTokenAt ?? Date.now(),
      startedAt: sessionSpawnAt.get(sessionId) ?? state.firstTokenAt ?? Date.now(),
    };
    setSnapshots((current) => new Map(current).set(sessionId, nextSnapshot));
  }

  function clearPublishTimer(sessionId: string): void {
    const timer = publishTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      publishTimers.delete(sessionId);
    }
  }

  function scheduleActivePublish(sessionId: string, delayMs: number): void {
    if (publishTimers.has(sessionId)) {
      return;
    }

    const timer = setTimeout(() => {
      publishTimers.delete(sessionId);
      const state = sessions.get(sessionId);
      const now = Date.now();
      if (
        state !== undefined &&
        state.firstTokenAt !== null &&
        now - state.firstTokenAt >= config.initialDisplayDelayMs &&
        now - state.lastPublishedAt >= config.updateIntervalMs &&
        state.tracker.getTotalTokens() > 0 &&
        state.tracker.getSmoothedTPS() >= config.minVisibleTPS
      ) {
        publish(sessionId, true, now);
      }
    }, delayMs);
    publishTimers.set(sessionId, timer);
  }

  function maybePublishActive(sessionId: string, now: number): void {
    const state = sessions.get(sessionId);
    if (!state || state.firstTokenAt === null) {
      return;
    }

    const elapsedSinceFirstToken = now - state.firstTokenAt;
    const elapsedSinceLastPublish = now - state.lastPublishedAt;
    const initialDelayRemaining = config.initialDisplayDelayMs - elapsedSinceFirstToken;
    const throttleDelayRemaining = config.updateIntervalMs - elapsedSinceLastPublish;

    if (
      initialDelayRemaining <= 0 &&
      throttleDelayRemaining <= 0 &&
      state.tracker.getSmoothedTPS() >= config.minVisibleTPS
    ) {
      publish(sessionId, true, now);
      return;
    }

    if (state.tracker.getSmoothedTPS() >= config.minVisibleTPS) {
      scheduleActivePublish(sessionId, Math.max(1, initialDelayRemaining, throttleDelayRemaining));
    }
  }

  function publishFinal(sessionId: string, totalTokens: number, avgTps: number, elapsedMs: number): void {
    if (totalTokens === 0 || elapsedMs < config.initialDisplayDelayMs) {
      return;
    }

    // Local time, not the server's `info.time.completed`: the footer ages this against
    // the local Date.now().
    const now = Date.now();
    const nextSnapshot = {
      sessionId,
      instantTps: 0,
      avgTps,
      totalTokens,
      elapsedMs,
      active: false,
      lastActivityAt: now,
      startedAt: sessionSpawnAt.get(sessionId) ?? now,
    };
    setSnapshots((current) => new Map(current).set(sessionId, nextSnapshot));
  }

  function resetSession(sessionId: string): void {
    clearPublishTimer(sessionId);
    sessions.delete(sessionId);
    partTextCache.delete(sessionId);
    messageRoles.delete(sessionId);
  }

  function clearActiveSnapshot(sessionId: string): void {
    const current = snapshots().get(sessionId);
    if (current?.active) {
      setSnapshots((existing) => {
        const next = new Map(existing);
        next.delete(sessionId);
        return next;
      });
    }
  }

  function persistIdleSnapshot(sessionId: string, now: number = Date.now()): void {
    const state = sessions.get(sessionId);
    if (state?.tracker.getTotalTokens()) {
      if (state.firstTokenAt !== null && now - state.firstTokenAt >= config.initialDisplayDelayMs) {
        publish(sessionId, false, now);
        return;
      }

      const current = snapshots().get(sessionId);
      if (!current?.active) {
        return;
      }

      setSnapshots((existing) => new Map(existing).set(sessionId, { ...current, active: false }));
      return;
    }

    const current = snapshots().get(sessionId);
    if (current?.active) {
      setSnapshots((existing) => new Map(existing).set(sessionId, { ...current, active: false }));
    }
  }

  function countTokenDifference(previousText: string, nextText: string): number {
    return Math.max(0, tokenizer.count(nextText) - tokenizer.count(previousText));
  }

  function rememberDeltaText(sessionId: string, messageId: string, partId: string, delta: string): number {
    const cache = getPartTextCache(sessionId);

    for (const partType of COUNTABLE_PART_TYPES) {
      const key = `${messageId}:${partId}:${partType}`;
      const existing = cache.get(key);
      cache.set(key, `${typeof existing === "string" ? existing : ""}${delta}`);
    }

    const liveKey = `${messageId}:${partId}:live`;
    let counter = cache.get(liveKey);
    if (typeof counter === "string" || counter === undefined) {
      counter = createIncrementalCounter(tokenizerAlgorithm);
      cache.set(liveKey, counter);
    }
    return counter.add(delta);
  }

  function shouldTrackText(sessionId: string, messageId: string, text: string): boolean {
    if (text.length === 0) {
      return false;
    }
    return messageRoles.get(sessionId)?.get(messageId) === "assistant";
  }

  function recordTokenCount(sessionId: string, tokenCount: number): boolean {
    if (tokenCount === 0) {
      return false;
    }

    const now = Date.now();
    const state = getSessionState(sessionId);
    if (state.firstTokenAt === null) {
      state.firstTokenAt = now;
    }
    state.lastTokenAt = now;
    if (!sessionSpawnAt.has(sessionId)) {
      rememberBounded(sessionSpawnAt, sessionId, now);
    }

    state.tracker.recordTokens(tokenCount, now);
    maybePublishActive(sessionId, now);
    return true;
  }

  api.slots.register({
    order: 20,
    slots: {
      session_prompt_right(_ctx, props) {
        return (
          <MeterView
            api={api}
            config={config}
            sessionId={props.session_id}
            snapshots={snapshots}
            familyOf={resolveFamily}
            treeVersion={treeVersion}
            agentOf={(id) => sessionAgents.get(id)}
            isRunning={isRunning}
          />
        );
      },
    },
  });

  disposers.push(api.event.on("session.created", (event) => {
    rememberParent(event.properties.info);
  }));

  disposers.push(api.event.on("session.updated", (event) => {
    rememberParent(event.properties.info);
  }));

  disposers.push(api.event.on("message.updated", (event) => {
    const info = event.properties.info;
    const sessionId = event.properties.sessionID || info.sessionID;
    const roleCache = messageRoles.get(sessionId) ?? new Map<string, Role>();
    messageRoles.set(sessionId, roleCache);
    roleCache.set(info.id, info.role);

    // Subagent sessions announce their agent through message payloads; parts never carry
    // it. User messages name the agent that owns the session, assistant messages carry
    // the same via `agent`/`mode` depending on SDK vintage.
    const agentName = agentNameFromMessage(info);
    if (agentName && !sessionAgents.has(sessionId)) {
      rememberBounded(sessionAgents, sessionId, agentName);
    }

    if (info.role !== "assistant" || !info.time.completed) {
      return;
    }

    if (info.finish === TOOL_CALL_FINISH_REASON) {
      persistIdleSnapshot(sessionId, info.time.completed);
      resetSession(sessionId);
      return;
    }

    if (info.finish && INVALID_FINISH_REASONS.has(info.finish)) {
      resetSession(sessionId);
      clearActiveSnapshot(sessionId);
      return;
    }

    const state = sessions.get(sessionId);
    const reportedTokens = info.tokens.output + info.tokens.reasoning;
    const trackedTokens = state?.tracker.getTotalTokens() ?? 0;
    const totalTokens = reportedTokens > 0 ? reportedTokens : trackedTokens;
    const elapsedMs = state?.firstTokenAt
      ? Math.max(0, info.time.completed - state.firstTokenAt)
      : Math.max(0, info.time.completed - info.time.created);
    const avgTps = elapsedMs > 0 ? totalTokens / (elapsedMs / 1000) : 0;

    publishFinal(sessionId, totalTokens, avgTps, elapsedMs);
    resetSession(sessionId);
  }));

  disposers.push(api.event.on("message.part.delta", (event) => {
    if (event.properties.field !== "text") {
      return;
    }
    if (shouldTrackText(event.properties.sessionID, event.properties.messageID, event.properties.delta)) {
      const tokenCount = rememberDeltaText(
        event.properties.sessionID,
        event.properties.messageID,
        event.properties.partID,
        event.properties.delta
      );
      recordTokenCount(event.properties.sessionID, tokenCount);
    }
  }));

  disposers.push(api.event.on("message.part.updated", (event) => {
    const part = event.properties.part;
    if (!COUNTABLE_PART_TYPES.has(part.type)) {
      return;
    }

    const text = (() => {
      switch (part.type) {
        case "text":
        case "reasoning":
          return part.text;
        default:
          return "";
      }
    })();

    const sessionCache = getPartTextCache(event.properties.sessionID);

    const cacheKey = `${part.messageID}:${part.id}:${part.type}`;
    const cached = sessionCache.get(cacheKey);
    const previousText = typeof cached === "string" ? cached : "";
    if (shouldTrackText(event.properties.sessionID, part.messageID, text)) {
      const tokenCount = text.startsWith(previousText)
        ? countTokenDifference(previousText, text)
        : tokenizer.count(text);
      sessionCache.set(cacheKey, text);
      recordTokenCount(event.properties.sessionID, tokenCount);
    }
  }));

  disposers.push(api.event.on("session.idle", (event) => {
    persistIdleSnapshot(event.properties.sessionID);
    resetSession(event.properties.sessionID);
    // The run is over: a re-dispatch is a new spawn and rejoins the footer at the end.
    sessionSpawnAt.delete(event.properties.sessionID);
  }));

  api.lifecycle.onDispose(() => {
    for (const dispose of disposers) {
      dispose();
    }
    sessions.clear();
    partTextCache.clear();
    messageRoles.clear();
    sessionParents.clear();
    sessionAgents.clear();
    sessionSpawnAt.clear();
    for (const timer of publishTimers.values()) {
      clearTimeout(timer);
    }
    publishTimers.clear();
    setSnapshots(new Map<string, TuiSnapshot>());
  });
};

/**
 * Dual-host TUI entry.
 *
 * v1 reads `tui`; v2 reads `setup`. Both hosts ignore the key they do not know, so one
 * module serves `opencode` and `opencode2`. v2 users can also point at the dedicated
 * `opencode-tps-meter/v2/tui` entry, which carries no v1 baggage.
 */
type DualHostTuiModule = TuiPluginModule & {
  setup: (ctx: V2TuiContext) => V2Cleanup | void;
};

const plugin: DualHostTuiModule = {
  id: "opencode-tps-meter",
  tui,
  setup: setupTuiV2,
};

export default plugin;
