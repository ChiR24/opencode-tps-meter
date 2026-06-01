import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createMemo, createSignal, Show } from "solid-js";
import { createTracker } from "./tracker.js";
import { createTokenizer } from "./tokenCounter.js";
import { defaultConfig, loadConfigSync } from "./config.js";
import { COUNTABLE_PART_TYPES, INVALID_FINISH_REASONS } from "./constants.js";
import type { Config } from "./types.js";

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
}

function loadTuiConfig(): Config {
  try {
    return loadConfigSync();
  } catch {
    return defaultConfig;
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatSnapshot(snapshot: TuiSnapshot, config: Config): string {
  const parts: string[] = [];
  const displayTps = snapshot.active ? snapshot.instantTps : snapshot.avgTps;

  if (config.showInstant) {
    parts.push(`${displayTps.toFixed(1)} TPS`);
  }
  if (config.showAverage) {
    parts.push(`avg ${snapshot.avgTps.toFixed(1)}`);
  }
  if (config.showTotalTokens) {
    parts.push(`${formatNumber(snapshot.totalTokens)} tok`);
  }
  if (config.showElapsed) {
    parts.push(formatElapsedTime(snapshot.elapsedMs));
  }

  return parts.length > 0 ? parts.join(" · ") : "TPS meter";
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
}) {
  const current = createMemo(() => props.snapshots().get(props.sessionId));

  return (
    <Show when={current()} fallback={<box flexShrink={0} />}>
      {(snapshot) => (
        <box flexDirection="row" flexShrink={0}>
          <text fg={colorForSnapshot(props.api.theme.current, props.config, snapshot())}>
            {formatSnapshot(snapshot(), props.config)}
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

  const tokenizer = createTokenizer(
    config.fallbackTokenHeuristic === "words_div_0_75"
      ? "word"
      : config.fallbackTokenHeuristic === "chars_div_3"
        ? "code"
        : "heuristic"
  );
  const [snapshots, setSnapshots] = createSignal(new Map<string, TuiSnapshot>());
  const sessions = new Map<string, SessionState>();
  const partTextCache = new Map<string, Map<string, string>>();
  const messageRoles = new Map<string, Map<string, Role>>();
  const publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const disposers: Array<() => void> = [];

  function getPartTextCache(sessionId: string): Map<string, string> {
    const cache = partTextCache.get(sessionId) ?? new Map<string, string>();
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

    const nextSnapshot = {
      sessionId,
      instantTps: 0,
      avgTps,
      totalTokens,
      elapsedMs,
      active: false,
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
    const liveKey = `${messageId}:${partId}:live`;
    const previousLiveText = cache.get(liveKey) ?? "";
    const nextLiveText = `${previousLiveText}${delta}`;
    cache.set(liveKey, nextLiveText);

    for (const partType of COUNTABLE_PART_TYPES) {
      const key = `${messageId}:${partId}:${partType}`;
      cache.set(key, `${cache.get(key) ?? ""}${delta}`);
    }

    return countTokenDifference(previousLiveText, nextLiveText);
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

    state.tracker.recordTokens(tokenCount, now);
    maybePublishActive(sessionId, now);
    return true;
  }

  api.slots.register({
    order: 20,
    slots: {
      session_prompt_right(_ctx, props) {
        return <MeterView api={api} config={config} sessionId={props.session_id} snapshots={snapshots} />;
      },
    },
  });

  disposers.push(api.event.on("message.updated", (event) => {
    const info = event.properties.info;
    const sessionId = event.properties.sessionID || info.sessionID;
    const roleCache = messageRoles.get(sessionId) ?? new Map<string, Role>();
    messageRoles.set(sessionId, roleCache);
    roleCache.set(info.id, info.role);

    if (info.role !== "assistant" || !info.time.completed) {
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
    const previousText = sessionCache.get(cacheKey) ?? "";
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
    for (const dispose of disposers) {
      dispose();
    }
    sessions.clear();
    partTextCache.clear();
    messageRoles.clear();
    for (const timer of publishTimers.values()) {
      clearTimeout(timer);
    }
    publishTimers.clear();
    setSnapshots(new Map<string, TuiSnapshot>());
  });
};

const plugin: TuiPluginModule = {
  id: "opencode-tps-meter",
  tui,
};

export default plugin;
