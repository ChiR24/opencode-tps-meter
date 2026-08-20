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

/** Maximum number of entries in the ring buffer */
export const MAX_BUFFER_SIZE = 100;

/** Minimum window duration for TPS calculation (seconds) to avoid division by near-zero */
export const MIN_WINDOW_DURATION_SECONDS = 0.3;

/** Token count threshold to trigger burst smoothing (tokens) */
export const BURST_TOKEN_THRESHOLD = 50;

/** Default EWMA half-life (ms) for smoothing normal streaming */
export const DEFAULT_EWMA_HALF_LIFE_MS = 250;

/**
 * EWMA half-life (ms) for normal streaming on v2.
 *
 * Lower than the v1 default: v2 timestamps tokens with the host clock rather than the
 * event-flush clock, so the rolling window is already an accurate average and the extra
 * exponential lag mostly just delays the reading.
 */
export const V2_EWMA_HALF_LIFE_MS = 120;

/** EWMA half-life (ms) applied during medium bursts (50-200 tokens) */
export const BURST_EWMA_HALF_LIFE_MS = 3000;

/** Token count threshold for very large bursts (tool outputs) */
export const LARGE_BURST_THRESHOLD = 200;

/** EWMA half-life (ms) for very large bursts */
export const LARGE_BURST_EWMA_HALF_LIFE_MS = 5000;

/** Maximum initial TPS value to prevent startup spikes */
export const MAX_INITIAL_TPS = 100;

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
