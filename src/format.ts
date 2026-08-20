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

  return parts.length > 0 ? parts.join(" · ") : "TPS meter";
}
