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
  AgentIdentity,
  AgentDisplayState,
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
  let config: Config | undefined;
  try {
    config = loadConfigSync();
  } catch (error) {
    logger.warn('[TpsMeter] Failed to load config, using defaults:', error instanceof Error ? error.message : String(error));
    config = defaultConfig;
  }

  // Ensure config is defined (handle edge case where loadConfigSync returns undefined)
  if (!config) {
    logger.warn('[TpsMeter] Config is undefined, using defaults');
    config = defaultConfig;
  }

  // If disabled, return empty handlers
  if (!config.enabled) {
    logger.debug("[TpsMeter] Plugin disabled by configuration");
    return {};
  }

  // Initialize tracking components
  type TrackerInstance = ReturnType<typeof createTracker>;

  interface TrackerMetadata {
    agent?: AgentIdentity;
    agentId?: string;
    agentType?: string;
    name?: string;
  }

  interface MessageTrackerState {
    /** Composite key for this tracker (sessionId:messageId:partId or similar) */
    key: string;
    /** The message ID this tracker is associated with */
    messageId: string;
    /** Optional part ID for sub-part tracking */
    partId?: string;
    tracker: TrackerInstance;
    label: string;
    firstTokenAt: number | null;
    lastUpdated: number;
    agent?: AgentIdentity;
    agentId?: string;
    agentType?: string;
  }

  interface SessionTrackingState {
    aggregate: TrackerInstance;
    aggregateFirstTokenAt: number | null;
    messageTrackers: Map<string, MessageTrackerState>;
  }

  const sessionTrackers = new Map<string, SessionTrackingState>();
  const partTextCache = new Map<string, Map<string, string>>();
  const messageTokenCache = new Map<string, Map<string, number>>();
  const messageRoleCache = new Map<
    string,
    Map<string, "user" | "assistant" | "system">
  >();
  
  // Cache agent names per session (from message.updated events)
  // Key: sessionId, Value: agent name (e.g., "explore", "librarian", "build")
  const sessionAgentNameCache = new Map<string, string>();
  
  // Track the PRIMARY session ID explicitly
  // Primary = the FIRST session that receives assistant tokens (main chat)
  // Background agents run in DIFFERENT sessions, so they won't overwrite this
  let primarySessionId: string | null = null;
  
  // Timer-based fallback to show TPS even when stream pauses
  // Maps sessionId -> timer handle
  const pendingDisplayTimers = new Map<string, ReturnType<typeof setTimeout>>();
  
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
  function getOrCreateSessionState(sessionId: string): SessionTrackingState {
    let state = sessionTrackers.get(sessionId);
    if (!state) {
      state = {
        aggregate: createTracker({
          sessionId,
          rollingWindowMs: resolvedConfig.rollingWindowMs,
        }),
        aggregateFirstTokenAt: null,
        messageTrackers: new Map<string, MessageTrackerState>(),
      };
      sessionTrackers.set(sessionId, state);
      logger.debug(`[TpsMeter] Created tracker for session: ${sessionId}`);
    }
    return state;
  }

  function abbreviateId(id: string): string {
    if (!id || id.length <= 4) return id;
    return `${id.slice(0, 4)}…`;
  }

  function buildAgentLabel(
    messageId: string,
    metadata?: TrackerMetadata
  ): string {
    const typeLabel =
      metadata?.agent?.type?.trim() ||
      metadata?.agentType?.trim() ||
      metadata?.agent?.name?.trim() ||
      metadata?.name?.trim() ||
      "Subagent";
    const rawId =
      metadata?.agentId?.trim() ||
      metadata?.agent?.id?.trim() ||
      messageId;
    const identifier = abbreviateId(rawId);
    return `${typeLabel}(${identifier})`;
  }

  /**
   * Builds a composite tracker key from session, message, part, and metadata.
   * Prefers agentId → metadata.agent.id → metadata.agentType → partId → `${sessionId}:${messageId}`
   */
  function buildTrackerKey(
    sessionId: string,
    messageId: string,
    partId?: string,
    metadata?: TrackerMetadata
  ): string {
    const agentId =
      metadata?.agentId?.trim() ||
      metadata?.agent?.id?.trim() ||
      metadata?.agentType?.trim();
    if (agentId) {
      return `${sessionId}:${messageId}:${agentId}`;
    }
    if (partId) {
      return `${sessionId}:${messageId}:${partId}`;
    }
    return `${sessionId}:${messageId}`;
  }

  function getOrCreateMessageTrackerState(
    sessionId: string,
    messageId: string,
    partId?: string,
    metadata?: TrackerMetadata
  ): MessageTrackerState {
    const sessionState = getOrCreateSessionState(sessionId);
    const key = buildTrackerKey(sessionId, messageId, partId, metadata);
    let trackerState = sessionState.messageTrackers.get(key);
    const nextLabel = buildAgentLabel(messageId, metadata);
    if (!trackerState) {
      trackerState = {
        key,
        messageId,
        partId,
        tracker: createTracker({
          sessionId: key,
          rollingWindowMs: resolvedConfig.rollingWindowMs,
        }),
        label: nextLabel,
        firstTokenAt: null,
        lastUpdated: 0,
        agent: metadata?.agent,
        agentId: metadata?.agentId,
        agentType: metadata?.agentType,
      };
      sessionState.messageTrackers.set(key, trackerState);
    } else if (trackerState.label !== nextLabel) {
      trackerState.label = nextLabel;
    }

    if (metadata?.agent) {
      trackerState.agent = metadata.agent;
    }
    if (metadata?.agentId) {
      trackerState.agentId = metadata.agentId;
    }
    if (metadata?.agentType) {
      trackerState.agentType = metadata.agentType;
    }

    return trackerState;
  }

  /**
   * Gets ALL active background agents across ALL sessions.
   * Includes both:
   * - Same-session agents (detected via agent metadata)
   * - Cross-session agents (different sessionId than primary)
   * Uses cached agent names from message.updated events.
   */
  function getAllActiveAgentsGlobally(now: number): AgentDisplayState[] {
    const activityWindow = Math.max(
      resolvedConfig.rollingWindowMs,
      MIN_TPS_ELAPSED_MS * 4
    );
    const entries: AgentDisplayState[] = [];

    for (const [sessionId, sessionState] of sessionTrackers) {
      for (const [trackerKey, trackerState] of sessionState.messageTrackers) {
        if (!trackerState.firstTokenAt) continue;
        if (now - trackerState.lastUpdated > activityWindow) continue;
        
        const hasAgentMetadata = Boolean(
          trackerState.agent || trackerState.agentId || trackerState.agentType
        );
        
        let isSubagent = false;
        let label = trackerState.label;
        
        if (hasAgentMetadata) {
          // Has agent metadata - definitely a subagent (same-session)
          isSubagent = true;
        } else if (sessionId !== primarySessionId) {
          // Different session than primary - treat as subagent (cross-session)
          isSubagent = true;
          // Get cached agent name for this session
          const agentName = sessionAgentNameCache.get(sessionId) || "bg";
          const shortId = abbreviateId(sessionId.replace(/^ses_/, ""));
          label = `${agentName}(${shortId})`;
        }
        
        if (!isSubagent) continue;
        
        entries.push({
          id: trackerKey,
          label,
          instantTps: trackerState.tracker.getSmoothedTPS(),
          avgTps: trackerState.tracker.getAverageTPS(),
          totalTokens: trackerState.tracker.getTotalTokens(),
          elapsedMs: now - trackerState.firstTokenAt,
        });
      }
    }

    entries.sort((a, b) => b.instantTps - a.instantTps);
    return entries;
  }
  
  /**
   * Checks if the primary session is currently active.
   * Only considers trackers WITHOUT agent metadata as primary activity.
   */
  function isPrimarySessionActive(now: number): boolean {
    if (!primarySessionId) return false;
    
    const sessionState = sessionTrackers.get(primarySessionId);
    if (!sessionState) return false;
    
    const activityWindow = Math.max(
      resolvedConfig.rollingWindowMs,
      MIN_TPS_ELAPSED_MS * 4
    );
    
    for (const trackerState of sessionState.messageTrackers.values()) {
      // Only consider NON-agent trackers as primary activity
      const hasAgentMetadata = Boolean(
        trackerState.agent || trackerState.agentId || trackerState.agentType
      );
      if (hasAgentMetadata) continue;
      
      if (trackerState.firstTokenAt && now - trackerState.lastUpdated <= activityWindow) {
        return true;
      }
    }
    return false;
  }

  function getActiveAgentDisplayStates(
    sessionState: SessionTrackingState,
    now: number
  ): AgentDisplayState[] {
    const activityWindow = Math.max(
      resolvedConfig.rollingWindowMs,
      MIN_TPS_ELAPSED_MS * 4
    );
    const entries: AgentDisplayState[] = [];

    for (const trackerState of sessionState.messageTrackers.values()) {
      if (!trackerState.firstTokenAt) {
        continue;
      }
      if (now - trackerState.lastUpdated > activityWindow) {
        continue;
      }
      // Only show subagents/background agents that have agent metadata
      const hasAgentMetadata = Boolean(trackerState.agent || trackerState.agentId || trackerState.agentType);
      if (!hasAgentMetadata) {
        continue;
      }
      entries.push({
        id: trackerState.messageId,
        label: trackerState.label,
        instantTps: trackerState.tracker.getSmoothedTPS(),
        avgTps: trackerState.tracker.getAverageTPS(),
        totalTokens: trackerState.tracker.getTotalTokens(),
        elapsedMs: now - trackerState.firstTokenAt,
      });
    }

    entries.sort((a, b) => b.instantTps - a.instantTps);
    return entries;
  }

  function removeMessageTrackerState(
    sessionId: string,
    messageId: string
  ): void {
    const sessionState = sessionTrackers.get(sessionId);
    if (!sessionState) {
      return;
    }
    // Remove all tracker states that share the same messageId
    // (since multiple keys may map to the same message)
    for (const [key, state] of sessionState.messageTrackers) {
      if (state.messageId === messageId) {
        sessionState.messageTrackers.delete(key);
      }
    }
    if (sessionState.messageTrackers.size === 0) {
      sessionState.aggregate.reset();
      sessionState.aggregateFirstTokenAt = null;
    }
  }

  /**
   * Schedules a timer to show TPS display after MIN_TPS_ELAPSED_MS
   * This ensures the TPS is shown even if the stream pauses or ends
   * before another part arrives.
   */
  function scheduleDisplayTimer(sessionId: string): void {
    // Clear any existing timer for this session
    const existingTimer = pendingDisplayTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // Schedule new timer
    const timer = setTimeout(() => {
      pendingDisplayTimers.delete(sessionId);
      
      const sessionState = sessionTrackers.get(sessionId);
      if (!sessionState || !sessionState.aggregateFirstTokenAt) {
        return;
      }
      
      const now = Date.now();
      const elapsedSinceFirstToken = now - sessionState.aggregateFirstTokenAt;
      
      // Only show if enough time has passed
      if (elapsedSinceFirstToken < MIN_TPS_ELAPSED_MS) return;
      
      // Get all agents and check primary activity
      const allAgents = getAllActiveAgentsGlobally(now);
      const hasPrimaryActivity = isPrimarySessionActive(now);
      
      if (hasPrimaryActivity) {
        const smoothedTps = sessionState.aggregate.getSmoothedTPS();
        const avgTps = sessionState.aggregate.getAverageTPS();
        const totalTokens = sessionState.aggregate.getTotalTokens();
        const elapsedMs = sessionState.aggregate.getElapsedMs();
        
        if (smoothedTps >= resolvedConfig.minVisibleTPS) {
          ui.updateDisplay(smoothedTps, avgTps, totalTokens, elapsedMs, allAgents);
        }
      } else if (allAgents.length > 0) {
        ui.updateDisplay(0, 0, 0, 0, allAgents);
      }
      
      logger.debug(`[TpsMeter] Timer-triggered display for session ${sessionId}`);
    }, MIN_TPS_ELAPSED_MS + 10);
    
    pendingDisplayTimers.set(sessionId, timer);
  }
  
  /**
   * Clears the pending display timer for a session
   */
  function clearDisplayTimer(sessionId: string): void {
    const timer = pendingDisplayTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      pendingDisplayTimers.delete(sessionId);
    }
  }

  /**
   * Cleans up all trackers and UI resources
   * Called when session goes idle
   */
  function cleanup(): void {
    logger.debug("[TpsMeter] Cleaning up all trackers and UI");

    // Clear all pending display timers
    for (const timer of pendingDisplayTimers.values()) {
      clearTimeout(timer);
    }
    pendingDisplayTimers.clear();

    sessionTrackers.clear();
    partTextCache.clear();
    messageTokenCache.clear();
    messageRoleCache.clear();
    sessionAgentNameCache.clear();
    primarySessionId = null;

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
      const sessionCache =
        partTextCache.get(sessionId) || new Map<string, string>();
      partTextCache.set(sessionId, sessionCache);
      const cacheKey = `${part.messageID}:${part.id}:${part.type}`;
      const previousText = sessionCache.get(cacheKey) || "";
      delta = partText.startsWith(previousText)
        ? partText.slice(previousText.length)
        : partText;
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

    const sessionState = getOrCreateSessionState(sessionId);
    const messageTracker = getOrCreateMessageTrackerState(
      sessionId,
      part.messageID,
      part.id,
      {
        agent: part.agent,
        agentId: part.agentId,
        agentType: part.agentType,
        name: part.name,
      }
    );

    const now = Date.now();
    cleanupStaleMessages(now);

    if (!sessionState.aggregateFirstTokenAt) {
      sessionState.aggregateFirstTokenAt = now;
      // Schedule timer-based fallback display in case stream pauses
      scheduleDisplayTimer(sessionId);
    }
    if (!messageTracker.firstTokenAt) {
      messageTracker.firstTokenAt = now;
      
      // Set as primary session if this is a non-agent tracker and primary not set
      const hasAgentMetadata = Boolean(
        messageTracker.agent || messageTracker.agentId || messageTracker.agentType
      );
      if (!hasAgentMetadata && primarySessionId === null) {
        primarySessionId = sessionId;
        logger.debug(`[TpsMeter] Primary session set to: ${sessionId}`);
      }
      
      const metaLabel = messageTracker.label;
      const metaInfo = messageTracker.agent || messageTracker.agentId || messageTracker.agentType
        ? `agent=${messageTracker.agent?.type ?? messageTracker.agentType ?? "?"} id=${messageTracker.agent?.id ?? messageTracker.agentId ?? "?"}`
        : "agent=none";
      logger.info(`[TpsMeter][Debug] tracker initialized ${metaLabel} (${metaInfo}) session=${sessionId} message=${part.messageID} part=${part.id ?? "?"}`);
    }
    messageTracker.lastUpdated = now;

    const tokenCount = tokenizer.count(delta);

    sessionState.aggregate.recordTokens(tokenCount, now);
    messageTracker.tracker.recordTokens(tokenCount, now);

    const messageCache =
      messageTokenCache.get(sessionId) || new Map<string, number>();
    messageTokenCache.set(sessionId, messageCache);
    const previousTokens = messageCache.get(part.messageID) ?? 0;
    messageCache.set(part.messageID, previousTokens + tokenCount);

    const smoothedTps = sessionState.aggregate.getSmoothedTPS();
    const avgTps = sessionState.aggregate.getAverageTPS();
    const totalTokens = sessionState.aggregate.getTotalTokens();
    const elapsedMs = sessionState.aggregate.getElapsedMs();
    const elapsedSinceFirstToken =
      sessionState.aggregateFirstTokenAt === null
        ? 0
        : Math.max(0, now - sessionState.aggregateFirstTokenAt);

    if (
      elapsedSinceFirstToken >= MIN_TPS_ELAPSED_MS
    ) {
      // Clear the timer-based fallback since we're showing naturally
      clearDisplayTimer(sessionId);
      
      // Get ALL background agents across ALL sessions
      const allAgents = getAllActiveAgentsGlobally(now);
      
      // Determine if we should show the main TPS line
      const hasPrimaryActivity = isPrimarySessionActive(now) && smoothedTps >= resolvedConfig.minVisibleTPS;
      
      if (hasPrimaryActivity) {
        // Primary is active - show main TPS + agents
        ui.updateDisplay(smoothedTps, avgTps, totalTokens, elapsedMs, allAgents);
      } else if (allAgents.length > 0) {
        // Only agents active (no primary) - show ONLY agent rows, no main line
        ui.updateDisplay(0, 0, 0, 0, allAgents);
      }
    }

    logger.debug(
      `[TpsMeter] Session ${sessionId}: +${tokenCount} tokens, TPS: ${smoothedTps.toFixed(
        1
      )} (avg: ${avgTps.toFixed(1)})`
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

    // Cache agent name for this session (for labeling background agents)
    // info.agent contains the agent name like "explore", "librarian", "build", etc.
    if (info.agent && typeof info.agent === "string") {
      sessionAgentNameCache.set(info.sessionID, info.agent);
    }

    if (info.role === "assistant") {
      const sessionId = info.sessionID;
      const sessionCache = partTextCache.get(sessionId);
      const tokenCache = messageTokenCache.get(sessionId) || new Map<string, number>();
      messageTokenCache.set(sessionId, tokenCache);
      const outputTokens = info.tokens?.output ?? 0;
      const reasoningTokens = info.tokens?.reasoning ?? 0;
      const reportedTokens = outputTokens + reasoningTokens;
      const messageId = info.id;

      const messageTracker = getOrCreateMessageTrackerState(sessionId, messageId, undefined, {
        agent: info.agent,
        agentId: info.agentId,
        agentType: info.agentType,
      });

      const previous = tokenCache.get(messageId) ?? 0;
      const nextTokens = Math.max(previous, reportedTokens);
      tokenCache.set(messageId, nextTokens);

      if (info.time?.completed) {
        const completedAt = info.time?.completed ?? Date.now();
        const createdAt = info.time?.created ?? completedAt;
        const firstTokenAt = messageTracker.firstTokenAt ?? createdAt;
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
        removeMessageTrackerState(sessionId, messageId);
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

    // Clear any pending display timer
    clearDisplayTimer(sessionId);

    // Remove tracker for this specific session
    sessionTrackers.delete(sessionId);
    partTextCache.delete(sessionId);
    messageTokenCache.delete(sessionId);
    messageRoleCache.delete(sessionId);
    sessionAgentNameCache.delete(sessionId);

    // If no more active sessions, clean up UI
    if (sessionTrackers.size === 0) {
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
    for (const [sessionId, sessionState] of sessionTrackers) {
      const tokenCache = messageTokenCache.get(sessionId);
      const roleCache = messageRoleCache.get(sessionId);
      const sessionCache = partTextCache.get(sessionId);

      // Collect keys to delete first to avoid mutation during iteration
      const keysToDelete: string[] = [];
      for (const [key, messageTracker] of sessionState.messageTrackers) {
        if (
          messageTracker.lastUpdated > 0 &&
          now - messageTracker.lastUpdated > MAX_MESSAGE_AGE_MS
        ) {
          keysToDelete.push(key);
        }
      }

      // Now delete by key
      for (const key of keysToDelete) {
        const messageTracker = sessionState.messageTrackers.get(key);
        if (messageTracker) {
          sessionState.messageTrackers.delete(key);
          const messageId = messageTracker.messageId;
          tokenCache?.delete(messageId);
          roleCache?.delete(messageId);
          if (sessionCache) {
            for (const cacheKey of sessionCache.keys()) {
              if (cacheKey.startsWith(`${messageId}:`)) {
                sessionCache.delete(cacheKey);
              }
            }
          }
          cleanedCount++;
        }
      }

      // Reset aggregate if map is empty after cleanup
      if (sessionState.messageTrackers.size === 0) {
        sessionState.aggregate.reset();
        sessionState.aggregateFirstTokenAt = null;
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
  AgentDisplayState,
  AgentIdentity,
  PluginContext,
  Logger,
  MessageEvent,
  PluginHandlers,
} from "./types.js";
