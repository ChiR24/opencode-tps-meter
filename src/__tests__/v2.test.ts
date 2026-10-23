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

/**
 * Streams `text` the way the host delivers it: an opening chunk, then the rest 100ms later
 * in host time (the host flushes output every 100ms). The opening chunk alone has no
 * measurable rate, so a single delta never produces a live reading.
 */
function stream(
  meter: { handleEvent(event: V2UnknownEvent): void },
  sessionID: string,
  text: string,
  messageID = "msg_1"
): void {
  const now = Date.now();
  const half = Math.ceil(text.length / 2);
  meter.handleEvent({ ...textDelta(sessionID, text.slice(0, half), messageID), created: now - 100 });
  meter.handleEvent({ ...textDelta(sessionID, text.slice(half), messageID), created: now });
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

function stepEndedWithCache(
  sessionID: string,
  finish: string,
  tokens: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
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
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        reasoning: tokens.reasoning ?? 0,
        cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
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

  it("publishes a live snapshot once a second chunk makes the rate measurable", () => {
    const { meter, snapshot } = createHarness();
    const now = Date.now();

    // The opening chunk was generated over an interval the meter never saw: no rate yet.
    meter.handleEvent({ ...textDelta("ses_1", "hello there, "), created: now - 100 });
    expect(snapshot("ses_1")).toBeUndefined();

    // The next flush gives a real interval, so the reading appears at once.
    meter.handleEvent({ ...textDelta("ses_1", "streaming tokens"), created: now });
    const current = snapshot("ses_1");
    expect(current).toBeDefined();
    expect(current?.active).toBe(true);
    expect(current?.totalTokens).toBeGreaterThan(0);
    expect(current?.instantTps).toBeGreaterThan(0);

    meter.dispose();
  });

  it("counts reasoning deltas alongside text deltas", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "abcdefgh");
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
    const base = Date.now() - 300;
    [..."abcdefghijkl"].forEach((char, i) => {
      meter.handleEvent({ ...textDelta("ses_1", char), created: base + i * 20 });
    });
    await delay(40);

    expect(snapshot("ses_1")?.totalTokens).toBe(3);

    meter.dispose();
  });

  it("prefers provider-reported tokens over the streamed heuristic at step end", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "short");
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

    stream(meter, "ses_1", "abcdefghijkl");
    await delay(40);

    meter.handleEvent(stepEnded("ses_1", "stop"));

    expect(snapshot("ses_1")?.totalTokens).toBe(3);

    meter.dispose();
  });

  it("keeps the reading visible when a step ends for tool calls", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "streaming before a tool call");
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

    stream(meter, "ses_1", "streaming that will be invalidated");
    await delay(40);
    expect(snapshot("ses_1")?.active).toBe(true);

    meter.handleEvent(stepEnded("ses_1", "unknown"));

    expect(snapshot("ses_1")).toBeUndefined();

    meter.dispose();
  });

  it("keeps the latest reading visible after the session idles", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "streaming then going idle");
    await delay(40);

    meter.handleEvent(sessionIdle("ses_1"));

    const persisted = snapshot("ses_1");
    expect(persisted).toBeDefined();
    expect(persisted?.active).toBe(false);

    meter.dispose();
  });

  it("does not persist a reading when idling before a rate is measurable", () => {
    const { meter, snapshot } = createHarness();

    // Only the opening chunk arrived: there is no interval to rate it over.
    meter.handleEvent(textDelta("ses_1", "too fast to display"));
    meter.handleEvent(sessionIdle("ses_1"));

    expect(snapshot("ses_1")).toBeUndefined();

    meter.dispose();
  });

  it("keeps sessions isolated", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "abcdefghijkl", "msg_a");
    stream(meter, "ses_2", "abcdefghijklmnopqrstuvwx", "msg_b");
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

    stream(meter, "ses_1", "abcdefgh"); // 8 chars -> 2 heuristic tokens
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

    expect(snapshot("ses_1")?.totalTokens).toBe(2);

    meter.dispose();
  });

  it("derives hidden overhead as cumulative usage minus observed step deltas", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "abcdefgh");
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

    stream(meter, "ses_1", "ijklmnop");
    await delay(60);

    expect(snapshot("ses_1")?.overheadTokens).toBe(30);

    meter.dispose();
  });

  it("reports zero overhead before any cumulative usage arrives", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "abcdefghijkl");
    await delay(40);

    expect(snapshot("ses_1")?.overheadTokens).toBe(0);

    meter.dispose();
  });

  it("exposes per-step and session prompt cache token totals", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "streaming tokens here");
    await delay(40);

    // Prompt side = input 100 + read 300 + write 0 = 400, so 75% was served from cache.
    meter.handleEvent(
      stepEndedWithCache("ses_1", "stop", { input: 100, output: 50, cacheRead: 300 })
    );

    const final = snapshot("ses_1");
    expect(final?.cacheReadTokens).toBe(300);
    expect(final?.inputTokens).toBe(100);
    expect(final?.sessionCacheReadTokens).toBe(300);
    expect(final?.sessionInputTokens).toBe(100);

    meter.dispose();
  });

  it("preserves session cache totals when a swept session resumes", async () => {
    const { meter, snapshot } = createHarness();
    const { CLEANUP_INTERVAL_MS, MAX_MESSAGE_AGE_MS } = await import("../constants.js");

    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;

    try {
      stream(meter, "ses_1", "streaming tokens here");
      clock += 40;
      meter.handleEvent(
        stepEndedWithCache("ses_1", "tool-calls", { input: 100, output: 10, cacheRead: 300 })
      );
      expect(snapshot("ses_1")?.sessionCacheReadTokens).toBe(300);

      // Go quiet past the stale threshold: the sweep frees sessionUsage but keeps the reading.
      clock += MAX_MESSAGE_AGE_MS + CLEANUP_INTERVAL_MS + 1;
      stream(meter, "ses_other", "trigger the sweep", "msg_other");
      expect(snapshot("ses_1")?.sessionCacheReadTokens).toBe(300);

      // Resume the same session; the new step must add to the retained totals, not restart.
      clock += 40;
      stream(meter, "ses_1", "resuming the same session", "msg_2");
      clock += 40;
      meter.handleEvent(
        stepEndedWithCache("ses_1", "stop", { input: 30, output: 5, cacheRead: 0 }, "msg_2")
      );

      const resumed = snapshot("ses_1");
      expect(resumed?.sessionCacheReadTokens).toBe(300);
      expect(resumed?.sessionInputTokens).toBe(130);
    } finally {
      Date.now = realNow;
      meter.dispose();
    }
  });

  it("sends a tool-call-only step's cache accounting to the footer", async () => {
    const { meter, snapshot } = createHarness();

    // Step 1 streams text and reports a 10% hit rate.
    stream(meter, "ses_1", "some streamed output here");
    await delay(40);
    meter.handleEvent(
      stepEndedWithCache("ses_1", "tool-calls", { input: 900, output: 5, cacheRead: 100 })
    );
    const first = snapshot("ses_1");
    expect(first?.cacheReadTokens).toBe(100);
    expect(first?.sessionCacheReadTokens).toBe(100);

    // Step 2 ends in a tool call without streaming text or reasoning, so no session state is
    // created. Its 90% step must still reach the footer, and the session total must advance.
    meter.handleEvent(
      stepEndedWithCache("ses_1", "tool-calls", { input: 100, output: 5, cacheRead: 900 }, "msg_2")
    );

    const second = snapshot("ses_1");
    expect(second?.cacheReadTokens).toBe(900);
    expect(second?.inputTokens).toBe(100);
    expect(second?.sessionCacheReadTokens).toBe(1000);
    expect(second?.sessionInputTokens).toBe(1000);
    expect(second?.active).toBe(false);

    meter.dispose();
  });

  it("sends a no-delta step's cache accounting to the footer when the turn ends", async () => {
    const { meter, snapshot } = createHarness();

    stream(meter, "ses_1", "some streamed output here");
    await delay(40);
    meter.handleEvent(
      stepEndedWithCache("ses_1", "tool-calls", { input: 900, output: 5, cacheRead: 100 })
    );

    // The final step reports tokens but streams nothing, so there is no tracker to publish.
    meter.handleEvent(
      stepEndedWithCache("ses_1", "stop", { input: 100, output: 5, cacheRead: 900 }, "msg_2")
    );

    const final = snapshot("ses_1");
    expect(final?.cacheReadTokens).toBe(900);
    expect(final?.sessionCacheReadTokens).toBe(1000);
    expect(final?.sessionInputTokens).toBe(1000);

    meter.dispose();
  });

  it("ignores non-numeric provider token counts instead of concatenating them", async () => {
    const { meter, snapshot } = createHarness();
    stream(meter, "ses_1", "abcdefghijkl");
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
    stream(meter, "ses_1", "abcdefghijkl");
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
      stream(meter, "ses_abandoned", "streaming then disconnected");
      clock += 40;
      stream(meter, "ses_abandoned", " more text");
      expect(meter.getSnapshots().has("ses_abandoned")).toBe(true);

      clock += MAX_MESSAGE_AGE_MS + CLEANUP_INTERVAL_MS + 1;
      stream(meter, "ses_live", "a new session arrives");

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
        stream(meter, `ses_${i}`, "streaming output here", `msg_${i}`);
        clock += 20;
        stream(meter, `ses_${i}`, " more output", `msg_${i}`);
      }
      expect(meter.getSnapshots().size).toBe(total);

      clock += MAX_MESSAGE_AGE_MS + CLEANUP_INTERVAL_MS + 1;
      stream(meter, "ses_trigger", "sweep now", "msg_t");

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

    stream(meter, "ses_1", "streaming for subscribers");
    await delay(40);
    expect(seen.length).toBeGreaterThan(0);

    const countAfterFirst = seen.length;
    unsubscribe();

    stream(meter, "ses_1", "more streaming");
    await delay(80);
    expect(seen.length).toBe(countAfterFirst);

    meter.dispose();
  });

  it("clears state and pending timers on dispose", async () => {
    const { meter } = createHarness();

    stream(meter, "ses_1", "streaming then disposed");
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
    // Must be a SIBLING (`after`), not a child: the host's own flexGrow:1 child inside
    // this slot squeezes anything appended within the boundary to zero width whenever a
    // turn is running.
    expect(claims[0]?.after).toBe("prompt.footer.status");
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
      "session.step.failed",
      "session.step.started",
      "session.text.delta",
      "session.tool.called",
      "session.tool.failed",
      "session.tool.input.delta",
      "session.tool.input.ended",
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
      "session.step.failed",
      "session.step.started",
      "session.text.delta",
      "session.tool.called",
      "session.tool.failed",
      "session.tool.input.delta",
      "session.tool.input.ended",
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
    // Two flushes 100ms apart, as the host sends them: one chunk alone has no rate.
    const now = Date.now();
    const events: V2UnknownEvent[] = [
      { ...textDelta("ses_srv", "streaming through "), created: now - 100 },
      { ...textDelta("ses_srv", "the server plugin"), created: now },
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

describe("v2 theme normalization", () => {
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

  async function setupWithTheme(theme: unknown) {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();

    const { setupTui } = await import("../v2/tui.js");

    const handlers = new Map<string, (event: unknown) => void>();
    const claims: Array<{ render: (input: unknown) => unknown; after?: string }> = [];

    const cleanup = setupTui({
      options: { enableColorCoding: true },
      theme,
      data: {
        on: (type: string, handler: (event: never) => void) => {
          handlers.set(type, handler as (event: unknown) => void);
          return () => {
            handlers.delete(type);
          };
        },
      },
      ui: {
        slot: (claim: Record<string, unknown>) => {
          claims.push(claim as { render: (input: unknown) => unknown; after?: string });
          return () => {};
        },
      },
    } as never);

    return { handlers, claims, cleanup };
  }

  it("maps the current host theme (text.base/text.muted) onto the internal shape", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();

    const { normalizeTheme } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");

    const base = RGBA.fromInts(255, 255, 255, 255);
    const muted = RGBA.fromInts(128, 128, 128, 255);
    const error = RGBA.fromInts(255, 0, 0, 255);
    const warning = RGBA.fromInts(255, 255, 0, 255);
    const success = RGBA.fromInts(0, 255, 0, 255);

    // Shape of `@opencode/theme`'s `ResolvedTheme` on current v2 hosts.
    const normalized = normalizeTheme(() => ({
      text: {
        base,
        muted,
        feedback: {
          error: { base: error },
          warning: { base: warning },
          success: { base: success },
          info: { base },
        },
      },
    }) as never);

    expect(normalized.text.default).toBe(base);
    expect(normalized.text.subdued).toBe(muted);
    expect(normalized.text.feedback.error.default).toBe(error);
    expect(normalized.text.feedback.warning.default).toBe(warning);
    expect(normalized.text.feedback.success.default).toBe(success);
  });

  it("falls back to the older leaf names (text.default/text.subdued)", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();

    const { normalizeTheme } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");

    const color = RGBA.fromInts(1, 2, 3, 255);
    // Leaf names early v2 builds exposed.
    const normalized = normalizeTheme(() => ({
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
    }) as never);

    expect(normalized.text.default).toBe(color);
    expect(normalized.text.subdued).toBe(color);
    expect(normalized.text.feedback.warning.default).toBe(color);
  });

  it("colors a live reading from the normalized current-host theme", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();

    const { normalizeTheme, colorForSnapshot } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");

    const base = RGBA.fromInts(255, 255, 255, 255);
    const warning = RGBA.fromInts(255, 255, 0, 255);
    const theme = normalizeTheme(() => ({
      text: {
        base,
        muted: base,
        feedback: {
          error: { base },
          warning: { base: warning },
          success: { base },
          info: { base },
        },
      },
    }) as never);

    const config = loadConfigSync({ enableColorCoding: true });
    // 20 TPS sits between the 10/50 thresholds, so the meter must pick warning.
    const snapshot: V2Snapshot = {
      sessionID: "ses-color",
      instantTps: 20,
      avgTps: 20,
      totalTokens: 100,
      elapsedMs: 5000,
      active: true,
      overheadTokens: 0,
      ttftMs: 0,
      toolMs: 0,
      generationTps: 20,
      modelKey: "default",
      calibrationSamples: 0,
      interrupted: false,
    };

    expect(colorForSnapshot(theme, config, snapshot)).toBe(warning);
  });

  it("re-reads the theme through the getter, so a theme switch recolors the meter", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();

    const { normalizeTheme, colorForSnapshot } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");

    const darkWarning = RGBA.fromInts(255, 255, 0, 255);
    const lightWarning = RGBA.fromInts(0, 0, 255, 255);

    // Shape of `@opencode/theme`'s `ResolvedTheme` on current v2 hosts.
    const dark = {
      text: {
        base: RGBA.fromInts(255, 255, 255, 255),
        muted: RGBA.fromInts(128, 128, 128, 255),
        feedback: {
          error: { base: darkWarning },
          warning: { base: darkWarning },
          success: { base: darkWarning },
          info: { base: darkWarning },
        },
      },
    };
    const light = {
      text: {
        base: RGBA.fromInts(20, 20, 20, 255),
        muted: RGBA.fromInts(190, 190, 190, 255),
        feedback: {
          error: { base: lightWarning },
          warning: { base: lightWarning },
          success: { base: lightWarning },
          info: { base: lightWarning },
        },
      },
    };

    let current: unknown = dark;
    const theme = normalizeTheme(() => current as never);

    const config = loadConfigSync({ enableColorCoding: true });
    // 20 TPS sits between the 10/50 thresholds, so the meter must pick warning.
    const mid: V2Snapshot = {
      sessionID: "ses-theme",
      instantTps: 20,
      avgTps: 20,
      totalTokens: 10,
      elapsedMs: 1000,
      active: true,
      overheadTokens: 0,
      ttftMs: 0,
      toolMs: 0,
      generationTps: 20,
      modelKey: "default",
      calibrationSamples: 0,
      interrupted: false,
    };

    expect(colorForSnapshot(theme, config, mid)).toBe(darkWarning);
    // The host swaps theme mid-session; the meter must follow without a TUI restart.
    current = light;
    expect(colorForSnapshot(theme, config, mid)).toBe(lightWarning);
  });

  it("renders the meter with the current host theme without throwing", async () => {
    const { testRender } = await import("@opentui/solid");
    const { RGBA } = await import("@opentui/core");

    const base = RGBA.fromInts(255, 255, 255, 255);
    const muted = RGBA.fromInts(128, 128, 128, 255);
    const { handlers, claims, cleanup } = await setupWithTheme({
      text: {
        base,
        muted,
        feedback: {
          error: { base },
          warning: { base },
          success: { base },
          info: { base },
        },
      },
    });

    const onTextDelta = handlers.get("session.text.delta");
    expect(onTextDelta).toBeDefined();

    stream({ handleEvent: onTextDelta! }, "ses-flat", "hello there, streaming tokens at a decent clip");
    await delay(120);

    const render = claims[0]?.render;
    expect(typeof render).toBe("function");

    const setup = await testRender(
      () => (render as (input: unknown) => unknown)({ sessionID: "ses-flat" }),
      { width: 80, height: 5 },
    );
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("TPS");

    await (cleanup as unknown as () => void | Promise<void>)?.();
  });

  it("colors the footer meter from the normalized theme, not the raw host theme", async () => {
    const { testRender } = await import("@opentui/solid");
    const { RGBA } = await import("@opentui/core");

    // Distinct from any renderer default, so an unresolved color cannot pass by accident.
    const live = RGBA.fromInts(0, 200, 100, 255);
    const muted = RGBA.fromInts(90, 90, 90, 255);
    const { handlers, claims, cleanup } = await setupWithTheme({
      text: {
        base: live,
        muted,
        feedback: {
          error: { base: live },
          warning: { base: live },
          success: { base: live },
          info: { base: live },
        },
      },
    });

    stream(
      { handleEvent: handlers.get("session.text.delta")! },
      "ses-fg",
      "hello there, streaming tokens at a decent clip"
    );
    await delay(120);

    const footer = claims.find((claim) => claim.after === "prompt.footer.status");
    expect(footer).toBeDefined();

    const setup = await testRender(() => footer!.render({ sessionID: "ses-fg" }), {
      width: 80,
      height: 5,
    });
    await setup.flush();

    const span = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((s) => s.text.includes("TPS"));
    expect(span).toBeDefined();
    // The raw host theme has no text.default/text.subdued, so passing ctx.theme straight to the
    // footer leaves fg unresolved; only the normalized theme yields one of these colors.
    expect([live.toInts().join(","), muted.toInts().join(",")]).toContain(
      span!.fg.toInts().join(",")
    );

    await (cleanup as unknown as () => void | Promise<void>)?.();
  });
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

  it("reports tool time without subtracting it from the generation rate", () => {
    const { meter, snap } = harness();
    const base = Date.now();

    meter.handleEvent(evt("session.execution.started", at(base, 0), { sessionID: "s" }));
    meter.handleEvent(textAt("s", "abcdefghijklmnopqrstuvwxyz01", at(base, 100)));
    // A tool runs while the model is still writing: the only way tool time overlaps a step
    // is a parallel tool call, and the model really was generating throughout it.
    meter.handleEvent(evt("session.tool.called", at(base, 200), { sessionID: "s", id: "c1" }));
    meter.handleEvent(evt("session.tool.success", at(base, 2200), { sessionID: "s", id: "c1" }));
    meter.handleEvent(textAt("s", "abcdefghijklmnopqrstuvwxyz02", at(base, 2300)));

    const s = snap("s");
    expect(s?.toolMs).toBe(2000);
    expect(s?.generationTps).toBe(s?.avgTps);
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

    const targets = claims.map((c) => c.append ?? c.prepend ?? c.after).sort();
    expect(targets).toEqual(["app", "prompt.footer.status", "sidebar.content"]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.name).toBe("tps");

    expect(typeof cleanup).toBe("function");
    await (cleanup as () => void | Promise<void>)();
  });

  it("shows ttft in the compact footer when showTtft is on", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { setupTui } = await import("../v2/tui.js");
    const { testRender } = await import("@opentui/solid");
    const { RGBA } = await import("@opentui/core");
    const color = RGBA.fromInts(255, 255, 255, 255);

    const handlers = new Map<string, (event: unknown) => void>();
    const claims: Array<{ render: (input: unknown) => unknown; after?: string }> = [];
    const cleanup = setupTui({
      options: { showTtft: true },
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
        on: (type: string, handler: (event: never) => void) => {
          handlers.set(type, handler as (event: unknown) => void);
          return () => handlers.delete(type);
        },
      },
      ui: {
        slot: (claim: Record<string, unknown>) => {
          claims.push(claim as { render: (input: unknown) => unknown; after?: string });
          return () => {};
        },
      },
    } as never);

    const base = Date.now();
    const text = handlers.get("session.text.delta")!;
    handlers.get("session.execution.started")!({
      type: "session.execution.started",
      created: base,
      data: { sessionID: "ses-ttft" },
    });
    text({ ...textDelta("ses-ttft", "first chunk of output"), created: base + 250 });
    text({ ...textDelta("ses-ttft", " and the rest of it"), created: base + 300 });
    await delay(120);

    const footer = claims.find((claim) => claim.after === "prompt.footer.status");
    expect(footer).toBeDefined();
    const setup = await testRender(() => footer!.render({ sessionID: "ses-ttft" }), {
      width: 100,
      height: 5,
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("ttft 250ms");

    await (cleanup as unknown as () => void | Promise<void>)?.();
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

    expect(claims.map((c) => c.append ?? c.prepend ?? c.after)).toEqual(["prompt.footer.status"]);
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

describe("tracker rates", () => {
  it("rates a chunk over the interval since the previous one, not its arrival instant", async () => {
    const { createTracker } = await import("../tracker.js");
    const t = createTracker({ rollingWindowMs: 1000 });
    const base = 1_000_000;

    // The host batches ~100ms of output per flush. A 159-token opening chunk divided by the
    // ~10ms until the first publish read as 15,900 TPS; it was generated before the window.
    t.recordTokens(159, base);
    expect(t.isRateReady()).toBe(false);
    expect(t.getSmoothedTPS()).toBe(0);

    t.recordTokens(50, base + 100);
    expect(t.isRateReady()).toBe(true);
    expect(t.getSmoothedTPS()).toBeCloseTo(500, 6);
    expect(t.getAverageTPS()).toBeCloseTo(500, 6);
    // The opening chunk still counts toward the total.
    expect(t.getTotalTokens()).toBe(209);
  });

  it("reports the true rate from the second chunk, with no seed value or smoothing lag", async () => {
    const { createTracker } = await import("../tracker.js");
    const t = createTracker({ rollingWindowMs: 1000 });
    const base = 1_000_000;

    // A fast model: 70 tokens per 100ms flush is 700 TPS. The old tracker seeded every
    // stream at 100 TPS and crept up over seconds.
    for (let i = 0; i <= 10; i++) {
      t.recordTokens(70, base + i * 100);
      if (i >= 1) {
        expect(t.getSmoothedTPS()).toBeCloseTo(700, 6);
      }
    }
  });

  it("falls to zero once a stream stalls past the window", async () => {
    const { createTracker } = await import("../tracker.js");
    const t = createTracker({ rollingWindowMs: 1000 });
    const base = 1_000_000;

    t.recordTokens(10, base);
    t.recordTokens(10, base + 100);
    expect(t.getInstantTPS(base + 100)).toBeCloseTo(100, 6);
    // 10 rated tokens over the 600ms since the stream started.
    expect(t.getInstantTPS(base + 600)).toBeCloseTo(10 / 0.6, 6);
    expect(t.getInstantTPS(base + 1200)).toBe(0);
  });

  it("corrects a step average with the provider count only when the two agree", async () => {
    const { correctedAverage } = await import("../tracker.js");

    // The heuristic counted 100 tokens; the provider says 120 of the same output.
    expect(correctedAverage(50, 100, 120)).toBeCloseTo(60, 6);
    // 10x more than streamed: hidden output, so the streamed figure stands.
    expect(correctedAverage(50, 100, 1000)).toBe(50);
    expect(correctedAverage(50, 100, 0)).toBe(50);
    expect(correctedAverage(0, 100, 120)).toBe(0);
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

    // Warm up with two flushes so the stream has a measurable rate and a first publish.
    const base = Date.now();
    for (const [id, created] of [["warm-1", base - 100], ["warm-2", base]] as const) {
      meter.handleEvent({
        id,
        created,
        type: "session.text.delta",
        data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "warm up text" },
      } as unknown as V2UnknownEvent);
    }
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
          if (claim.after !== "prompt.footer.status") boom();
          return () => {};
        },
        toast: { show: boom },
        router: { register: boom, navigate: boom, current: boom },
      },
      keymap: { layer: boom },
      storage: { store: boom, memory: boom },
    } as never);

    // The one surface that must survive.
    expect(claims.some((c) => c.after === "prompt.footer.status")).toBe(true);
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
    const BUNDLE = "dist/index.mjs";

    // dist/ is gitignored and CI runs `bun test` BEFORE `bun run build`, so a fresh checkout
    // has no bundle to inspect. Build it on demand rather than skipping — skipping would let
    // this invariant silently never run in CI, which is the one place it matters most.
    try {
      await fs.access(BUNDLE);
    } catch {
      const built = Bun.spawn(["bun", "run", "build"], { stdout: "ignore", stderr: "ignore" });
      expect(await built.exited).toBe(0);
    }

    const bundle = await fs.readFile(BUNDLE, "utf8");

    const staticImports = bundle
      .split("\n")
      .filter((line) => /^import[\s{*]/.test(line))
      .filter((line) => /@opentui|solid-js/.test(line));

    expect(staticImports).toEqual([]);
    // ...and the lazy path must still be there.
    expect(bundle.includes("./tui.mjs")).toBe(true);
  }, 120_000);

  it("ships only dist and docs", async () => {
    const pkg = await import("../../package.json");
    expect(pkg.default.files).toEqual(["dist", "README.md", "LICENSE"]);
    // Runtime deps would be bundled into the host; the renderer must come from the host.
    expect(pkg.default.dependencies).toBeUndefined();
  });

  it("resolves ./server and ./tui to modules valid on both plugin loaders", async () => {
    // Two loaders validate a module's DEFAULT export, and they disagree:
    //
    //   v1-style (readV1Plugin, packages/opencode/src/plugin/shared.ts):
    //     ./server must expose `server()`, ./tui must expose `tui()`, and a `tui`
    //     key that is not a function throws `has invalid tui export`.
    //   v2 (Plugin.Definition / isPlugin): default must be `{ id: string, setup: fn }`.
    //
    // The package satisfies both by resolving ./server to the dual-host
    // { id, server, setup } module and ./tui to the dual-host { id, tui, setup }
    // module. Pointing ./server at the v2-only `dist/v2/server.mjs` (a change made
    // to carry a `tui: true` flag) broke this: v1 imports that entrypoint, sees a
    // boolean `tui`, and aborts the whole plugin load.
    const fs = await import("node:fs/promises");
    const pkg = await import("../../package.json");
    const exports = pkg.default.exports as Record<string, { import?: string } | string>;

    try {
      await fs.access("dist/index.mjs");
    } catch {
      const built = Bun.spawn(["bun", "run", "build"], { stdout: "ignore", stderr: "ignore" });
      expect(await built.exited).toBe(0);
    }

    const entryPath = (subpath: string) => {
      const value = exports[subpath];
      const raw = typeof value === "string" ? value : value?.import;
      expect(raw).toBeString();
      return raw as string;
    };

    const server = ((await import("../../" + entryPath("./server").replace("./", ""))) as {
      default: Record<string, unknown>;
    }).default;
    expect(server.id).toBe("opencode-tps-meter");
    expect(typeof server.server).toBe("function"); // v1 loader
    expect(typeof server.setup).toBe("function"); // v2 loader

    const tui = ((await import("../../" + entryPath("./tui").replace("./", ""))) as {
      default: Record<string, unknown>;
    }).default;
    expect(tui.id).toBe("opencode-tps-meter");
    expect(typeof tui.tui).toBe("function"); // v1 loader
    expect(typeof tui.setup).toBe("function"); // v2 loader

    // A `tui` key, when present anywhere a server loader can reach, must be a function.
    if ("tui" in server) expect(typeof server.tui).toBe("function");
    // Pins the entrypoint, which also pins its sibling `types` condition: consumers of
    // `opencode-tps-meter/server` types get `dist/index.d.ts` (dual-host module), not
    // `dist/v2/server.d.ts`. That is the intended revert — flag it here so a future
    // types-only "fix" that re-points at the v2-only bundle breaks loudly.
    expect(entryPath("./server")).toBe("./dist/index.mjs");

    // The file that actually carried the regressed boolean. `./server` no longer
    // points at it, but the guard belongs on the source of the bug, not just the
    // current exports map: re-adding `tui: true` to `src/v2/server.ts` without
    // touching `package.json` must still fail loudly here.
    const v2Server = (
      (await import("../../dist/v2/server.mjs")) as {
        default: Record<string, unknown>;
      }
    ).default;
    expect(v2Server.id).toBe("opencode-tps-meter");
    expect(typeof v2Server.setup).toBe("function");
    if ("tui" in v2Server) expect(typeof v2Server.tui).toBe("function");
  }, 120_000);
});

describe("v2 accurate rates", () => {
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

  const chars = (tokens: number) => "abcd".repeat(tokens);

  /** An opening chunk at `start`, then `count` chunks of `perChunk` tokens every 100ms. */
  function streamSteadily(
    meter: { handleEvent(event: V2UnknownEvent): void },
    start: number,
    count: number,
    perChunk: number
  ): void {
    meter.handleEvent(textAt("s", chars(perChunk), start));
    for (let i = 1; i <= count; i++) {
      meter.handleEvent(textAt("s", chars(perChunk), start + i * 100));
    }
  }

  it("never reports the opening chunk divided by a few milliseconds", () => {
    const meter = createMeter(loadConfigSync());
    const base = Date.now() - 1000;

    // Live log: a 159-token opening chunk read as 15,900 TPS at the first publish.
    meter.handleEvent(textAt("s", chars(150), base));
    meter.handleEvent(textAt("s", chars(50), base + 100));

    const s = meter.getSnapshots().get("s");
    expect(s?.instantTps).toBeCloseTo(500, 6);
    expect(s?.avgTps).toBeCloseTo(500, 6);
    expect(s?.totalTokens).toBe(200);
    meter.dispose();
  });

  it("never rates a tool call delivered whole over the host's started-to-ended gap", () => {
    const meter = createMeter(loadConfigSync());
    const base = Date.now() - 5000;
    const tool = { sessionID: "s", assistantMessageID: "msg_1", id: "call_1" };

    // Live log: the provider sent an 850-token call at once; the host emitted input.started
    // and input.ended 97ms apart, which the previous build rated at 8,763 TPS. The step
    // really began 2.5s earlier (`started`), though its event arrived with the output.
    meter.handleEvent(
      evt("session.step.started", at(base, 2400), { sessionID: "s", assistantMessageID: "msg_1", started: base })
    );
    meter.handleEvent(evt("session.tool.input.started", at(base, 2400), { ...tool, name: "write" }));
    meter.handleEvent(evt("session.tool.input.ended", at(base, 2497), { ...tool, text: chars(850) }));
    meter.handleEvent({ ...stepEnded("s", "tool-calls", { output: 875, reasoning: 0 }), created: at(base, 2500) });

    const s = meter.getSnapshots().get("s");
    expect(s?.totalTokens).toBe(875);
    // No interval was seen, so the honest figure is the whole step: 875 tokens in 2.5s.
    expect(s?.avgTps).toBeCloseTo(350, 6);
    meter.dispose();
  });

  it("rates a tool call that follows text over the gap since the text", () => {
    const meter = createMeter(loadConfigSync());
    const base = Date.now() - 5000;
    const tool = { sessionID: "s", assistantMessageID: "msg_1", id: "call_1" };

    meter.handleEvent(textAt("s", chars(10), at(base, 0)));
    meter.handleEvent(textAt("s", chars(10), at(base, 100)));
    // The model wrote the arguments after its text: 400 tokens over the following 1.9s.
    meter.handleEvent(evt("session.tool.input.ended", at(base, 2000), { ...tool, text: chars(400) }));
    meter.handleEvent({ ...stepEnded("s", "tool-calls"), created: at(base, 2000) });

    // 410 rated tokens (10 text + 400 tool) over the 2s since the opening chunk.
    expect(meter.getSnapshots().get("s")?.avgTps).toBeCloseTo(205, 6);
    meter.dispose();
  });

  it("counts tool input deltas once, even when input.ended repeats the full text", () => {
    const meter = createMeter(loadConfigSync());
    const base = Date.now() - 3000;
    const tool = { sessionID: "s", assistantMessageID: "msg_1", id: "call_1" };

    meter.handleEvent(evt("session.tool.input.delta", at(base, 0), { ...tool, delta: chars(100) }));
    meter.handleEvent(evt("session.tool.input.ended", at(base, 1000), { ...tool, text: chars(200) }));
    // No provider count, so the settled total is exactly what the meter counted: 300 if the
    // ended text had been counted again on top of the delta.
    meter.handleEvent(stepEnded("s", "tool-calls"));

    const s = meter.getSnapshots().get("s");
    expect(s?.totalTokens).toBe(200);
    // The first 100 tokens opened the stream; the remaining 100 arrived over 1s.
    expect(s?.avgTps).toBeCloseTo(100, 6);
    meter.dispose();
  });

  it("keeps the streamed rate when the provider counts output that never streamed", () => {
    const meter = createMeter(loadConfigSync());
    const base = Date.now() - 3000;

    // 10 tokens per 100ms is 100 TPS. Live log: a provider reported 7,788 output tokens for
    // a step that streamed 728, and dividing that by the stream window read as 2,607 TPS.
    streamSteadily(meter, base, 20, 10);
    meter.handleEvent(stepEnded("s", "stop", { output: 7788, reasoning: 0 }));

    const s = meter.getSnapshots().get("s");
    expect(s?.totalTokens).toBe(7788);
    expect(s?.avgTps).toBeCloseTo(100, 6);
    meter.dispose();
  });

  it("corrects the streamed rate with the provider count when the two agree", () => {
    const meter = createMeter(loadConfigSync());
    const base = Date.now() - 3000;

    // 210 heuristic tokens streamed; the provider counted 240 of the same output.
    streamSteadily(meter, base, 20, 10);
    meter.handleEvent(stepEnded("s", "stop", { output: 240, reasoning: 0 }));

    expect(meter.getSnapshots().get("s")?.avgTps).toBeCloseTo(100 * (240 / 210), 6);
    meter.dispose();
  });

  it("leaves reasoning that never streamed out of the comparison", () => {
    const meter = createMeter(loadConfigSync());
    const base = Date.now() - 3000;

    streamSteadily(meter, base, 20, 10);
    // 150 visible output tokens against 210 streamed; the 150 reasoning tokens were never
    // shown. Counting them would claim 300 tokens of streamed output and inflate the rate.
    meter.handleEvent(stepEnded("s", "stop", { output: 150, reasoning: 150 }));

    const s = meter.getSnapshots().get("s");
    expect(s?.avgTps).toBeCloseTo(100 * (150 / 210), 6);
    expect(s?.totalTokens).toBe(300);
    meter.dispose();
  });

  it("settles a failed step and still folds its usage", () => {
    const meter = createMeter(loadConfigSync());
    const base = Date.now() - 3000;

    streamSteadily(meter, base, 5, 10);
    meter.handleEvent(
      evt("session.step.failed", at(base, 600), {
        sessionID: "s",
        assistantMessageID: "msg_1",
        tokens: { input: 900, output: 60, reasoning: 0, cache: { read: 100, write: 0 } },
      })
    );

    const s = meter.getSnapshots().get("s");
    expect(s?.active).toBe(false);
    expect(s?.sessionCacheReadTokens).toBe(100);
    meter.dispose();
  });

  it("feeds every settled step to the ledger, with time to first token once per turn", () => {
    const steps: Array<{ tokens: number; generationMs: number; ttftMs: number }> = [];
    const meter = createMeter(loadConfigSync(), { onStepSettled: (m) => steps.push(m) });
    const base = Date.now() - 5000;

    meter.handleEvent(evt("session.execution.started", at(base, 0), { sessionID: "s" }));
    streamSteadily(meter, base + 200, 10, 10);
    meter.handleEvent(stepEnded("s", "tool-calls", { output: 110, reasoning: 0 }));
    streamSteadily(meter, base + 2000, 10, 10);
    meter.handleEvent(stepEnded("s", "stop", { output: 110, reasoning: 0 }));

    expect(steps).toHaveLength(2);
    expect(steps[0]?.ttftMs).toBe(200);
    expect(steps[1]?.ttftMs).toBe(0);
    for (const step of steps) {
      // The ledger's time is the one implied by the displayed rate, so its means match it.
      expect(step.tokens / (step.generationMs / 1000)).toBeCloseTo(100 * (110 / 110), 6);
    }
    meter.dispose();
  });
});

describe("v2 stalls and calibration", () => {
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

  const chars = (tokens: number) => "abcd".repeat(tokens);
  const model = { providerID: "p", id: "m" };

  it("lets a stalled stream's live rate fall instead of freezing at its last value", async () => {
    const meter = createMeter(loadConfigSync({ rollingWindowMs: 600 }));
    const now = Date.now();
    meter.handleEvent({ ...textDelta("s", chars(10)), created: now - 100 });
    meter.handleEvent({ ...textDelta("s", chars(10)), created: now });
    const live = meter.getSnapshots().get("s")?.instantTps ?? 0;
    expect(live).toBeCloseTo(100, 6);

    // No more output: the reading republishes with the rate as of now, which keeps falling.
    await delay(320);
    const falling = meter.getSnapshots().get("s")?.instantTps ?? 0;
    expect(falling).toBeGreaterThan(0);
    expect(falling).toBeLessThan(live);

    // Once the last chunk leaves the window the stream reads zero, and the timer stops.
    await delay(700);
    const stalled = meter.getSnapshots().get("s");
    expect(stalled?.instantTps).toBe(0);
    expect(stalled?.active).toBe(true);
    meter.dispose();
  });

  it("starts a session calibrated from the factor an earlier session saved", () => {
    const meter = createMeter(loadConfigSync(), {
      initialCalibration: { "p/m": { factor: 2, samples: 5 } },
    });
    const base = Date.now() - 1000;
    meter.handleEvent(evt("session.step.started", at(base, 0), { sessionID: "s", assistantMessageID: "msg_1", model }));
    meter.handleEvent(textAt("s", chars(10), at(base, 100)));
    meter.handleEvent(textAt("s", chars(10), at(base, 200)));

    // 20 heuristic tokens, scaled by the saved factor from the very first chunk.
    expect(meter.getSnapshots().get("s")?.totalTokens).toBe(40);
    meter.dispose();
  });

  it("ignores a saved factor outside the trusted band", () => {
    const meter = createMeter(loadConfigSync(), {
      initialCalibration: { "p/m": { factor: 10, samples: 5 } },
    });
    const base = Date.now() - 1000;
    meter.handleEvent(evt("session.step.started", at(base, 0), { sessionID: "s", assistantMessageID: "msg_1", model }));
    meter.handleEvent(textAt("s", chars(10), at(base, 100)));
    meter.handleEvent(textAt("s", chars(10), at(base, 200)));

    expect(meter.getSnapshots().get("s")?.totalTokens).toBe(20);
    meter.dispose();
  });

  it("reports each accepted calibration sample so it can be persisted", () => {
    const saved: Array<[string, { factor: number; samples: number }]> = [];
    const meter = createMeter(loadConfigSync(), {
      onCalibrated: (key, calibration) => saved.push([key, calibration]),
    });
    const base = Date.now() - 1000;
    meter.handleEvent(evt("session.step.started", at(base, 0), { sessionID: "s", assistantMessageID: "msg_1", model }));
    meter.handleEvent(textAt("s", chars(10), at(base, 100)));
    meter.handleEvent(textAt("s", chars(10), at(base, 200)));
    meter.handleEvent(stepEnded("s", "stop", { output: 30, reasoning: 0 }));

    expect(saved).toEqual([["p/m", { factor: 1.5, samples: 1, weight: 20 }]]);
    meter.dispose();
  });

  it("weights calibration by size, so a tiny step barely moves it", () => {
    const saved: Array<{ factor: number }> = [];
    const meter = createMeter(loadConfigSync(), { onCalibrated: (_key, c) => saved.push(c) });
    const base = Date.now() - 5000;
    const step = (offset: number, rawTokens: number, provider: number) => {
      meter.handleEvent(evt("session.step.started", at(base, offset), { sessionID: "s", assistantMessageID: "msg_1", model }));
      meter.handleEvent(textAt("s", chars(rawTokens / 2), at(base, offset + 100)));
      meter.handleEvent(textAt("s", chars(rawTokens / 2), at(base, offset + 200)));
      meter.handleEvent({ ...stepEnded("s", "stop", { output: provider, reasoning: 0 }), created: at(base, offset + 300) });
    };

    step(0, 1000, 1000); // a long answer: the heuristic was exact
    // A 20-token tool call whose provider count includes call framing: ratio 2. An unweighted
    // average gave it the same say as the 1000-token answer.
    step(1000, 20, 40);
    expect(saved.at(-1)?.factor).toBeCloseTo(1040 / 1020, 6);
    meter.dispose();
  });

  it("leaves a step out of correction and calibration when its reasoning count is unknown", () => {
    const saved: unknown[] = [];
    const meter = createMeter(loadConfigSync(), { onCalibrated: (_key, c) => saved.push(c) });
    const base = Date.now() - 5000;
    meter.handleEvent(evt("session.step.started", at(base, 0), { sessionID: "s", assistantMessageID: "msg_1", model }));
    meter.handleEvent({ ...reasoningDelta("s", chars(100)), created: at(base, 100) });
    meter.handleEvent({ ...reasoningDelta("s", chars(100)), created: at(base, 1100) });
    // Live log: reasoning streamed, the provider reported reasoning 0 and an output below
    // what streamed. Folded in or left out, the count is not comparable.
    meter.handleEvent({ ...stepEnded("s", "stop", { output: 120, reasoning: 0 }), created: at(base, 1100) });

    expect(meter.getSnapshots().get("s")?.avgTps).toBeCloseTo(100, 6);
    expect(saved).toEqual([]);
    meter.dispose();
  });

  it("keeps calibration in the ledger through a stats reset", async () => {
    const { createLedger } = await import("../v2/ledger.js");
    const ledger = createLedger();

    ledger.record({ modelKey: "p/m", tokens: 100, generationMs: 1000, cost: 0, ttftMs: 0 });
    ledger.recordCalibration("p/m", { factor: 1.2, samples: 3 });
    expect(ledger.calibrations()).toEqual({ "p/m": { factor: 1.2, samples: 3 } });

    // /tps reset clears throughput; calibration describes the tokenizer, not the speed.
    ledger.clear();
    expect(ledger.meanTps("p/m")).toBe(0);
    expect(ledger.calibrations()).toEqual({ "p/m": { factor: 1.2, samples: 3 } });
  });
});
