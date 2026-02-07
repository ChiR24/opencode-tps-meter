/**
 * Type definitions for OpenCode TPS Meter Plugin
 *
 * @module types
 */

/**
 * Configuration options for the TPS Meter plugin
 * Controls behavior, display, and performance characteristics
 *
 * @interface Config
 */
export interface Config {
  /** Whether the plugin is enabled (default: true) */
  enabled: boolean;

  /** Display update interval in milliseconds (default: 50) */
  updateIntervalMs: number;

  /** Rolling window duration for TPS calculation in milliseconds (default: 1000) */
  rollingWindowMs: number;

  /** Whether to show average TPS (default: true) */
  showAverage: boolean;

  /** Whether to show instantaneous TPS (default: true) */
  showInstant: boolean;

  /** Whether to show total token count (default: true) */
  showTotalTokens: boolean;

  /** Whether to show elapsed time (default: false) */
  showElapsed: boolean;

  /** Display format style (default: 'compact') */
  format: 'compact' | 'verbose' | 'minimal';

  /** Minimum TPS value to display (default: 0) */
  minVisibleTPS: number;

  /** Fallback token counting heuristic when tokenizer unavailable (default: 'chars_div_4') */
  fallbackTokenHeuristic: 'chars_div_4' | 'chars_div_3' | 'words_div_0_75';

  /** Enable TPS-based color coding for visual feedback (default: false) */
  enableColorCoding: boolean;

  /** TPS threshold for "slow" (red) - below this is slow (default: 10) */
  slowTpsThreshold: number;

  /** TPS threshold for "fast" (green) - above this is fast (default: 50) */
  fastTpsThreshold: number;
}

/**
 * Plugin context provided by OpenCode framework
 * Contains client and other framework-provided utilities
 *
 * @interface PluginContext
 */
export interface PluginContext {
  /** OpenCode client for TUI, toast, and other interactions */
  client: OpenCodeClient;

  /** Plugin metadata and utilities */
  plugin: {
    /** Unique plugin identifier */
    id: string;
    /** Plugin name */
    name: string;
    /** Plugin version */
    version: string;
  };

  /** Logger instance */
  logger: Logger;
}

/**
 * OpenCode client interface for TUI and toast interactions
 *
 * @interface OpenCodeClient
 */
export interface OpenCodeClient {
  /** TUI (Terminal User Interface) methods */
  tui?: {
    /** Set status bar message (if supported) */
    setStatus?: (message: string) => void;
    /** Show a toast notification */
    showToast?: (options: {
      body?: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      };
      query?: {
        directory?: string;
      };
    }) => Promise<unknown> | void;
    /** Publish a TUI event */
    publish?: (options: {
      body?: {
        type:
          | "tui.toast.show"
          | "tui.prompt.append"
          | "tui.command.execute"
          | "tui.status.set"
          | "tui.status.clear";
        properties: {
          title?: string;
          message?: string;
          variant?: "info" | "success" | "warning" | "error" | "default";
          duration?: number;
          text?: string;
          command?: string;
          pluginId?: string;
          rightText?: string;
          priority?: number;
        };
      };
      query?: {
        directory?: string;
      };
    }) => Promise<unknown> | void;
  };

  /** Toast notification methods */
  toast?: {
    /** Show info toast */
    info: (message: string, options?: { duration?: number }) => void;
    /** Show success toast */
    success: (message: string, options?: { duration?: number }) => void;
  };
}

/**
 * Tool state structures for tool parts
 */
export interface ToolStateBase {
  status: string;
  input?: Record<string, unknown>;
  raw?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: {
    start: number;
    end?: number;
  };
  output?: string;
  error?: string;
}

export interface ToolStateCompleted extends ToolStateBase {
  status: "completed";
  output: string;
}

export interface ToolStateError extends ToolStateBase {
  status: "error";
  error: string;
}

export type ToolState = ToolStateBase | ToolStateCompleted | ToolStateError;

export interface FilePartSourceText {
  value: string;
  start: number;
  end: number;
}

export interface FilePartSource {
  type: "file" | "symbol" | "resource";
  text?: FilePartSourceText;
  path?: string;
  name?: string;
  uri?: string;
}

/**
 * Agent identity metadata for primary and sub-agents
 */
export interface AgentIdentity {
  id?: string;
  type?: string;
  name?: string;
  description?: string;
}

export interface Part {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  prompt?: string;
  description?: string;
  command?: string;
  source?: FilePartSource;
  filename?: string;
  url?: string;
  state?: ToolState;
  snapshot?: string;
  reason?: string;
  files?: Array<string>;
  name?: string;
  error?: unknown;
  auto?: boolean;
  metadata?: Record<string, unknown>;
  agent?: AgentIdentity;
  agentId?: string;
  agentType?: string;
}

/**
 * Logger interface for plugin logging
 *
 * @interface Logger
 */
export interface Logger {
  /** Log debug message */
  debug: (message: string, ...args: unknown[]) => void;
  /** Log info message */
  info: (message: string, ...args: unknown[]) => void;
  /** Log warning message */
  warn: (message: string, ...args: unknown[]) => void;
  /** Log error message */
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * Event data structure for message events
 *
 * @interface MessageEvent
 */
export interface MessageEvent {
  /** Event type identifier */
  type: "message.part.updated" | "message.updated" | "session.idle";

  /** Event payload */
  properties: {
    part?: Part;
    delta?: string;
    info?: {
      id: string;
      sessionID: string;
      role: "user" | "assistant" | "system";
      time?: { created: number; completed?: number };
      tokens?: {
        input: number;
        output: number;
        reasoning?: number;
        cache?: {
          read: number;
          write: number;
        };
      };
      finish?: string;
      error?: unknown;
      agent?: AgentIdentity;
      metadata?: Record<string, unknown>;
      agentId?: string;
      agentType?: string;
    };
    sessionID?: string;
  };
}

/**
 * Plugin event handler return type
 *
 * @interface PluginHandlers
 */
export interface PluginHandlers {
  /** Event handler for plugin events */
  event: (args: { event: MessageEvent }) => Promise<void> | void;
}

/**
 * Token counting interface
 *
 * @interface TokenCounter
 */
export interface TokenCounter {
  /** Count tokens in the given text */
  count(text: string): number;
}

/**
 * Display state for UI updates
 *
 * @interface DisplayState
 */
export interface DisplayState {
  /** Instantaneous TPS value */
  instantTps: number;
  /** Average TPS value */
  avgTps: number;
  /** Total token count */
  totalTokens: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Optional per-agent display entries */
  agents?: AgentDisplayState[];
}

/**
 * Display data for an individual agent/subagent stream
 */
export interface AgentDisplayState {
  /** Unique identifier (message ID or agent ID) */
  id: string;
  /** Label describing the agent/subagent */
  label: string;
  /** Instantaneous TPS value */
  instantTps: number;
  /** Average TPS value */
  avgTps: number;
  /** Total tokens processed */
  totalTokens: number;
  /** Elapsed time since first token */
  elapsedMs: number;
}

/**
 * TPS Tracker options
 *
 * @interface TPSTrackerOptions
 */
export interface TPSTrackerOptions {
  /** Optional session identifier */
  sessionId?: string;
  /** Optional rolling window duration in milliseconds */
  rollingWindowMs?: number;
}

/**
 * Buffer entry for TPS tracking
 *
 * @interface BufferEntry
 */
export interface BufferEntry {
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Token count at this timestamp */
  count: number;
}

/**
 * TPSTracker interface for tracking tokens per second
 *
 * @interface TPSTracker
 */
export interface TPSTracker {
  /** Records a token count at the specified time */
  recordTokens(count: number, timestamp?: number): void;
  /** Calculates the instantaneous TPS over the last 2-second rolling window */
  getInstantTPS(): number;
  /** Gets the EWMA-smoothed TPS to prevent spikes from bursts */
  getSmoothedTPS(): number;
  /** Calculates the average TPS over the entire session */
  getAverageTPS(): number;
  /** Gets the total number of tokens recorded */
  getTotalTokens(): number;
  /** Gets the elapsed time since tracking began */
  getElapsedMs(): number;
  /** Gets the optional session ID */
  getSessionId(): string | undefined;
  /** Resets all tracking data */
  reset(): void;
  /** Gets the current number of entries in the buffer */
  getBufferSize(): number;
  /** Gets the maximum buffer size */
  getMaxBufferSize(): number;
  /** Gets the rolling window duration in milliseconds */
  getWindowMs(): number;
}

/**
 * UIManager interface for managing TPS display
 *
 * @interface UIManager
 */
export interface UIManager {
  /** Updates the display with current TPS statistics */
  updateDisplay(
    instantTps: number,
    avgTps: number,
    totalTokens: number,
    elapsedMs: number,
    agents?: AgentDisplayState[]
  ): void;
  /** Displays final statistics immediately */
  showFinalStats(totalTokens: number, avgTps: number, elapsedMs: number): void;
  /** Clears the display and cleans up resources */
  clear(): void;
  /** Changes the update interval for display throttling */
  setUpdateInterval(ms: number): void;
}
