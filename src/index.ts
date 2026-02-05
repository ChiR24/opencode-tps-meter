/**
 * OpenCode TPS Meter Plugin
 *
 * A live tokens-per-second meter for tracking AI token throughput in OpenCode.
 *
 * @module opencode-tps-meter
 */

import type {
  PluginContext,
  PluginHandlers,
  MessageEvent,
  Config,
  Part,
  ToolState,
} from "./types.js";
import { createTracker } from "./tracker.js";
import { createUIManager } from "./ui.js";
import { createTokenizer } from "./tokenCounter.js";
import { loadConfigSync, defaultConfig } from "./config.js";
import {
  MIN_TPS_ELAPSED_MS,
  INVALID_FINISH_REASONS,
  COUNTABLE_PART_TYPES,
  MAX_MESSAGE_AGE_MS,
  CLEANUP_INTERVAL_MS,
} from "./constants.js";

/**
 * Helper function to safely stringify any value
 */
function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Extracts text content from tool state
 */
function extractToolStateText(state?: ToolState): string {
  if (!state) {
    return "";
  }
  const parts: string[] = [];
  if (typeof state.raw === "string") {
    parts.push(state.raw);
  }
  if (typeof state.output === "string") {
    parts.push(state.output);
  }
  if (typeof state.error === "string") {
    parts.push(state.error);
  }
  if (state.input && typeof state.input === "object") {
    parts.push(stringifyValue(state.input));
  }
  if (typeof state.title === "string") {
    parts.push(state.title);
  }
  return parts.filter((value) => value.length > 0).join("\n");
}

/**
 * Extracts text content from a message part
 */
function extractPartText(part: Part): string {
  // Validate part structure
  if (!part || typeof part !== "object") {
    return "";
  }

  // Validate part type exists and is a string
  if (!part.type || typeof part.type !== "string") {
    return stringifyValue(part);
  }

  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text ?? "";
    case "subtask":
      return [part.prompt, part.description, part.command]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n");
    case "tool":
      return extractToolStateText(part.state);
    case "file":
      return [
        part.source?.text?.value,
        part.filename,
        part.url,
        part.source?.path,
        part.source?.name,
        part.source?.uri,
      ]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n");
    case "snapshot":
    case "step-start":
      return part.snapshot ?? "";
    case "step-finish":
      return [part.reason, part.snapshot]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n");
    case "patch":
      return Array.isArray(part.files) ? part.files.join("\n") : "";
    case "agent":
      return [part.name, part.source?.text?.value]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n");
    case "retry":
      return stringifyValue(part.error);
    case "compaction":
      return part.auto ? "compaction:auto" : "compaction";
    default:
      return stringifyValue(part);
  }
}

/**
 * Main plugin function that initializes the TPS meter
 *
 * @param {PluginContext} context - Plugin context from OpenCode framework
 * @returns {PluginHandlers | Record<string, never>} - Event handlers or empty object if disabled
 */
export default function TpsMeterPlugin(
  context: PluginContext
): PluginHandlers | Record<string, never> {
  // Create safe logger fallback - handle missing context entirely
  // CRITICAL: Use no-op functions instead of console.* to prevent TUI log leak during resize
  // The SDK spawns TUI with stdio: "inherit" which causes console output to bypass
  // the TUI's managed output and corrupt the screen during redraw operations
  const safeContext = context || {};
  const logger = safeContext.logger || {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  // Load configuration from all sources (synchronous)
  let config: Config;
  try {
    config = loadConfigSync();
  } catch (error) {
    logger.warn('[TpsMeter] Failed to load config, using defaults:', error instanceof Error ? error.message : String(error));
    config = defaultConfig;
  }

  // If disabled, return empty handlers
  if (!config.enabled) {
    logger.debug("[TpsMeter] Plugin disabled by configuration");
    return {};
  }

  // Initialize tracking components
  const trackers = new Map<string, ReturnType<typeof createTracker>>();
  const partTextCache = new Map<string, Map<string, string>>();
  const messageTokenCache = new Map<string, Map<string, number>>();
  const messageRoleCache = new Map<
    string,
    Map<string, "user" | "assistant" | "system">
  >();
  const messageFirstTokenCache = new Map<string, Map<string, number>>();
  const activeMessageCache = new Map<string, string>();
  
  // Config is guaranteed to be defined (either from loadConfigSync or defaultConfig in catch)
  const resolvedConfig: Config = config;
  
  const ui = createUIManager(safeContext.client || {}, resolvedConfig);
  const tokenizer = createTokenizer(
    resolvedConfig.fallbackTokenHeuristic === "words_div_0_75"
      ? "word"
      : resolvedConfig.fallbackTokenHeuristic === "chars_div_3"
        ? "code"
        : "heuristic"
  );

  logger.info("[TpsMeter] Plugin initialized and ready");

  /**
   * Gets or creates a tracker for the given session ID
   * @param {string} sessionId - Session identifier
   * @returns {TPSTracker} - Tracker instance for the session
   */
  function getOrCreateTracker(sessionId: string): ReturnType<typeof createTracker> {
    let tracker = trackers.get(sessionId);
    if (!tracker) {
      tracker = createTracker({
        sessionId,
        rollingWindowMs: resolvedConfig.rollingWindowMs,
      });
      trackers.set(sessionId, tracker);
      logger.debug(
        `[TpsMeter] Created tracker for session: ${sessionId}`
      );
    }
    return tracker;
  }

  /**
   * Cleans up all trackers and UI resources
   * Called when session goes idle
   */
  function cleanup(): void {
    logger.debug("[TpsMeter] Cleaning up all trackers and UI");

    // Clear all trackers
    trackers.clear();
    messageRoleCache.clear();
    messageFirstTokenCache.clear();
    activeMessageCache.clear();

    // Clear UI
    ui.clear();
  }

  /**
   * Handles message.part.updated events (streaming token chunks)
   * @param {MessageEvent} event - The event data
   */
  function handleMessagePartUpdated(event: MessageEvent): void {
    const part = event.properties.part;
    let delta = event.properties.delta;

    if (!part) {
      return;
    }

    if (!COUNTABLE_PART_TYPES.has(part.type)) {
      return;
    }

    const sessionId = part.sessionID || "default";
    const partText = extractPartText(part);
    if (!delta && partText.length > 0) {
      const sessionCache = partTextCache.get(sessionId) || new Map<string, string>();
      partTextCache.set(sessionId, sessionCache);
      const cacheKey = `${part.messageID}:${part.id}:${part.type}`;
      const previousText = sessionCache.get(cacheKey) || "";
      if (partText.startsWith(previousText)) {
        delta = partText.slice(previousText.length);
      } else {
        delta = partText;
      }
      sessionCache.set(cacheKey, partText);
    }

    if (!delta || delta.length === 0) {
      return;
    }

    const roleCache = messageRoleCache.get(sessionId);
    const role = roleCache?.get(part.messageID);
    if (role !== "assistant") {
      return;
    }

    const tracker = getOrCreateTracker(sessionId);
    const messageId = part.messageID;
    const activeMessageId = activeMessageCache.get(sessionId);
    if (activeMessageId !== messageId) {
      tracker.reset();
      activeMessageCache.set(sessionId, messageId);
    }
    const now = Date.now();

    // Periodically clean up stale message entries to prevent memory leaks
    cleanupStaleMessages(now);

    const firstTokenCache = messageFirstTokenCache.get(sessionId) || new Map<string, number>();
    messageFirstTokenCache.set(sessionId, firstTokenCache);
    let firstTokenAt = firstTokenCache.get(messageId);
    if (firstTokenAt === undefined) {
      firstTokenAt = now;
      firstTokenCache.set(messageId, firstTokenAt);
    }

    // Count tokens in the delta
    const tokenCount = tokenizer.count(delta);

    // Record the tokens
    tracker.recordTokens(tokenCount, now);

    const messageCache = messageTokenCache.get(sessionId) || new Map<string, number>();
    messageTokenCache.set(sessionId, messageCache);
    const previousTokens = messageCache.get(messageId) ?? 0;
    messageCache.set(messageId, previousTokens + tokenCount);

    // Get current stats
    const instantTps = tracker.getInstantTPS();
    const avgTps = tracker.getAverageTPS();
    const totalTokens = tracker.getTotalTokens();
    const elapsedMs = tracker.getElapsedMs();
    const elapsedSinceFirstToken = Math.max(0, now - firstTokenAt);

    // Update UI (throttled internally)
    if (
      elapsedSinceFirstToken >= MIN_TPS_ELAPSED_MS &&
      instantTps >= resolvedConfig.minVisibleTPS
    ) {
      ui.updateDisplay(instantTps, avgTps, totalTokens, elapsedMs);
    }

    logger.debug(
      `[TpsMeter] Session ${sessionId}: +${tokenCount} tokens, TPS: ${instantTps.toFixed(1)} (avg: ${avgTps.toFixed(1)})`
    );
  }

  /**
   * Handles message.updated events (message status changes)
   * @param {MessageEvent} event - The event data
   */
  function handleMessageUpdated(event: MessageEvent): void {
    const info = event.properties.info;
    if (!info) {
      return;
    }

    const roleCache = messageRoleCache.get(info.sessionID) || new Map();
    messageRoleCache.set(info.sessionID, roleCache);
    roleCache.set(info.id, info.role);

    if (info.role === "assistant") {
      const sessionId = info.sessionID;
      const tracker = trackers.get(sessionId);
      const sessionCache = partTextCache.get(sessionId);
      const tokenCache = messageTokenCache.get(sessionId) || new Map<string, number>();
      messageTokenCache.set(sessionId, tokenCache);
      const firstTokenCache = messageFirstTokenCache.get(sessionId) || new Map<string, number>();
      messageFirstTokenCache.set(sessionId, firstTokenCache);
      const outputTokens = info.tokens?.output ?? 0;
      const reasoningTokens = info.tokens?.reasoning ?? 0;
      const reportedTokens = outputTokens + reasoningTokens;
      const messageId = info.id;

      const previous = tokenCache.get(messageId) ?? 0;
      const nextTokens = Math.max(previous, reportedTokens);
      tokenCache.set(messageId, nextTokens);

      if (info.time?.completed && tracker) {
        const completedAt = info.time?.completed ?? Date.now();
        const createdAt = info.time?.created ?? completedAt;
        const firstTokenAt = firstTokenCache.get(messageId) ?? createdAt;
        const elapsedMs = Math.max(0, completedAt - firstTokenAt);
        const cachedTokens = tokenCache.get(messageId) ?? 0;
        const totalTokens = reportedTokens > 0 ? reportedTokens : cachedTokens;
        const avgTps = elapsedMs > 0 ? totalTokens / (elapsedMs / 1000) : 0;
        const hasValidFinish =
          info.finish !== undefined &&
          info.finish !== null &&
          !INVALID_FINISH_REASONS.has(info.finish);
        const shouldShowFinalStats =
          hasValidFinish &&
          totalTokens > 0 &&
          elapsedMs >= MIN_TPS_ELAPSED_MS;

        if (shouldShowFinalStats) {
          // Display final stats
          ui.showFinalStats(totalTokens, avgTps, elapsedMs);

          logger.info(
            `[TpsMeter] Session ${sessionId} complete: ${totalTokens} tokens in ${(elapsedMs / 1000).toFixed(1)}s (avg ${avgTps.toFixed(1)} TPS)`
          );
        }
      }

      if (sessionCache) {
        for (const key of sessionCache.keys()) {
          if (key.startsWith(`${info.id}:`)) {
            sessionCache.delete(key);
          }
        }
      }
      if (info.time?.completed) {
        tokenCache.delete(messageId);
        roleCache.delete(messageId);
        firstTokenCache.delete(messageId);
      }
    }

    // Handle error status
    if (info.error) {
      logger.warn(
        `[TpsMeter] Message error for session: ${info.sessionID}`
      );
    }
  }

  /**
   * Handles session.idle events (session cleanup)
   * @param {MessageEvent} event - The event data
   */
  function handleSessionIdle(event: MessageEvent): void {
    const sessionId = event.properties.sessionID || "default";
    logger.debug(`[TpsMeter] Session idle: ${sessionId}`);

    // Remove tracker for this specific session
    trackers.delete(sessionId);
    partTextCache.delete(sessionId);
    messageTokenCache.delete(sessionId);
    messageRoleCache.delete(sessionId);
    messageFirstTokenCache.delete(sessionId);
    activeMessageCache.delete(sessionId);

    // If no more active sessions, clean up UI
    if (trackers.size === 0) {
      cleanup();
    }
  }

  /**
   * Cleans up stale message entries to prevent memory leaks
   * Messages that never complete (crash, cancel, disconnect) would otherwise leak forever
   * @param {number} now - Current timestamp
   */
  let lastCleanupTime = 0;

  function cleanupStaleMessages(now: number): void {
    // Only run cleanup periodically to avoid performance impact
    if (now - lastCleanupTime < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastCleanupTime = now;

    let cleanedCount = 0;
    for (const [sessionId, firstTokenCache] of messageFirstTokenCache) {
      const tokenCache = messageTokenCache.get(sessionId);
      const roleCache = messageRoleCache.get(sessionId);

      for (const [messageId, firstTokenAt] of firstTokenCache) {
        if (now - firstTokenAt > MAX_MESSAGE_AGE_MS) {
          // Clean up stale message entries
          firstTokenCache.delete(messageId);
          tokenCache?.delete(messageId);
          roleCache?.delete(messageId);
          cleanedCount++;
        }
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`[TpsMeter] Cleaned up ${cleanedCount} stale message entries`);
    }
  }

  // Return plugin event handlers
  return {
    event: async ({ event }: { event: MessageEvent }): Promise<void> => {
      try {
        switch (event.type) {
          case "message.part.updated":
            handleMessagePartUpdated(event);
            break;

          case "message.updated":
            handleMessageUpdated(event);
            break;

          case "session.idle":
            handleSessionIdle(event);
            break;

          default:
            // Unknown event type, ignore
            break;
        }
      } catch (error) {
        logger.error(
          "[TpsMeter] Error handling event:",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  };
}

// Export types only - no helper functions to avoid OpenCode trying to load them as plugins
export type {
  BufferEntry,
  TPSTrackerOptions,
  TPSTracker,
  UIManager,
  TokenCounter,
  Config,
  OpenCodeClient,
  DisplayState,
  PluginContext,
  Logger,
  MessageEvent,
  PluginHandlers,
} from "./types.js";
