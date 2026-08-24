import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createMemo, createSignal, Show } from "solid-js";
import { createTracker } from "./tracker.js";
import { createTokenizer, createIncrementalCounter, type IncrementalCounter } from "./tokenCounter.js";
import { defaultConfig, loadConfigSync } from "./config.js";
import {
  AGGREGATE_TICK_INTERVAL_MS,
  COUNTABLE_PART_TYPES,
  INVALID_FINISH_REASONS,
  TOOL_CALL_FINISH_REASON,
} from "./constants.js";
import { formatMeterText } from "./format.js";
import type { Config } from "./types.js";
import { collectMeterEntries, formatAggregateLine, hasSubagentEntries } from "./v2/family.js";
import { setupTui as setupTuiV2 } from "./v2/tui.js";
import type { V2Cleanup, V2TuiContext } from "./v2/types.js";

type TrackerInstance = ReturnType<typeof createTracker>;
type Role = "assistant" | "user";

interface SessionState {
  tracker: TrackerInstance;
  firstTokenAt: number | null;
  lastPublishedAt: number;
}

interface TuiSnapshot {
  sessionId: string;
  instantTps: number;
  avgTps: number;
  totalTokens: number;
  elapsedMs: number;
  active: boolean;
  /** Local-clock time of the last token, so finished subagents can be aged out of the aggregate. */
  lastActivityAt: number;
  /**
   * Local-clock time of this session's FIRST token, scoped to the whole session rather than
   * the current turn. The footer renders children in this order; per-turn stamps would move
   * a subagent to the end of the line after every tool-call break.
   */
  startedAt: number;
}

function loadTuiConfig(): Config {
  try {
    return loadConfigSync();
  } catch {
    return defaultConfig;
  }
}

/**
 * Extracts an agent display name from whatever the message payload carries.
 *
 * v1 has drifted here across releases: newer SDK builds put a plain `agent` string on
 * messages (and `mode` on assistant messages), while the plugin's structural types model
 * an `AgentIdentity` object plus `agentId`/`agentType` extras. Accept them all.
 */
function agentNameFromMessage(info: unknown): string | undefined {
  if (!info || typeof info !== "object") {
    return undefined;
  }
  const record = info as Record<string, unknown>;
  for (const candidate of [record.agentType, record.mode]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  const agent = record.agent;
  if (typeof agent === "string" && agent.length > 0) {
    return agent;
  }
  if (agent && typeof agent === "object") {
    const identity = agent as Record<string, unknown>;
    for (const candidate of [identity.name, identity.type]) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
  }
  return undefined;
}

function colorForSnapshot(theme: TuiPluginApi["theme"]["current"], config: Config, snapshot: TuiSnapshot) {
  if (!snapshot.active) {
    return theme.textMuted;
  }
  if (!config.enableColorCoding) {
    return theme.text;
  }
  if (snapshot.instantTps < config.slowTpsThreshold) {
    return theme.error;
  }
  if (snapshot.instantTps > config.fastTpsThreshold) {
    return theme.success;
  }
  return theme.warning;
}

function MeterView(props: {
  api: TuiPluginApi;
  config: Config;
  sessionId: string;
  snapshots: () => ReadonlyMap<string, TuiSnapshot>;
  /** Resolves a session's family root and members. Absent/throwing APIs degrade to single-session. */
  familyOf: (sessionId: string) => { rootID: string; memberIDs: readonly string[] };
  agentOf: (sessionId: string) => string | undefined;
  tick?: () => number;
}) {
  const current = createMemo(() => props.snapshots().get(props.sessionId));

  /**
   * The selected session's whole family, filtered to entries worth showing.
   *
   * Mirrors the v2 footer: while anything streams this recomputes on every publish, and
   * the tick signal keeps it alive afterwards so finished subagents age out.
   */
  const entries = createMemo(() => {
    if (!current()) {
      return [];
    }
    const { rootID, memberIDs } = props.familyOf(props.sessionId);
    props.tick?.();
    return collectMeterEntries({
      rootID,
      memberIDs,
      snapshots: props.snapshots(),
      agentOf: props.agentOf,
      now: Date.now(),
    });
  });

  const line = createMemo(() => {
    const snapshot = current();
    if (!snapshot) {
      return "";
    }
    const rows = entries();
    if (hasSubagentEntries(rows)) {
      return formatAggregateLine(rows);
    }
    return formatMeterText(snapshot, props.config);
  });

  return (
    <Show when={current()} fallback={<box flexShrink={0} />}>
      {(snapshot) => (
        <box flexDirection="row" flexShrink={0}>
          <text fg={colorForSnapshot(props.api.theme.current, props.config, snapshot())}>
            {line()}
          </text>
        </box>
      )}
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
   */
  const sessionParents = new Map<string, string | null>();
  const sessionAgents = new Map<string, string>();
  /** Session-scoped first-token time; feeds snapshot `startedAt` for stable child ordering. */
  const sessionSpawnAt = new Map<string, number>();

  /** Heartbeat so finished subagents age out of the aggregate once streams go quiet. */
  const [tick, setTick] = createSignal(0);
  const heartbeat = setInterval(() => setTick((value) => value + 1), AGGREGATE_TICK_INTERVAL_MS);

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
    sessionParents.set(record.id, typeof record.parentID === "string" ? record.parentID : null);
  }

  /** Walks parent links as far as they go; cycles and missing links terminate the walk. */
  function walkToRoot(sessionId: string): string {
    let current = sessionId;
    const seen = new Set<string>([current]);
    for (let depth = 0; depth < 16; depth += 1) {
      const parent = parentOf(current);
      if (!parent || seen.has(parent)) {
        return current;
      }
      seen.add(parent);
      current = parent;
    }
    return current;
  }

  /**
   * Resolves the selected session's family: everyone whose own root chain lands on the
   * same topmost ancestor — including that ancestor itself, so "main" always renders.
   */
  function resolveRoot(sessionId: string): { rootID: string; memberIDs: readonly string[] } {
    const rootID = walkToRoot(sessionId);
    const candidates = new Set<string>([sessionId]);
    for (const id of snapshots().keys()) {
      candidates.add(id);
    }
    const memberIDs: string[] = [];
    for (const id of candidates) {
      if (walkToRoot(id) === rootID) {
        memberIDs.push(id);
      }
    }
    return { rootID, memberIDs };
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
      lastActivityAt: now,
      startedAt: sessionSpawnAt.get(sessionId) ?? state.firstTokenAt ?? now,
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

  function publishFinal(
    sessionId: string,
    totalTokens: number,
    avgTps: number,
    elapsedMs: number,
    at: number = Date.now()
  ): void {
    if (totalTokens === 0 || elapsedMs < config.initialDisplayDelayMs) {
      return;
    }

    const nextSnapshot = {
      sessionId,
      instantTps: 0,
      avgTps,
      totalTokens,
      elapsedMs,
      active: false,
      lastActivityAt: at,
      startedAt: sessionSpawnAt.get(sessionId) ?? at,
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
    if (!sessionSpawnAt.has(sessionId)) {
      sessionSpawnAt.set(sessionId, now);
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
            familyOf={resolveRoot}
            agentOf={(id) => sessionAgents.get(id)}
            tick={tick}
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
      sessionAgents.set(sessionId, agentName);
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

    publishFinal(sessionId, totalTokens, avgTps, elapsedMs, info.time.completed);
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
  }));

  api.lifecycle.onDispose(() => {
    clearInterval(heartbeat);
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
