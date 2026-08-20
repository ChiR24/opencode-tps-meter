import { createMeter } from "../src/v2/meter.js";
import { loadConfigSync } from "../src/config.js";

function run(label: string, deltas: number, chunk: string, heuristic: string) {
  process.env.TPS_METER_FALLBACK_HEURISTIC = heuristic;
  process.env.TPS_METER_UPDATE_INTERVAL_MS = "50";
  const meter = createMeter(loadConfigSync());
  const base = Date.now();
  const t0 = performance.now();
  for (let i = 0; i < deltas; i++) {
    meter.handleEvent({
      id: `e${i}`, created: base + i * 20, type: "session.text.delta",
      data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: chunk },
    } as never);
  }
  const t1 = performance.now();
  meter.dispose();
  const total = t1 - t0;
  console.log(`  ${label.padEnd(30)} ${total.toFixed(1).padStart(8)}ms ${((total / deltas) * 1000).toFixed(1).padStart(8)}us/delta`);
}

const chunk = "the quick brown fox jumps over ";
console.log("chars/4:");
run("400 deltas (12k chars)", 400, chunk, "chars_div_4");
run("2000 deltas (62k chars)", 2000, chunk, "chars_div_4");
run("6000 deltas (186k chars)", 6000, chunk, "chars_div_4");
console.log("words/0.75:");
run("400 deltas (12k chars)", 400, chunk, "words_div_0_75");
run("2000 deltas (62k chars)", 2000, chunk, "words_div_0_75");
run("6000 deltas (186k chars)", 6000, chunk, "words_div_0_75");
