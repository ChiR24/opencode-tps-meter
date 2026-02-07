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

/** Minimum elapsed time (ms) before displaying TPS to avoid initial spikes */
export const MIN_TPS_ELAPSED_MS = 250;

/** Default rolling window duration for TPS calculation (ms) */
export const DEFAULT_ROLLING_WINDOW_MS = 1000;

/** Maximum number of entries in the ring buffer */
export const MAX_BUFFER_SIZE = 100;

/** Minimum window duration for TPS calculation (seconds) to avoid division by near-zero */
export const MIN_WINDOW_DURATION_SECONDS = 0.1;

/** Token count threshold to trigger burst smoothing (tokens) */
export const BURST_TOKEN_THRESHOLD = 50;

/** Default EWMA half-life (ms) for smoothing normal streaming */
export const DEFAULT_EWMA_HALF_LIFE_MS = 500;

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

/** Minimum interval between toast updates (ms) - prevents UI flooding */
export const MIN_TOAST_INTERVAL_MS = 150;

/** Default toast display duration in milliseconds */
export const DEFAULT_TOAST_DURATION_MS = 20000;

/** Duration for final stats toast in milliseconds */
export const FINAL_STATS_DURATION_MS = 2000;

// =============================================================================
// Memory Management Constants
// =============================================================================

/** Maximum age of message entries before cleanup (5 minutes in ms) */
export const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

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

/** Set of finish reasons that invalidate TPS statistics */
export const INVALID_FINISH_REASONS = new Set(["tool-calls", "unknown"]);

/** Set of part types that contribute to token counting */
export const COUNTABLE_PART_TYPES = new Set(["text", "reasoning"]);
