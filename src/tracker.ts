/**
 * Token tracking logic for OpenCode TPS Meter Plugin
 * Implements a TPS tracker with a configurable rolling window using a ring buffer
 */

import type { TPSTrackerOptions, BufferEntry, TPSTracker } from "./types.js";
import { MAX_BUFFER_SIZE, DEFAULT_ROLLING_WINDOW_MS, MIN_WINDOW_DURATION_SECONDS } from "./constants.js";

/**
 * Creates a TPSTracker instance - Tracks tokens per second with a rolling window
 *
 * Uses a ring buffer to efficiently track token counts over time.
 * Maximum buffer size of 100 entries with automatic pruning of entries
 * older than the configured window duration.
 *
 * @param options - Optional configuration including sessionId
 * @returns TPSTracker instance with methods to track and calculate TPS
 */
export function createTracker(options: TPSTrackerOptions = {}): TPSTracker {
  // Private state
  let startTime: number = Date.now();
  let totalTokens: number = 0;
  let buffer: Array<BufferEntry> = [];
  const sessionId: string | undefined = options.sessionId;
  const windowMs =
    typeof options.rollingWindowMs === "number" && options.rollingWindowMs > 0
      ? options.rollingWindowMs
      : DEFAULT_ROLLING_WINDOW_MS;

  /**
   * Prunes entries older than the rolling window and enforces max buffer size
   * @param now - Current timestamp for age calculations
   */
  function pruneBuffer(now: number): void {
    const cutoff = now - windowMs;

    // Find first valid entry index (first entry not older than cutoff)
    let validStartIndex = 0;
    while (validStartIndex < buffer.length && buffer[validStartIndex].timestamp < cutoff) {
      validStartIndex++;
    }

    // Batch remove all expired entries at once with slice (O(n) total, not O(n²))
    if (validStartIndex > 0) {
      buffer = buffer.slice(validStartIndex);
    }

    // Trim to max size from the end if needed
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer = buffer.slice(-MAX_BUFFER_SIZE);
    }
  }

  // Return the public interface
  return {
    /**
     * Records a token count at the specified time (or now if not specified)
     * @param count - Number of tokens to record
     * @param timestamp - Optional timestamp (defaults to current time)
     */
    recordTokens(count: number, timestamp?: number): void {
      const ts = timestamp ?? Date.now();

      // Update total tokens
      totalTokens += count;

      // Add entry to buffer
      buffer.push({ timestamp: ts, count });

      // Prune old entries and maintain buffer size
      pruneBuffer(ts);
    },

    /**
     * Calculates the instantaneous TPS over the configured rolling window
     * @returns Tokens per second over the rolling window, or 0 if no data
     */
    getInstantTPS(): number {
      if (buffer.length === 0) {
        return 0;
      }

      const now = Date.now();
      const cutoff = now - windowMs;

      // Calculate total tokens in the window
      let tokensInWindow = 0;
      let oldestTimestamp = now;
      let newestTimestamp = 0;

      for (const entry of buffer) {
        if (entry.timestamp >= cutoff) {
          tokensInWindow += entry.count;
          if (entry.timestamp < oldestTimestamp) {
            oldestTimestamp = entry.timestamp;
          }
          if (entry.timestamp > newestTimestamp) {
            newestTimestamp = entry.timestamp;
          }
        }
      }

      // If no valid entries in window, return 0
      if (tokensInWindow === 0) {
        return 0;
      }

      // Calculate actual window duration in seconds
      const windowDurationMs = newestTimestamp - oldestTimestamp;
      const windowDurationSeconds = windowDurationMs / 1000;

      // If window is too short (single entry or < 100ms), use minimum duration
      const effectiveDuration = Math.max(windowDurationSeconds, MIN_WINDOW_DURATION_SECONDS);

      return tokensInWindow / effectiveDuration;
    },

    /**
     * Calculates the average TPS over the entire session
     * @returns Average tokens per second since tracking began, or 0 if no time elapsed
     */
    getAverageTPS(): number {
      const elapsedSeconds = (Date.now() - startTime) / 1000;

      // Handle edge case: no time elapsed
      if (elapsedSeconds === 0) {
        return 0;
      }

      return totalTokens / elapsedSeconds;
    },

    /**
     * Gets the total number of tokens recorded
     * @returns Total tokens counted
     */
    getTotalTokens(): number {
      return totalTokens;
    },

    /**
     * Gets the elapsed time since tracking began
     * @returns Elapsed time in milliseconds
     */
    getElapsedMs(): number {
      return Date.now() - startTime;
    },

    /**
     * Gets the optional session ID
     * @returns Session identifier or undefined
     */
    getSessionId(): string | undefined {
      return sessionId;
    },

    /**
     * Resets all tracking data
     * Clears buffer, total tokens, and resets start time
     */
    reset(): void {
      startTime = Date.now();
      totalTokens = 0;
      buffer = [];
      // Note: sessionId is preserved across resets
    },

    /**
     * Gets the current number of entries in the buffer
     * @returns Buffer entry count
     */
    getBufferSize(): number {
      return buffer.length;
    },

    /**
     * Gets the maximum buffer size
     * @returns Maximum number of entries the buffer can hold
     */
    getMaxBufferSize(): number {
      return MAX_BUFFER_SIZE;
    },

    /**
     * Gets the rolling window duration in milliseconds
     * @returns Window duration in milliseconds
     */
    getWindowMs(): number {
      return windowMs;
    }
  };
}
