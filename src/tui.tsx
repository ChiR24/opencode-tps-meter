import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createMemo, createSignal, Show } from "solid-js";
import { createTracker } from "./tracker.js";
import { createTokenizer } from "./tokenCounter.js";
import { defaultConfig, loadConfigSync } from "./config.js";
import { COUNTABLE_PART_TYPES, INVALID_FINISH_REASONS, MIN_TPS_ELAPSED_MS } from "./constants.js";
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

  function publishFinal(sessionId: string, totalTokens: number, avgTps: number, elapsedMs: number): void {
    if (totalTokens === 0 || elapsedMs < MIN_TPS_ELAPSED_MS) {
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

  function rememberDeltaText(sessionId: string, messageId: string, partId: string, delta: string): void {
    const cache = getPartTextCache(sessionId);
    for (const partType of COUNTABLE_PART_TYPES) {
      const key = `${messageId}:${partId}:${partType}`;
      cache.set(key, `${cache.get(key) ?? ""}${delta}`);
    }
  }

  function shouldTrackDelta(sessionId: string, messageId: string, delta: string): boolean {
    if (delta.length === 0) {
      return false;
    }
    return messageRoles.get(sessionId)?.get(messageId) === "assistant";
  }

  function recordDelta(sessionId: string, messageId: string, delta: string): boolean {
    if (!shouldTrackDelta(sessionId, messageId, delta)) {
      return false;
    }
    const now = Date.now();
    const state = getSessionState(sessionId);
    if (state.firstTokenAt === null) {
      state.firstTokenAt = now;
    }

    const tokenCount = tokenizer.count(delta);
    if (tokenCount === 0) {
      return false;
    }

    state.tracker.recordTokens(tokenCount, now);
    if (
      now - state.firstTokenAt >= MIN_TPS_ELAPSED_MS &&
      now - state.lastPublishedAt >= config.updateIntervalMs &&
      state.tracker.getSmoothedTPS() >= config.minVisibleTPS
    ) {
      publish(sessionId, true, now);
    }
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
    if (shouldTrackDelta(event.properties.sessionID, event.properties.messageID, event.properties.delta)) {
      rememberDeltaText(
        event.properties.sessionID,
        event.properties.messageID,
        event.properties.partID,
        event.properties.delta
      );
      recordDelta(event.properties.sessionID, event.properties.messageID, event.properties.delta);
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
    const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text;
    if (shouldTrackDelta(event.properties.sessionID, part.messageID, delta)) {
      recordDelta(event.properties.sessionID, part.messageID, delta);
      sessionCache.set(cacheKey, text);
    }
  }));

  disposers.push(api.event.on("session.idle", (event) => {
    resetSession(event.properties.sessionID);
    clearActiveSnapshot(event.properties.sessionID);
  }));

  api.lifecycle.onDispose(() => {
    for (const dispose of disposers) {
      dispose();
    }
    sessions.clear();
    partTextCache.clear();
    messageRoles.clear();
    setSnapshots(new Map<string, TuiSnapshot>());
  });
};

const plugin: TuiPluginModule = {
  id: "opencode-tps-meter",
  tui,
};

export default plugin;
