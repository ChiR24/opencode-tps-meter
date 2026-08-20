import { createMeter } from "../src/v2/meter.js";
import { loadConfigSync } from "../src/config.js";

/**
 * Simulates the host's ~10ms event batches and measures, for each delta, how long until the
 * snapshot the UI reads actually reflects it.
 */
async function measure(label: string, intervalMs?: number) {
  if (intervalMs === undefined) delete process.env.TPS_METER_UPDATE_INTERVAL_MS;
  else process.env.TPS_METER_UPDATE_INTERVAL_MS = String(intervalMs);

  const config = loadConfigSync();
  const meter = createMeter(config);
  const lags: number[] = [];
  let pending: number | null = null;

  meter.subscribe(() => {
    if (pending !== null) {
      lags.push(performance.now() - pending);
      pending = null;
    }
  });

  const base = Date.now();
  for (let i = 0; i < 120; i++) {
    if (pending === null) pending = performance.now();
    meter.handleEvent({
      id: `e${i}`, created: base + i * 10, type: "session.text.delta",
      data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "some streamed text " },
    } as never);
    await new Promise((r) => setTimeout(r, 10)); // host batch cadence
  }
  meter.dispose();

  lags.sort((a, b) => a - b);
  const p50 = lags[Math.floor(lags.length * 0.5)] ?? 0;
  const p95 = lags[Math.floor(lags.length * 0.95)] ?? 0;
  console.log(
    `  ${label.padEnd(26)} updates=${String(lags.length).padStart(3)}  p50=${p50.toFixed(1).padStart(6)}ms  p95=${p95.toFixed(1).padStart(6)}ms`
  );
}

console.log("delta -> visible snapshot latency (120 deltas at 10ms cadence):");
await measure("config default", undefined);
await measure("explicit 10ms", 10);
