/**
 * Constants for OpenCode TPS Meter Plugin
 *
 * Centralized configuration constants to avoid magic numbers
 * scattered throughout the codebase.
 *
 * @module constants
 */

// =============================================================================
// TPS Calculation Constants
// =============================================================================

/** Default startup stabilization delay (ms) before displaying live TPS */
export const DEFAULT_INITIAL_DISPLAY_DELAY_MS = 10;

/** Default rolling window duration for TPS calculation (ms) */
export const DEFAULT_ROLLING_WINDOW_MS = 1000;

/**
 * Maximum chunks kept for the rolling window. Past this the oldest two are merged, so a
 * very chatty stream coarsens the window edge instead of dropping tokens from it.
 */
export const MAX_BUFFER_SIZE = 256;

/**
 * Shortest generation span (ms) a rate is computed over.
 *
 * Below this, one chunk more or less swings the figure wildly, so the meter reports nothing
 * rather than a guess. Kept well under v2's ~100ms output flush so the first live reading
 * appears with the second chunk.
 */
export const MIN_RATE_SPAN_MS = 50;

/**
 * Accepted range for provider tokens / streamed tokens on one step.
 *
 * Inside it, the provider's exact count corrects the heuristic's estimate of the step's
 * rate. Outside it the two are not counting the same output (hidden reasoning, content the
 * host never streamed), so scaling by the ratio would invent throughput.
 */
export const MIN_PROVIDER_RATIO = 0.5;
export const MAX_PROVIDER_RATIO = 2;

// =============================================================================
// UI Display Constants
// =============================================================================

/** Default UI update interval in milliseconds */
export const DEFAULT_UPDATE_INTERVAL_MS = 50;

/**
 * Display throttle for the v2 TUI meter (ms).
 *
 * The host flushes events in ~10ms batches, so this is the point past which publishing more
 * often cannot reveal anything new. Updating a slot's text is far cheaper than the v1 toast
 * path, which is why v1 keeps a larger default.
 */
export const V2_UPDATE_INTERVAL_MS = 8;

/**
 * Heartbeat for the footer's multi-session aggregate (ms), on both hosts.
 *
 * Finished subagents must disappear after a few seconds, but once every stream is quiet
 * nothing republishes — and a memo that depends on nothing changing never re-runs. This
 * slow tick re-evaluates the footer's recency filter. It runs only while the aggregate
 * line is on screen: the single-session meter does not depend on time.
 */
export const AGGREGATE_TICK_INTERVAL_MS = 500;

/**
 * How long a live stream may go quiet (ms) before its reading is republished with the rate
 * as of now, and how often that repeats until output resumes or the rate reaches zero.
 *
 * A reading only changes when output arrives, so without this a stalled stream (rate limit,
 * a slow provider) kept showing its last speed. Comfortably above v2's ~100ms output flush,
 * so a healthy stream never triggers it.
 */
export const STALL_REPUBLISH_MS = 250;

/** Minimum interval between toast updates (ms) - prevents UI flooding */
export const MIN_TOAST_INTERVAL_MS = 80;

/** Default toast display duration in milliseconds */
export const DEFAULT_TOAST_DURATION_MS = 20000;

/** Duration for final stats toast in milliseconds */
export const FINAL_STATS_DURATION_MS = 2000;

// =============================================================================
// Memory Management Constants
// =============================================================================

/** Maximum age of message entries before cleanup (5 minutes in ms) */
export const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

/**
 * Maximum frozen readings retained after their session state has been swept.
 *
 * A swept session keeps its last reading so the meter does not blank out — v1 kept readings
 * indefinitely, and erasing one reads as the meter "forgetting". The reading is a handful of
 * numbers, so retaining many is cheap; this only bounds pathological session churn.
 */
export const MAX_RETAINED_SNAPSHOTS = 64;

/**
 * Maximum sessions the v1 TUI remembers parent links, agent names and spawn times for.
 *
 * session.created/session.updated arrive for every session in the project, not just the
 * metered ones, so these caches would otherwise grow for the life of the TUI. Evicting a
 * parent link is harmless while `api.state.session` still serves it.
 */
export const MAX_REMEMBERED_SESSIONS = 256;

/** Interval between stale message cleanup runs (30 seconds in ms) */
export const CLEANUP_INTERVAL_MS = 30000;

// =============================================================================
// Token Counting Constants
// =============================================================================

/** Character divisor for general heuristic token counting (chars / 4) */
export const CHARS_DIV_4 = 4;

/** Character divisor for code-optimized token counting (chars / 3) */
export const CHARS_DIV_3 = 3;

/** Word divisor for prose-optimized token counting (words / 0.75) */
export const WORDS_DIV_0_75 = 0.75;

// =============================================================================
// TPS Threshold Constants
// =============================================================================

/** Default TPS threshold for "slow" (red) indicator */
export const DEFAULT_SLOW_TPS_THRESHOLD = 10;

/** Default TPS threshold for "fast" (green) indicator */
export const DEFAULT_FAST_TPS_THRESHOLD = 50;

// =============================================================================
// Finish Reasons to Exclude from Stats
// =============================================================================

export const TOOL_CALL_FINISH_REASON = "tool-calls";

/** Set of finish reasons that invalidate TPS statistics */
export const INVALID_FINISH_REASONS = new Set([TOOL_CALL_FINISH_REASON, "unknown"]);

/** Set of part types that contribute to token counting */
export const COUNTABLE_PART_TYPES = new Set(["text", "reasoning"]);
