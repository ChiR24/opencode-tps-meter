import plugin from "../src/index.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const chunk = "the quick brown fox jumps over ";

async function run(label: string, deltas: number, heuristic: string) {
  process.env.TPS_METER_FALLBACK_HEURISTIC = heuristic;
  process.env.TPS_METER_TOAST_FALLBACK = "false";
  const handlers = plugin.server({ logger, client: {} } as never) as {
    event: (a: { event: unknown }) => void;
  };

  handlers.event({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "m", sessionID: "s", role: "assistant", time: { created: Date.now() } },
      },
    },
  });

  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let i = 0; i < deltas; i++) {
    handlers.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "s", messageID: "m", partID: "p", delta: chunk },
      },
    });
  }
  const total = performance.now() - t0;
  Bun.gc(true);
  const heapAfter = process.memoryUsage().heapUsed;
  const chars = deltas * chunk.length;
  console.log(
    `  ${label.padEnd(30)} ${total.toFixed(1).padStart(9)}ms  ${((total / deltas) * 1000).toFixed(1).padStart(8)}us/delta  heap+${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)}MB for ${(chars / 1000).toFixed(0)}k chars`
  );
}

console.log("v1 server plugin delta path (chars/4):");
await run("400 deltas", 400, "chars_div_4");
await run("2000 deltas", 2000, "chars_div_4");
await run("6000 deltas", 6000, "chars_div_4");
console.log("v1 server plugin delta path (words/0.75):");
await run("400 deltas", 400, "words_div_0_75");
await run("2000 deltas", 2000, "words_div_0_75");
