import { createTracker } from "../src/tracker.js";
import { DEFAULT_EWMA_HALF_LIFE_MS, V2_EWMA_HALF_LIFE_MS } from "../src/constants.js";

/** Time for the smoothed reading to reach 90% of a steady target rate. */
function convergeMs(halfLife: number, targetTps: number): number {
  const t = createTracker({ rollingWindowMs: 1000, ewmaHalfLifeMs: halfLife });
  const base = 1_000_000;
  const stepMs = 10;
  const perStep = (targetTps * stepMs) / 1000;
  for (let i = 1; i <= 600; i++) {
    t.recordTokens(perStep, base + i * stepMs);
    if (t.getSmoothedTPS() >= targetTps * 0.9) return i * stepMs;
  }
  return -1;
}

console.log("time for the displayed rate to reach 90% of a 90 TPS stream:");
for (const [label, hl] of [
  ["v1 default", DEFAULT_EWMA_HALF_LIFE_MS],
  ["v2 default", V2_EWMA_HALF_LIFE_MS],
] as const) {
  const ms = convergeMs(hl, 90);
  console.log(`  ${label.padEnd(12)} half-life ${String(hl).padStart(4)}ms -> ${String(ms).padStart(4)}ms`);
}
