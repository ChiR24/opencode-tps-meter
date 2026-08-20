import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createMeter, type V2Snapshot } from "../v2/meter.js";
import { loadConfigSync } from "../config.js";
import type { V2UnknownEvent } from "../v2/types.js";

const stableEnv = {
  TPS_METER_ENABLED: "true",
  TPS_METER_UPDATE_INTERVAL_MS: "50",
  TPS_METER_INITIAL_DISPLAY_DELAY_MS: "10",
  TPS_METER_ROLLING_WINDOW_MS: "1000",
  TPS_METER_SHOW_AVERAGE: "true",
  TPS_METER_SHOW_INSTANT: "true",
  TPS_METER_SHOW_TOTAL_TOKENS: "true",
  TPS_METER_SHOW_ELAPSED: "false",
  TPS_METER_FORMAT: "compact",
  TPS_METER_MIN_VISIBLE_TPS: "0",
  TPS_METER_FALLBACK_HEURISTIC: "chars_div_4",
  TPS_METER_ENABLE_COLOR_CODING: "false",
  TPS_METER_SLOW_TPS_THRESHOLD: "10",
  TPS_METER_FAST_TPS_THRESHOLD: "50",
} as const;

const originalEnv = new Map<keyof typeof stableEnv, string | undefined>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let eventId = 0;

function textDelta(sessionID: string, delta: string, messageID = "msg_1"): V2UnknownEvent {
  eventId += 1;
  return {
    id: `evt_${eventId}`,
    created: Date.now(),
    type: "session.text.delta",
    data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta },
  };
}

function reasoningDelta(sessionID: string, delta: string, messageID = "msg_1"): V2UnknownEvent {
  eventId += 1;
  return {
    id: `evt_${eventId}`,
    created: Date.now(),
    type: "session.reasoning.delta",
    data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta },
  };
}

function stepEnded(
  sessionID: string,
  finish: string,
  tokens?: { output: number; reasoning: number },
  messageID = "msg_1"
): V2UnknownEvent {
  eventId += 1;
  return {
    id: `evt_${eventId}`,
    created: Date.now(),
    type: "session.step.ended",
    data: {
      sessionID,
      assistantMessageID: messageID,
      finish,
      cost: 0,
      tokens: {
        input: 0,
        output: tokens?.output ?? 0,
        reasoning: tokens?.reasoning ?? 0,
        cache: { read: 0, write: 0 },
      },
    },
  };
}

function sessionIdle(sessionID: string): V2UnknownEvent {
  eventId += 1;
  return {
    id: `evt_${eventId}`,
    created: Date.now(),
    type: "session.idle",
    data: { sessionID },
  };
}

describe("v2 meter", () => {
  beforeEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = stableEnv[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      const previous = originalEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    originalEnv.clear();
  });

  function createHarness() {
    const config = loadConfigSync();
    const meter = createMeter(config);
    return {
      meter,
      config,
      snapshot: (sessionID: string): V2Snapshot | undefined =>
        meter.getSnapshots().get(sessionID),
    };
  }

  it("publishes a live snapshot from session.text.delta after the startup delay", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "hello there, streaming tokens"));
    expect(snapshot("ses_1")).toBeUndefined();

    await delay(40);

    const current = snapshot("ses_1");
    expect(current).toBeDefined();
    expect(current?.active).toBe(true);
    expect(current?.totalTokens).toBeGreaterThan(0);

    meter.dispose();
  });

  it("counts reasoning deltas alongside text deltas", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "abcdefgh"));
    await delay(40);
    const afterText = snapshot("ses_1")?.totalTokens ?? 0;

    meter.handleEvent(reasoningDelta("ses_1", "ijklmnopqrstuvwx"));
    await delay(80);

    expect(snapshot("ses_1")?.totalTokens ?? 0).toBeGreaterThan(afterText);

    meter.dispose();
  });

  it("counts cumulative stream text rather than rounding each chunk", async () => {
    const { meter, snapshot } = createHarness();

    // Twelve 1-char deltas: per-chunk chars/4 would round each up, cumulative gives 3.
    for (const char of "abcdefghijkl") {
      meter.handleEvent(textDelta("ses_1", char));
    }
    await delay(40);

    expect(snapshot("ses_1")?.totalTokens).toBe(3);

    meter.dispose();
  });

  it("prefers provider-reported tokens over the streamed heuristic at step end", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "short"));
    await delay(40);

    meter.handleEvent(stepEnded("ses_1", "stop", { output: 500, reasoning: 100 }));

    const final = snapshot("ses_1");
    expect(final?.totalTokens).toBe(600);
    expect(final?.active).toBe(false);
    expect(final?.avgTps).toBeGreaterThan(0);

    meter.dispose();
  });

  it("falls back to streamed counts when a step reports no tokens", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "abcdefghijkl"));
    await delay(40);

    meter.handleEvent(stepEnded("ses_1", "stop"));

    expect(snapshot("ses_1")?.totalTokens).toBe(3);

    meter.dispose();
  });

  it("keeps the reading visible when a step ends for tool calls", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "streaming before a tool call"));
    await delay(40);
    expect(snapshot("ses_1")?.active).toBe(true);

    meter.handleEvent(stepEnded("ses_1", "tool-calls", { output: 40, reasoning: 0 }));

    const persisted = snapshot("ses_1");
    expect(persisted).toBeDefined();
    expect(persisted?.active).toBe(false);
    expect(persisted?.totalTokens).toBeGreaterThan(0);

    meter.dispose();
  });

  it("clears the active reading on an unknown finish reason", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "streaming that will be invalidated"));
    await delay(40);
    expect(snapshot("ses_1")?.active).toBe(true);

    meter.handleEvent(stepEnded("ses_1", "unknown"));

    expect(snapshot("ses_1")).toBeUndefined();

    meter.dispose();
  });

  it("keeps the latest reading visible after the session idles", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "streaming then going idle"));
    await delay(40);

    meter.handleEvent(sessionIdle("ses_1"));

    const persisted = snapshot("ses_1");
    expect(persisted).toBeDefined();
    expect(persisted?.active).toBe(false);

    meter.dispose();
  });

  it("does not persist a reading when idling before the startup delay", () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "too fast to display"));
    meter.handleEvent(sessionIdle("ses_1"));

    expect(snapshot("ses_1")).toBeUndefined();

    meter.dispose();
  });

  it("keeps sessions isolated", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "abcdefghijkl", "msg_a"));
    meter.handleEvent(textDelta("ses_2", "abcdefghijklmnopqrstuvwx", "msg_b"));
    await delay(40);

    expect(snapshot("ses_1")?.totalTokens).toBe(3);
    expect(snapshot("ses_2")?.totalTokens).toBe(6);

    meter.handleEvent(stepEnded("ses_1", "unknown", undefined, "msg_a"));

    expect(snapshot("ses_1")).toBeUndefined();
    expect(snapshot("ses_2")).toBeDefined();

    meter.dispose();
  });

  it("never substitutes cumulative session usage for a single step's total", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "abcd")); // 4 chars -> 1 heuristic token
    await delay(40);

    // session.usage.updated is a CUMULATIVE SESSION total published from the accumulated
    // session row — it also includes auto-title generation and compaction tokens. Using it
    // as a per-step fallback reported 300 tokens for a 1-token step.
    eventId += 1;
    meter.handleEvent({
      id: `evt_${eventId}`,
      created: Date.now(),
      type: "session.usage.updated",
      data: {
        sessionID: "ses_1",
        cost: 0,
        tokens: { input: 10, output: 250, reasoning: 50, cache: { read: 0, write: 0 } },
      },
    });
    meter.handleEvent(stepEnded("ses_1", "stop"));

    expect(snapshot("ses_1")?.totalTokens).toBe(1);

    meter.dispose();
  });

  it("derives hidden overhead as cumulative usage minus observed step deltas", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "abcd"));
    await delay(40);

    // Step reports 100 real output tokens...
    meter.handleEvent(stepEnded("ses_1", "tool-calls", { output: 100, reasoning: 0 }));
    // ...but the session was billed 130 cumulative. The 30 difference is auto-title and
    // compaction work the user never asked for.
    eventId += 1;
    meter.handleEvent({
      id: `evt_${eventId}`,
      created: Date.now(),
      type: "session.usage.updated",
      data: {
        sessionID: "ses_1",
        cost: 0,
        tokens: { input: 0, output: 130, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });

    meter.handleEvent(textDelta("ses_1", "efgh"));
    await delay(60);

    expect(snapshot("ses_1")?.overheadTokens).toBe(30);

    meter.dispose();
  });

  it("reports zero overhead before any cumulative usage arrives", async () => {
    const { meter, snapshot } = createHarness();

    meter.handleEvent(textDelta("ses_1", "abcdefghijkl"));
    await delay(40);

    expect(snapshot("ses_1")?.overheadTokens).toBe(0);

    meter.dispose();
  });

  it("ignores non-numeric provider token counts instead of concatenating them", async () => {
    const { meter, snapshot } = createHarness();
    meter.handleEvent(textDelta("ses_1", "abcdefghijkl"));
    await delay(40);

    // A string field would make `output + reasoning` string-concatenate to "10050".
    eventId += 1;
    meter.handleEvent({
      id: `evt_${eventId}`,
      created: Date.now(),
      type: "session.step.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: "100", reasoning: "50", cache: { read: 0, write: 0 } },
      },
    } as unknown as V2UnknownEvent);

    expect(typeof snapshot("ses_1")?.totalTokens).toBe("number");
    expect(snapshot("ses_1")?.totalTokens).toBe(3);
    meter.dispose();
  });

  it("ignores negative and non-finite token counts", async () => {
    const { meter, snapshot } = createHarness();
    meter.handleEvent(textDelta("ses_1", "abcdefghijkl"));
    await delay(40);

    eventId += 1;
    meter.handleEvent({
      id: `evt_${eventId}`,
      created: Date.now(),
      type: "session.step.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: -500, reasoning: Number.NaN, cache: { read: 0, write: 0 } },
      },
    } as unknown as V2UnknownEvent);

    expect(snapshot("ses_1")?.totalTokens).toBe(3);
    meter.dispose();
  });

  it("drops events with a missing or non-string sessionID", async () => {
    const { meter } = createHarness();
    for (const bad of [undefined, 42, ""]) {
      eventId += 1;
      meter.handleEvent({
        id: `evt_${eventId}`,
        created: Date.now(),
        type: "session.text.delta",
        data: { sessionID: bad, assistantMessageID: "msg_1", ordinal: 0, delta: "text" },
      } as unknown as V2UnknownEvent);
    }
    await delay(40);
    expect(meter.getSnapshots().size).toBe(0);
    meter.dispose();
  });

  it("frees state for abandoned sessions but keeps the reading on screen", async () => {
    const { meter } = createHarness();
    const { CLEANUP_INTERVAL_MS, MAX_MESSAGE_AGE_MS } = await import("../constants.js");

    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;

    try {
      // A turn that streams and then vanishes: no step.ended, no session.idle.
      meter.handleEvent(textDelta("ses_abandoned", "streaming then disconnected"));
      clock += 40;
      meter.handleEvent(textDelta("ses_abandoned", " more text"));
      expect(meter.getSnapshots().has("ses_abandoned")).toBe(true);

      clock += MAX_MESSAGE_AGE_MS + CLEANUP_INTERVAL_MS + 1;
      meter.handleEvent(textDelta("ses_live", "a new session arrives"));

      // v1 left the final numbers on screen forever; deleting them here made the meter
      // appear to forget after five quiet minutes. Only the heavy state is freed.
      const kept = meter.getSnapshots().get("ses_abandoned");
      expect(kept).toBeDefined();
      expect(kept?.active).toBe(true);
    } finally {
      Date.now = realNow;
      meter.dispose();
    }
  });

  it("caps how many frozen readings it retains", async () => {
    const { meter } = createHarness();
    const { CLEANUP_INTERVAL_MS, MAX_MESSAGE_AGE_MS, MAX_RETAINED_SNAPSHOTS } = await import(
      "../constants.js"
    );

    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;

    try {
      const total = MAX_RETAINED_SNAPSHOTS + 20;
      for (let i = 0; i < total; i++) {
        meter.handleEvent(textDelta(`ses_${i}`, "streaming output here", `msg_${i}`));
        clock += 20;
        meter.handleEvent(textDelta(`ses_${i}`, " more output", `msg_${i}`));
      }
      expect(meter.getSnapshots().size).toBe(total);

      clock += MAX_MESSAGE_AGE_MS + CLEANUP_INTERVAL_MS + 1;
      meter.handleEvent(textDelta("ses_trigger", "sweep now", "msg_t"));

      expect(meter.getSnapshots().size).toBeLessThanOrEqual(MAX_RETAINED_SNAPSHOTS + 1);
      // The most recent sessions survive; the oldest are evicted first.
      expect(meter.getSnapshots().has(`ses_${total - 1}`)).toBe(true);
      expect(meter.getSnapshots().has("ses_0")).toBe(false);
    } finally {
      Date.now = realNow;
      meter.dispose();
    }
  });

  it("ignores v1 event shapes and unrelated v2 events", async () => {
    const { meter } = createHarness();

    meter.handleEvent({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", delta: "ignored" },
    } as unknown as V2UnknownEvent);
    meter.handleEvent({ type: "session.created", data: { sessionID: "ses_1" } });
    meter.handleEvent({ type: "session.text.delta" } as V2UnknownEvent);

    await delay(40);

    expect(meter.getSnapshots().size).toBe(0);

    meter.dispose();
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const { meter } = createHarness();
    const seen: number[] = [];

    const unsubscribe = meter.subscribe((snapshots) => seen.push(snapshots.size));

    meter.handleEvent(textDelta("ses_1", "streaming for subscribers"));
    await delay(40);
    expect(seen.length).toBeGreaterThan(0);

    const countAfterFirst = seen.length;
    unsubscribe();

    meter.handleEvent(textDelta("ses_1", "more streaming"));
    await delay(80);
    expect(seen.length).toBe(countAfterFirst);

    meter.dispose();
  });

  it("clears state and pending timers on dispose", async () => {
    const { meter } = createHarness();

    meter.handleEvent(textDelta("ses_1", "streaming then disposed"));
    meter.dispose();

    await delay(40);

    expect(meter.getSnapshots().size).toBe(0);
  });
});

describe("v2 plugin entries", () => {
  beforeEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = stableEnv[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      const previous = originalEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    originalEnv.clear();
  });

  it("registers the TUI meter on prompt.footer.status and tears down on cleanup", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();

    const { setupTui } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");

    const color = RGBA.fromInts(255, 255, 255, 255);
    const handlers = new Map<string, (event: unknown) => void>();
    const removedHandlers: string[] = [];
    const claims: Array<Record<string, unknown>> = [];
    let slotDisposed = false;

    const theme = {
      text: {
        default: color,
        subdued: color,
        feedback: {
          error: { default: color },
          warning: { default: color },
          success: { default: color },
          info: { default: color },
        },
      },
    };

    const cleanup = setupTui({
      options: undefined,
      theme,
      data: {
        on: (type: string, handler: (event: never) => void) => {
          handlers.set(type, handler as (event: unknown) => void);
          return () => {
            removedHandlers.push(type);
            handlers.delete(type);
          };
        },
      },
      ui: {
        slot: (claim: Record<string, unknown>) => {
          claims.push(claim);
          return () => {
            slotDisposed = true;
          };
        },
      },
    } as never);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.append).toBe("prompt.footer.status");
    expect(typeof claims[0]?.render).toBe("function");

    // The v2 events that replace v1's message.* family, plus the step/tool/execution
    // events Tier 2 needs for attribution and turn decomposition.
    expect([...handlers.keys()].sort()).toEqual([
      "session.execution.failed",
      "session.execution.interrupted",
      "session.execution.started",
      "session.execution.succeeded",
      "session.idle",
      "session.reasoning.delta",
      "session.step.ended",
      "session.step.started",
      "session.text.delta",
      "session.tool.called",
      "session.tool.failed",
      "session.tool.success",
      "session.usage.updated",
    ]);

    expect(typeof cleanup).toBe("function");
    await (cleanup as () => void | Promise<void>)();

    expect(slotDisposed).toBe(true);
    expect(removedHandlers.sort()).toEqual([
      "session.execution.failed",
      "session.execution.interrupted",
      "session.execution.started",
      "session.execution.succeeded",
      "session.idle",
      "session.reasoning.delta",
      "session.step.ended",
      "session.step.started",
      "session.text.delta",
      "session.tool.called",
      "session.tool.failed",
      "session.tool.success",
      "session.usage.updated",
    ]);
  });

  it("does not register anything when disabled", async () => {
    process.env.TPS_METER_ENABLED = "false";

    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { setupTui } = await import("../v2/tui.js");

    let slotCalls = 0;
    const cleanup = setupTui({
      options: undefined,
      theme: { text: { default: null, subdued: null, feedback: {} } },
      data: { on: () => () => {} },
      ui: {
        slot: () => {
          slotCalls += 1;
          return () => {};
        },
      },
    } as never);

    expect(slotCalls).toBe(0);
    expect(cleanup).toBeUndefined();
  });

  it("drains the server event stream and stops on cleanup", async () => {
    const { setupServer, getSnapshots } = await import("../v2/server.js");

    let aborted = false;
    const events: V2UnknownEvent[] = [
      textDelta("ses_srv", "streaming through the server plugin"),
    ];

    const cleanup = setupServer({
      options: undefined,
      event: {
        subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              yield event;
            }
            // Stay open until aborted, mirroring the real long-lived stream.
            await new Promise<void>((resolve) => {
              if (!signal) {
                resolve();
                return;
              }
              signal.addEventListener("abort", () => {
                aborted = true;
                resolve();
              });
            });
          },
        }),
      },
    } as never);

    await delay(40);

    expect(getSnapshots().get("ses_srv")?.totalTokens).toBeGreaterThan(0);

    expect(typeof cleanup).toBe("function");
    await (cleanup as () => void | Promise<void>)();
    await delay(10);

    expect(aborted).toBe(true);
    expect(getSnapshots().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tier 2: attribution, turn decomposition, tokenizer calibration
// ---------------------------------------------------------------------------

function at(base: number, offset: number): number {
  return base + offset;
}

function evt(type: string, created: number, data: Record<string, unknown>): V2UnknownEvent {
  eventId += 1;
  return { id: `evt_${eventId}`, created, type, data };
}

const textAt = (s: string, delta: string, created: number, msg = "msg_1") =>
  evt("session.text.delta", created, {
    sessionID: s,
    assistantMessageID: msg,
    ordinal: 0,
    delta,
  });

describe("v2 metrics", () => {
  beforeEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = stableEnv[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      const previous = originalEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    originalEnv.clear();
  });

  function harness() {
    const meter = createMeter(loadConfigSync());
    return { meter, snap: (id: string) => meter.getSnapshots().get(id) };
  }

  it("measures time to first token from the host-stamped turn start", () => {
    const { meter, snap } = harness();
    const base = Date.now();

    meter.handleEvent(evt("session.execution.started", at(base, 0), { sessionID: "s" }));
    meter.handleEvent(textAt("s", "first chunk of output", at(base, 250)));
    meter.handleEvent(textAt("s", " and more output here", at(base, 300)));

    expect(snap("s")?.ttftMs).toBe(250);
    meter.dispose();
  });

  it("excludes tool execution time from generationTps", () => {
    const { meter, snap } = harness();
    const base = Date.now();

    meter.handleEvent(evt("session.execution.started", at(base, 0), { sessionID: "s" }));
    meter.handleEvent(textAt("s", "abcdefghijklmnopqrstuvwxyz01", at(base, 100)));
    // A tool runs for 2s in the middle of the turn.
    meter.handleEvent(evt("session.tool.called", at(base, 200), { sessionID: "s", id: "c1" }));
    meter.handleEvent(evt("session.tool.success", at(base, 2200), { sessionID: "s", id: "c1" }));
    meter.handleEvent(textAt("s", "abcdefghijklmnopqrstuvwxyz02", at(base, 2300)));

    const s = snap("s");
    expect(s?.toolMs).toBe(2000);
    // Dead time removed, so the model's own rate is strictly higher than end-to-end.
    expect(s?.generationTps).toBeGreaterThan(s?.avgTps ?? 0);
    meter.dispose();
  });

  it("attributes throughput to the model and agent from session.step.started", () => {
    const { meter, snap } = harness();
    const base = Date.now();

    meter.handleEvent(
      evt("session.step.started", at(base, 0), {
        sessionID: "s",
        assistantMessageID: "msg_1",
        agent: "build",
        model: { id: "qwen3.8-max", providerID: "tokenrouter", variant: "max" },
      })
    );
    meter.handleEvent(textAt("s", "some streamed output", at(base, 10)));
    meter.handleEvent(textAt("s", " continuing onwards", at(base, 60)));

    expect(snap("s")?.modelKey).toBe("tokenrouter/qwen3.8-max#max");
    expect(snap("s")?.agent).toBe("build");
    meter.dispose();
  });

  it("calibrates the live estimate against provider ground truth", () => {
    const { meter, snap } = harness();
    const base = Date.now();
    const model = { id: "m", providerID: "p" };
    const forty = "0123456789012345678901234567890123456789"; // 40 chars -> 10 heuristic

    // Step 1 establishes the factor: 20 real tokens for 10 heuristic => 2.0
    meter.handleEvent(
      evt("session.step.started", at(base, 0), { sessionID: "s", assistantMessageID: "m1", model })
    );
    meter.handleEvent(textAt("s", forty, at(base, 10), "m1"));
    expect(snap("s")?.calibrationSamples ?? 0).toBe(0); // not yet calibrated
    meter.handleEvent(
      evt("session.step.ended", at(base, 100), {
        sessionID: "s",
        assistantMessageID: "m1",
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    );

    // Step 2 streams the same text and should now count ~2x.
    meter.handleEvent(
      evt("session.step.started", at(base, 200), { sessionID: "s", assistantMessageID: "m2", model })
    );
    meter.handleEvent(textAt("s", forty, at(base, 210), "m2"));
    meter.handleEvent(textAt("s", forty, at(base, 260), "m2"));

    const s = snap("s");
    expect(s?.calibrationSamples).toBe(1);
    expect(s?.totalTokens).toBe(40); // 20 heuristic * factor 2
    meter.dispose();
  });

  it("ignores calibration samples outside the trusted band", () => {
    const { meter, snap } = harness();
    const base = Date.now();
    const model = { id: "m", providerID: "p" };
    const forty = "0123456789012345678901234567890123456789";

    meter.handleEvent(
      evt("session.step.started", at(base, 0), { sessionID: "s", assistantMessageID: "m1", model })
    );
    meter.handleEvent(textAt("s", forty, at(base, 10), "m1"));
    // 10 heuristic vs 5000 real => factor 500, far outside the band: reject, stay at 1.0
    meter.handleEvent(
      evt("session.step.ended", at(base, 100), {
        sessionID: "s",
        assistantMessageID: "m1",
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 5000, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    );

    meter.handleEvent(
      evt("session.step.started", at(base, 200), { sessionID: "s", assistantMessageID: "m2", model })
    );
    meter.handleEvent(textAt("s", forty, at(base, 210), "m2"));
    meter.handleEvent(textAt("s", forty, at(base, 260), "m2"));

    expect(snap("s")?.calibrationSamples).toBe(0);
    expect(snap("s")?.totalTokens).toBe(20); // uncalibrated
    meter.dispose();
  });

  it("marks an interrupted turn as untrustworthy", async () => {
    const { meter, snap } = harness();
    const base = Date.now();

    meter.handleEvent(evt("session.execution.started", at(base, 0), { sessionID: "s" }));
    meter.handleEvent(textAt("s", "partial output before abort", at(base, 20)));
    meter.handleEvent(textAt("s", " more partial output", at(base, 80)));
    meter.handleEvent(
      evt("session.execution.interrupted", at(base, 120), { sessionID: "s", reason: "user" })
    );
    meter.handleEvent(textAt("s", " trailing", at(base, 180)));
    // The publish throttle is wall-clock, so let the scheduled update land.
    await delay(40);

    expect(snap("s")?.interrupted).toBe(true);
    meter.dispose();
  });
});

// ---------------------------------------------------------------------------
// Durable ledger + the Tier 2/3 surfaces
// ---------------------------------------------------------------------------

describe("v2 ledger", () => {
  it("rolls up measurements per model and computes mean throughput", async () => {
    const { createLedger } = await import("../v2/ledger.js");
    const ledger = createLedger();

    ledger.record({ modelKey: "p/m", tokens: 100, generationMs: 1000, cost: 0.01, ttftMs: 200 });
    ledger.record({ modelKey: "p/m", tokens: 300, generationMs: 1000, cost: 0.02, ttftMs: 400 });

    const entry = ledger.read().models["p/m"];
    expect(entry?.samples).toBe(2);
    expect(entry?.tokens).toBe(400);
    expect(ledger.meanTps("p/m")).toBe(200); // 400 tokens over 2s
    expect(entry?.bestTps).toBe(300);
    expect(entry?.meanTtftMs).toBe(300);
    expect(entry?.cost).toBeCloseTo(0.03, 5);
  });

  it("rejects measurements that cannot yield a rate", async () => {
    const { createLedger } = await import("../v2/ledger.js");
    const ledger = createLedger();

    ledger.record({ modelKey: "p/m", tokens: 0, generationMs: 1000, cost: 0, ttftMs: 0 });
    ledger.record({ modelKey: "p/m", tokens: 100, generationMs: 0, cost: 0, ttftMs: 0 });
    ledger.record({ modelKey: "", tokens: 100, generationMs: 100, cost: 0, ttftMs: 0 });

    expect(Object.keys(ledger.read().models)).toHaveLength(0);
  });

  it("writes through the host store when one is provided", async () => {
    const { createLedger } = await import("../v2/ledger.js");
    let state: Record<string, unknown> = { version: 1, models: {} };
    const storage = {
      store: () =>
        [
          state,
          (mutation: (draft: Record<string, unknown>) => void) => {
            const draft = JSON.parse(JSON.stringify(state));
            mutation(draft);
            state = draft;
            return Promise.resolve();
          },
        ] as never,
      memory: () => [{}, () => {}] as never,
    };

    const ledger = createLedger(storage as never);
    ledger.record({ modelKey: "p/m", tokens: 50, generationMs: 500, cost: 0, ttftMs: 0 });

    // The mutation landed in the host-owned object, not a private copy.
    expect((state.models as Record<string, { samples: number }>)["p/m"]?.samples).toBe(1);
  });
});

describe("v2 optional surfaces", () => {
  beforeEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = stableEnv[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      const previous = originalEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    originalEnv.clear();
  });

  it("registers the sidebar panel, dashboard route and commands when the host offers them", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { setupTui } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");
    const color = RGBA.fromInts(255, 255, 255, 255);

    const claims: Array<Record<string, unknown>> = [];
    const routes: Array<Record<string, unknown>> = [];
    let layers = 0;

    const cleanup = setupTui({
      options: undefined,
      theme: {
        text: {
          default: color,
          subdued: color,
          feedback: {
            error: { default: color },
            warning: { default: color },
            success: { default: color },
            info: { default: color },
          },
        },
      },
      data: {
        on: () => () => {},
        session: {
          get: () => ({ agent: "build" }),
          root: (id: string) => id,
          family: (id: string) => [id],
          cost: () => 0,
          status: () => "idle",
        },
      },
      ui: {
        slot: (claim: Record<string, unknown>) => {
          claims.push(claim);
          return () => {};
        },
        toast: { show: () => {} },
        router: {
          register: (page: Record<string, unknown>) => {
            routes.push(page);
            return () => {};
          },
          navigate: () => {},
          current: () => ({ type: "home" }),
        },
      },
      keymap: {
        layer: () => {
          layers += 1;
        },
      },
      storage: {
        store: () => [{ version: 1, models: {} }, () => Promise.resolve()] as never,
        memory: () => [{}, () => {}] as never,
      },
    } as never);

    const targets = claims.map((c) => c.append).sort();
    expect(targets).toEqual(["app", "prompt.footer.status", "sidebar.content"]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.name).toBe("tps");

    expect(typeof cleanup).toBe("function");
    await (cleanup as () => void | Promise<void>)();
  });

  it("degrades to the footer meter alone when the host offers nothing optional", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { setupTui } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");
    const color = RGBA.fromInts(255, 255, 255, 255);

    const claims: Array<Record<string, unknown>> = [];
    const cleanup = setupTui({
      options: undefined,
      theme: {
        text: {
          default: color,
          subdued: color,
          feedback: {
            error: { default: color },
            warning: { default: color },
            success: { default: color },
            info: { default: color },
          },
        },
      },
      data: { on: () => () => {} },
      ui: {
        slot: (claim: Record<string, unknown>) => {
          claims.push(claim);
          return () => {};
        },
      },
    } as never);

    expect(claims.map((c) => c.append)).toEqual(["prompt.footer.status"]);
    await (cleanup as () => void | Promise<void>)();
  });
});

describe("v2 server wire timings", () => {
  it("measures request-dispatch to response-headers latency", async () => {
    const { setupServer, getWireTimings } = await import("../v2/server.js");

    const hooks = new Map<string, (input: Record<string, unknown>) => void>();
    const cleanup = setupServer({
      options: undefined,
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            // no events; this test only exercises the HTTP hooks
          },
        }),
      },
      session: {
        hook: (name: string, cb: (input: Record<string, unknown>) => void) => {
          hooks.set(name, cb);
        },
      },
    } as never);

    expect([...hooks.keys()].sort()).toEqual(["http.request", "http.response"]);

    hooks.get("http.request")?.({ sessionID: "s", providerID: "p" });
    await delay(30);
    hooks.get("http.response")?.({ sessionID: "s", providerID: "p" });

    const timing = getWireTimings().get("s");
    expect(timing?.samples).toBe(1);
    expect(timing?.providerID).toBe("p");
    expect(timing?.ttfbMs ?? 0).toBeGreaterThanOrEqual(20);

    await (cleanup as () => void | Promise<void>)();
    expect(getWireTimings().size).toBe(0);
  });

  it("survives a host that exposes no session hooks", async () => {
    const { setupServer } = await import("../v2/server.js");
    const cleanup = setupServer({
      options: undefined,
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {},
        }),
      },
    } as never);
    expect(typeof cleanup).toBe("function");
    await (cleanup as () => void | Promise<void>)();
  });
});

// ---------------------------------------------------------------------------
// Incremental counting must be numerically identical to batch counting
// ---------------------------------------------------------------------------

describe("incremental token counting", () => {
  it("matches the batch counter for every algorithm and chunking", async () => {
    const { createTokenizer, createIncrementalCounter } = await import("../tokenCounter.js");

    const corpora = [
      "the quick brown fox jumps over the lazy dog",
      "  leading and trailing whitespace   ",
      "no-spaces-at-all-just-one-long-token",
      "multiple   consecutive    spaces\tand\ttabs\nand\nnewlines",
      "a b c d e f g h i j k l m n o p",
      "",
      "x",
      "trailing space ",
      " leading space",
    ];
    const chunkSizes = [1, 2, 3, 5, 7, 100];

    for (const algorithm of ["heuristic", "word", "code"] as const) {
      const batch = createTokenizer(algorithm);
      for (const text of corpora) {
        for (const size of chunkSizes) {
          const counter = createIncrementalCounter(algorithm);
          let sum = 0;
          for (let i = 0; i < text.length; i += size) {
            sum += counter.add(text.slice(i, i + size));
          }
          expect({ algorithm, size, text, sum }).toEqual({
            algorithm,
            size,
            text,
            sum: batch.count(text),
          });
          expect(counter.total()).toBe(batch.count(text));
        }
      }
    }
  });

  it("joins words split across chunk boundaries", async () => {
    const { createIncrementalCounter, createTokenizer } = await import("../tokenCounter.js");
    const counter = createIncrementalCounter("word");
    // "fo" + "x" is ONE word, not two.
    counter.add("fo");
    counter.add("x");
    counter.add(" bar");
    expect(counter.total()).toBe(createTokenizer("word").count("fox bar"));
  });

  it("absorbs a long stream in linear time", async () => {
    const { createIncrementalCounter } = await import("../tokenCounter.js");
    const chunk = "the quick brown fox jumps over ";

    const time = (deltas: number): number => {
      const counter = createIncrementalCounter("word");
      const t0 = performance.now();
      for (let i = 0; i < deltas; i++) counter.add(chunk);
      return performance.now() - t0;
    };

    time(2000); // warm up
    const small = Math.max(time(2000), 0.5);
    const large = Math.max(time(8000), 0.5);
    // Quadratic would be ~16x for 4x the input; linear is ~4x. Allow generous headroom
    // for a noisy CI machine while still failing loudly on a return to O(n^2).
    expect(large / small).toBeLessThan(10);
  });
});

describe("smoothing latency", () => {
  it("leaves the v1 tracker default untouched", async () => {
    const { createTracker } = await import("../tracker.js");
    const { DEFAULT_EWMA_HALF_LIFE_MS } = await import("../constants.js");

    const base = 1_000_000;
    const feed = (t: { recordTokens: (n: number, ts: number) => void }) => {
      for (let i = 1; i <= 40; i++) t.recordTokens(1, base + i * 10);
    };

    const implicit = createTracker({});
    const explicit = createTracker({ ewmaHalfLifeMs: DEFAULT_EWMA_HALF_LIFE_MS });
    feed(implicit);
    feed(explicit);

    // Omitting the option must behave exactly like passing the v1 constant.
    expect(implicit.getSmoothedTPS()).toBeCloseTo(explicit.getSmoothedTPS(), 6);
  });

  it("converges faster with the v2 half-life", async () => {
    const { createTracker } = await import("../tracker.js");
    const { DEFAULT_EWMA_HALF_LIFE_MS, V2_EWMA_HALF_LIFE_MS } = await import("../constants.js");

    expect(V2_EWMA_HALF_LIFE_MS).toBeLessThan(DEFAULT_EWMA_HALF_LIFE_MS);

    const converge = (halfLife: number): number => {
      const t = createTracker({ rollingWindowMs: 1000, ewmaHalfLifeMs: halfLife });
      const base = 1_000_000;
      for (let i = 1; i <= 600; i++) {
        t.recordTokens(0.9, base + i * 10); // steady 90 TPS
        if (t.getSmoothedTPS() >= 81) return i * 10;
      }
      return Number.POSITIVE_INFINITY;
    };

    const v1 = converge(DEFAULT_EWMA_HALF_LIFE_MS);
    const v2 = converge(V2_EWMA_HALF_LIFE_MS);
    expect(v2).toBeLessThan(v1);
  });
});

describe("publish latency", () => {
  beforeEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = stableEnv[key];
    }
    // Exercise the shipped default rather than the test override.
    delete process.env.TPS_METER_UPDATE_INTERVAL_MS;
  });

  afterEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      const previous = originalEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    originalEnv.clear();
  });

  it("shows nearly every delta instead of dropping updates", async () => {
    const meter = createMeter(loadConfigSync());
    let updates = 0;
    meter.subscribe(() => {
      updates += 1;
    });

    const base = Date.now();
    const DELTAS = 40;
    for (let i = 0; i < DELTAS; i++) {
      meter.handleEvent({
        id: `e${i}`,
        created: base + i * 10,
        type: "session.text.delta",
        data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "streamed text " },
      } as unknown as V2UnknownEvent);
      await delay(10);
    }
    await delay(40);
    meter.dispose();

    // Before the wall-clock fix this produced roughly one update per 15 deltas, because a
    // scheduled publish that failed its guard was dropped and never rescheduled.
    expect(updates).toBeGreaterThan(DELTAS * 0.8);
  });

  it("publishes synchronously once the throttle window is open", async () => {
    const meter = createMeter(loadConfigSync());
    let updates = 0;
    meter.subscribe(() => {
      updates += 1;
    });

    const base = Date.now();
    meter.handleEvent({
      id: "warm",
      created: base,
      type: "session.text.delta",
      data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "warm up text" },
    } as unknown as V2UnknownEvent);
    await delay(40);

    const before = updates;
    meter.handleEvent({
      id: "next",
      created: Date.now(),
      type: "session.text.delta",
      data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "another chunk" },
    } as unknown as V2UnknownEvent);

    // No await: the update must already be visible.
    expect(updates).toBeGreaterThan(before);
    meter.dispose();
  });
});

describe("v2 resilience", () => {
  beforeEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = stableEnv[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(stableEnv) as Array<keyof typeof stableEnv>) {
      const previous = originalEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    originalEnv.clear();
  });

  it("still renders the footer meter when every optional host API throws", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { setupTui } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");
    const color = RGBA.fromInts(255, 255, 255, 255);

    const claims: Array<Record<string, unknown>> = [];
    const boom = () => {
      throw new Error("host API mismatch");
    };

    // Every optional surface is present but broken — exactly the shape of a beta API drift.
    // Before this was guarded, a single throw aborted setup and the host reported a failed
    // plugin load, leaving the user with no meter and nothing in the log.
    const cleanup = setupTui({
      options: undefined,
      theme: {
        text: {
          default: color,
          subdued: color,
          feedback: {
            error: { default: color },
            warning: { default: color },
            success: { default: color },
            info: { default: color },
          },
        },
      },
      data: {
        on: () => () => {},
        session: { get: boom, root: boom, family: boom, cost: boom, status: boom },
      },
      ui: {
        slot: (claim: Record<string, unknown>) => {
          claims.push(claim);
          if (claim.append !== "prompt.footer.status") boom();
          return () => {};
        },
        toast: { show: boom },
        router: { register: boom, navigate: boom, current: boom },
      },
      keymap: { layer: boom },
      storage: { store: boom, memory: boom },
    } as never);

    // The one surface that must survive.
    expect(claims.some((c) => c.append === "prompt.footer.status")).toBe(true);
    expect(typeof cleanup).toBe("function");
    await (cleanup as () => void | Promise<void>)();
  });

  it("keeps metering when the durable store rejects writes", async () => {
    const { createLedger } = await import("../v2/ledger.js");
    const ledger = createLedger({
      store: () =>
        [
          { version: 1, models: {} },
          () => {
            throw new Error("store is read-only");
          },
        ] as never,
      memory: () => [{}, () => {}] as never,
    } as never);

    // Must not throw, and must fall back to the in-memory rollup.
    ledger.record({ modelKey: "p/m", tokens: 100, generationMs: 1000, cost: 0, ttftMs: 0 });
    ledger.record({ modelKey: "p/m", tokens: 100, generationMs: 1000, cost: 0, ttftMs: 0 });
    expect(ledger.meanTps("p/m")).toBeGreaterThan(0);
  });
});

describe("build invariants", () => {
  it("keeps @opentui out of the root bundle's static imports", async () => {
    // Loading @opentui/solid inside the SERVER process dies with
    // `Environment variable "OPENTUI_FORCE_WCWIDTH" is already registered`, which fails the
    // plugin load outright. dist/index.mjs is loaded by both the service and (via the
    // dual-host shape) the TUI, so the TUI half must stay behind a runtime import.
    const fs = await import("node:fs/promises");
    const bundle = await fs.readFile("dist/index.mjs", "utf8");

    const staticImports = bundle
      .split("\n")
      .filter((line) => /^import[\s{*]/.test(line))
      .filter((line) => /@opentui|solid-js/.test(line));

    expect(staticImports).toEqual([]);
    // ...and the lazy path must still be there.
    expect(bundle.includes("./tui.mjs")).toBe(true);
  });

  it("ships only dist and docs", async () => {
    const pkg = await import("../../package.json");
    expect(pkg.default.files).toEqual(["dist", "README.md", "LICENSE"]);
    // Runtime deps would be bundled into the host; the renderer must come from the host.
    expect(pkg.default.dependencies).toBeUndefined();
  });
});
