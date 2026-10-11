/**
 * Shared meter text formatting.
 *
 * Used by both the v1 and v2 TUI entry points so the two hosts render identical text.
 *
 * @module format
 */

import type { Config } from "./types.js";

/** Minimum shape needed to render a meter reading, satisfied by v1 and v2 snapshots alike. */
export interface MeterReading {
  instantTps: number;
  avgTps: number;
  totalTokens: number;
  elapsedMs: number;
  /** True while tokens are actively streaming. */
  active: boolean;
  /** Prompt tokens served from the cache (provider-reported). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the cache (provider-reported). */
  cacheWriteTokens?: number;
  /** Uncached prompt input tokens (provider-reported). */
  inputTokens?: number;
  /** Cached prompt tokens summed over the whole session (provider-reported). */
  sessionCacheReadTokens?: number;
  /** Prompt tokens written to the cache over the whole session (provider-reported). */
  sessionCacheWriteTokens?: number;
  /** Uncached prompt input tokens over the whole session (provider-reported). */
  sessionInputTokens?: number;
}

/**
 * Prompt cache hit rate in the range 0..1, or null when no prompt accounting is known.
 *
 * OpenCode's `tokens.input` excludes cache reads and writes (verified against the session
 * store: `total === input + output + reasoning + cache.read + cache.write`), so the whole
 * prompt side is `input + read + write` and the hit rate is the cached share of it.
 */
export function cacheHitRatio(
  reading: Pick<MeterReading, "cacheReadTokens" | "cacheWriteTokens" | "inputTokens">
): number | null {
  const read = reading.cacheReadTokens ?? 0;
  const write = reading.cacheWriteTokens ?? 0;
  const input = reading.inputTokens ?? 0;
  const promptTokens = read + write + input;
  if (promptTokens <= 0) {
    return null;
  }
  return read / promptTokens;
}

/** Formats a 0..1 ratio as a whole-percent string, e.g. "91%". */
export function formatCacheHit(reading: MeterReading): string | null {
  const ratio = cacheHitRatio(reading);
  return ratio === null ? null : `${Math.round(ratio * 100)}%`;
}

/**
 * Session-wide cache hit rate, aggregated over every reported step.
 *
 * Unlike `formatCacheHit` (which reflects only the latest step), this survives across
 * steps, so it stays on screen while the next step streams and answers "how much of all
 * prompt tokens this session were cache reads".
 */
export function formatSessionCacheHit(reading: MeterReading): string | null {
  const ratio = cacheHitRatio({
    cacheReadTokens: reading.sessionCacheReadTokens,
    cacheWriteTokens: reading.sessionCacheWriteTokens,
    inputTokens: reading.sessionInputTokens,
  });
  return ratio === null ? null : `${Math.round(ratio * 100)}%`;
}

/** Formats a token count with thousands separators. */
export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** Formats milliseconds as MM:SS. */
export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Renders the meter line.
 *
 * While streaming, the leading figure is the rolling instantaneous rate; once the turn
 * settles it becomes the average, so a frozen meter reads as a summary rather than a
 * stale live value.
 */
export function formatMeterText(reading: MeterReading, config: Config): string {
  const parts: string[] = [];
  const displayTps = reading.active ? reading.instantTps : reading.avgTps;

  if (config.showInstant) {
    parts.push(`${displayTps.toFixed(1)} TPS`);
  }
  if (config.showAverage) {
    parts.push(`avg ${reading.avgTps.toFixed(1)}`);
  }
  if (config.showTotalTokens) {
    parts.push(`${formatNumber(reading.totalTokens)} tok`);
  }
  if (config.showElapsed) {
    parts.push(formatElapsedTime(reading.elapsedMs));
  }
  if (config.showCacheHit) {
    const cache = formatCacheHit(reading);
    if (cache !== null) {
      parts.push(`cache ${cache}`);
    }
    const sessionCache = formatSessionCacheHit(reading);
    if (sessionCache !== null) {
      parts.push(`session cache ${sessionCache}`);
    }
  }

  return parts.length > 0 ? parts.join(" · ") : "TPS meter";
}
