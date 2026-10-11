import { createTracker } from "../src/tracker.js";

/**
 * Time until the live reading is within 10% of a steady true rate, with output delivered the
 * way v2 hosts flush it: one chunk per 100ms. Also reports the worst reading seen on the way,
 * which is where the old tracker spiked (the opening chunk divided by a few milliseconds).
 */
function settle(targetTps: number, flushMs = 100): { ms: number; worst: number } {
  const t = createTracker({ rollingWindowMs: 1000 });
  const base = 1_000_000;
  const perFlush = (targetTps * flushMs) / 1000;
  let worst = 0;
  for (let i = 0; i <= 100; i++) {
    t.recordTokens(perFlush, base + i * flushMs);
    const live = t.getSmoothedTPS();
    worst = Math.max(worst, live);
    if (t.isRateReady() && Math.abs(live - targetTps) <= targetTps * 0.1) {
      return { ms: i * flushMs, worst };
    }
  }
  return { ms: -1, worst };
}

console.log("live reading vs a steady stream flushed every 100ms:");
for (const target of [10, 90, 400, 900]) {
  const { ms, worst } = settle(target);
  console.log(
    `  ${String(target).padStart(4)} TPS -> within 10% after ${String(ms).padStart(4)}ms, peak ${worst.toFixed(1)}`
  );
}
