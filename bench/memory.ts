import { createMeter } from "../src/v2/meter.js";
import { loadConfigSync } from "../src/config.js";

const chunk = "the quick brown fox jumps over the lazy dog ";

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

async function settle() {
  Bun.gc(true);
  await new Promise((r) => setTimeout(r, 20));
  Bun.gc(true);
}

async function scenario(label: string, run: (m: ReturnType<typeof createMeter>) => void) {
  await settle();
  const before = process.memoryUsage().heapUsed;
  const meter = createMeter(loadConfigSync());
  run(meter);
  await settle();
  const peak = process.memoryUsage().heapUsed;
  meter.dispose();
  await settle();
  const after = process.memoryUsage().heapUsed;
  console.log(
    `  ${label.padEnd(46)} retained=${mb(peak - before).padStart(8)}  after dispose=${mb(after - before).padStart(8)}`
  );
}

process.env.TPS_METER_UPDATE_INTERVAL_MS = "8";
const base = Date.now();

// One very long response: 20k deltas ~= 880k characters.
await scenario("single 880k-char response (20k deltas)", (m) => {
  for (let i = 0; i < 20_000; i++) {
    m.handleEvent({ id: `e${i}`, created: base + i * 2, type: "session.text.delta",
      data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: chunk } } as never);
  }
});

// Many messages in one session, each properly settled.
await scenario("500 settled steps in one session", (m) => {
  for (let msg = 0; msg < 500; msg++) {
    for (let i = 0; i < 20; i++) {
      m.handleEvent({ id: `d${msg}-${i}`, created: base + msg * 100 + i, type: "session.text.delta",
        data: { sessionID: "s", assistantMessageID: `m${msg}`, ordinal: 0, delta: chunk } } as never);
    }
    m.handleEvent({ id: `x${msg}`, created: base + msg * 100 + 50, type: "session.step.ended",
      data: { sessionID: "s", assistantMessageID: `m${msg}`, finish: "stop", cost: 0,
        tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } } as never);
  }
});

// Many sessions that never terminate (crash / disconnect path).
await scenario("2000 abandoned sessions (no terminal event)", (m) => {
  for (let s = 0; s < 2000; s++) {
    for (let i = 0; i < 5; i++) {
      m.handleEvent({ id: `a${s}-${i}`, created: base + i, type: "session.text.delta",
        data: { sessionID: `s${s}`, assistantMessageID: "m", ordinal: 0, delta: chunk } } as never);
    }
  }
});
