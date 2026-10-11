/**
 * Token throughput tracking, shared by v1 and v2.
 *
 * Every recorded chunk carries the interval it was GENERATED in, not just the moment it
 * arrived. Hosts batch output before publishing it (v2 flushes text every ~100ms), so a
 * chunk's tokens were produced between the previous chunk and this one. Dividing a chunk by
 * anything shorter is what produced readings like 10,000 TPS.
 *
 * The opening chunk of a stream is the special case: it was generated over an interval the
 * meter never saw (from request start, through any prefill, to its arrival). It counts toward
 * the token total but never toward a rate.
 *
 * All maths uses the timestamps the caller records with, so one tracker never mixes clocks:
 * v2 passes host event times, v1 passes local time.
 */

import type { TPSTrackerOptions, BufferEntry, TPSTracker } from "./types.js";
import {
  MAX_BUFFER_SIZE,
  DEFAULT_ROLLING_WINDOW_MS,
  MIN_RATE_SPAN_MS,
  MIN_PROVIDER_RATIO,
  MAX_PROVIDER_RATIO,
} from "./constants.js";

/**
 * A settled step's average, corrected by the provider's exact token count.
 *
 * The streamed average divides heuristic tokens by the time they streamed over, so both
 * sides describe the same output. When the provider's count of that same output
 * (`providerVisible`: output, plus reasoning only if reasoning actually streamed) is close
 * to the heuristic's, it replaces the heuristic's estimate. When it is far off, the two are
 * not counting the same thing, and the streamed figure stands.
 */
export function correctedAverage(
  streamedAvg: number,
  streamedTokens: number,
  providerVisible: number
): number {
  if (!(streamedAvg > 0) || !(streamedTokens > 0) || !(providerVisible > 0)) {
    return streamedAvg > 0 ? streamedAvg : 0;
  }
  const ratio = providerVisible / streamedTokens;
  return ratio >= MIN_PROVIDER_RATIO && ratio <= MAX_PROVIDER_RATIO
    ? streamedAvg * ratio
    : streamedAvg;
}

export function createTracker(options: TPSTrackerOptions = {}): TPSTracker {
  const sessionId: string | undefined = options.sessionId;
  const windowMs =
    typeof options.rollingWindowMs === "number" && options.rollingWindowMs > 0
      ? options.rollingWindowMs
      : DEFAULT_ROLLING_WINDOW_MS;

  /** Rated chunks still relevant to the rolling window, oldest first. */
  let entries: BufferEntry[] = [];
  /** Every token recorded, including the unrated opening chunk. */
  let totalTokens = 0;
  /** Tokens with a known generation interval: the numerator of every rate. */
  let ratedTokens = 0;
  /** Start of the measurable generation window, or null before the first chunk. */
  let origin: number | null = null;
  /** Arrival time of the latest chunk. */
  let lastAt: number | null = null;

  function prune(): void {
    if (lastAt === null) {
      return;
    }
    const cutoff = lastAt - windowMs;
    let drop = 0;
    while (drop < entries.length && entries[drop].at <= cutoff) {
      drop++;
    }
    if (drop > 0) {
      entries.splice(0, drop);
    }
    // Merge rather than drop when the cap is hit: dropping would silently undercount the
    // window, while merging two adjacent chunks only coarsens where its edge falls.
    while (entries.length > MAX_BUFFER_SIZE) {
      const [a, b] = entries;
      entries.splice(0, 2, { from: Math.min(a.from, b.from), at: b.at, count: a.count + b.count });
    }
  }

  /** Tokens per second over the window ending at `now`, or null while unmeasurable. */
  function rateAt(now: number): number | null {
    if (origin === null) {
      return null;
    }
    const start = Math.max(now - windowMs, origin);
    const spanMs = now - start;
    if (spanMs < MIN_RATE_SPAN_MS) {
      return null;
    }
    let tokens = 0;
    for (const entry of entries) {
      if (entry.at <= start || entry.from >= now) {
        continue;
      }
      // Count only the part of the chunk's generation interval inside the window.
      const length = entry.at - entry.from;
      const overlap = Math.min(entry.at, now) - Math.max(entry.from, start);
      tokens += length > 0 ? (entry.count * overlap) / length : entry.count;
    }
    return tokens / (spanMs / 1000);
  }

  return {
    recordTokens(count: number, timestamp?: number): void {
      if (!(count > 0)) {
        return;
      }
      // Never let a late-stamped event run the clock backwards.
      const at = Math.max(timestamp ?? Date.now(), lastAt ?? -Infinity);
      totalTokens += count;

      // Opening chunk, or one delivered in the same instant (v1 stamps a whole batch with one
      // local time): generated over an interval we never saw. Total only.
      if (lastAt === null || (ratedTokens === 0 && at === lastAt)) {
        origin = at;
        lastAt = at;
        return;
      }

      entries.push({ from: lastAt, at, count });
      lastAt = at;
      ratedTokens += count;
      prune();
    },

    getInstantTPS(now?: number): number {
      return lastAt === null ? 0 : (rateAt(now ?? lastAt) ?? 0);
    },

    getSmoothedTPS(): number {
      return lastAt === null ? 0 : (rateAt(lastAt) ?? 0);
    },

    getAverageTPS(): number {
      if (origin === null || lastAt === null) {
        return 0;
      }
      const spanMs = lastAt - origin;
      return spanMs >= MIN_RATE_SPAN_MS ? ratedTokens / (spanMs / 1000) : 0;
    },

    isRateReady(): boolean {
      return lastAt !== null && rateAt(lastAt) !== null;
    },

    getTotalTokens(): number {
      return totalTokens;
    },

    getElapsedMs(): number {
      return origin === null || lastAt === null ? 0 : lastAt - origin;
    },

    getSessionId(): string | undefined {
      return sessionId;
    },

    reset(): void {
      entries = [];
      totalTokens = 0;
      ratedTokens = 0;
      origin = null;
      lastAt = null;
    },

    getBufferSize(): number {
      return entries.length;
    },

    getMaxBufferSize(): number {
      return MAX_BUFFER_SIZE;
    },

    getWindowMs(): number {
      return windowMs;
    },
  };
}
