import { createMeter } from "../src/v2/meter.js";
import { createTracker } from "../src/tracker.js";
import { createIncrementalCounter } from "../src/tokenCounter.js";
import { loadConfigSync } from "../src/config.js";

const N = 50_000;
const chunk = "the quick brown fox jumps over ";

function bench(label: string, fn: () => void, n = N) {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const total = performance.now() - t0;
  console.log(`  ${label.padEnd(38)} ${((total / n) * 1000).toFixed(2).padStart(8)}us/op`);
}

console.log("component costs:");
const counter = createIncrementalCounter("heuristic");
bench("incrementalCounter.add", () => { counter.add(chunk); });

const tracker = createTracker({ rollingWindowMs: 1000 });
let ts = Date.now();
bench("tracker.recordTokens", () => { tracker.recordTokens(8, (ts += 2)); });
bench("tracker.getSmoothedTPS", () => { tracker.getSmoothedTPS(); });
bench("tracker.getAverageTPS", () => { tracker.getAverageTPS(); });

console.log("");
console.log("end-to-end handleEvent (publish path included):");
process.env.TPS_METER_UPDATE_INTERVAL_MS = "8";
const meter = createMeter(loadConfigSync());
let i = 0;
const base = Date.now();
bench("handleEvent(text.delta)", () => {
  meter.handleEvent({
    id: `e${i}`, created: base + i * 2, type: "session.text.delta",
    data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: chunk },
  } as never);
  i++;
});
meter.dispose();

console.log("");
console.log("publish path in isolation (many sessions -> Map copy cost):");
for (const sessions of [1, 5, 25]) {
  const m = createMeter(loadConfigSync());
  const b = Date.now();
  for (let s = 0; s < sessions; s++) {
    for (let k = 0; k < 3; k++) {
      m.handleEvent({ id: `w${s}${k}`, created: b + k * 20, type: "session.text.delta",
        data: { sessionID: `s${s}`, assistantMessageID: "m", ordinal: 0, delta: chunk } } as never);
    }
  }
  let j = 0;
  bench(`  ${sessions} active session(s)`, () => {
    m.handleEvent({ id: `p${j}`, created: b + 1000 + j * 20, type: "session.text.delta",
      data: { sessionID: "s0", assistantMessageID: "m", ordinal: 0, delta: chunk } } as never);
    j++;
  }, 20_000);
  m.dispose();
}
