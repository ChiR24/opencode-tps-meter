/**
 * Multi-session footer aggregate tests.
 *
 * Covers the selection/labeling/formatting rules in src/v2/family.ts, their integration
 * with the live meter (snapshot clocks, spawn order across runs), and the v2 footer slot
 * itself rendered through a test renderer — so what is verified is what the user sees.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  MAX_METER_ENTRIES,
  SUBAGENT_LINGER_MS,
  aggregateReading,
  collectMeterEntries,
  formatAggregateLine,
  hasSubagentEntries,
  isGenerating,
  sameIDs,
  shortSessionLabel,
  type AgentMeterEntry,
} from "../v2/family.js";
import type { V2Snapshot } from "../v2/meter.js";
import { loadConfigSync } from "../config.js";
import type { V2UnknownEvent } from "../v2/types.js";

const stableEnv = {
  TPS_METER_ENABLED: "true",
  TPS_METER_UPDATE_INTERVAL_MS: "50",
  TPS_METER_INITIAL_DISPLAY_DELAY_MS: "10",
  TPS_METER_ROLLING_WINDOW_MS: "1000",
  TPS_METER_MIN_VISIBLE_TPS: "0",
  TPS_METER_FALLBACK_HEURISTIC: "chars_div_4",
} as const;

const originalEnv = new Map<string, string | undefined>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let eventId = 0;

function textDelta(sessionID: string, delta: string, created?: number): V2UnknownEvent {
  eventId += 1;
  return {
    id: `evt_${eventId}`,
    created: created ?? Date.now(),
    type: "session.text.delta",
    data: { sessionID, assistantMessageID: `msg_${sessionID}`, ordinal: 0, delta },
  };
}

function stepEnded(
  sessionID: string,
  finish: string,
  tokens?: { output: number; reasoning: number },
  created?: number
): V2UnknownEvent {
  eventId += 1;
  return {
    id: `evt_${eventId}`,
    created: created ?? Date.now(),
    type: "session.step.ended",
    data: {
      sessionID,
      assistantMessageID: `msg_${sessionID}`,
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

function idle(sessionID: string): V2UnknownEvent {
  eventId += 1;
  return { id: `evt_${eventId}`, created: Date.now(), type: "session.idle", data: { sessionID } };
}

/** A fully-formed snapshot for pure-function tests. */
function snap(overrides: Partial<V2Snapshot> & { sessionID: string }): V2Snapshot {
  return {
    instantTps: 0,
    avgTps: 0,
    totalTokens: 100,
    elapsedMs: 1000,
    active: true,
    overheadTokens: 0,
    ttftMs: 0,
    toolMs: 0,
    generationTps: 0,
    modelKey: "p/m",
    calibrationSamples: 0,
    interrupted: false,
    lastActivityAt: 1_000_000,
    startedAt: 1_000_000,
    ...overrides,
  };
}

describe("isGenerating", () => {
  const NOW = 1_000_000;

  it("requires both an active reading and a token inside the window", () => {
    expect(isGenerating(snap({ sessionID: "s", lastActivityAt: NOW - 200 }), NOW, 1000)).toBe(true);
    // v1 keeps a session active through its own tool calls, and a crashed stream never
    // leaves it: the stored instantTps is frozen, so a stale token means not generating.
    expect(isGenerating(snap({ sessionID: "s", lastActivityAt: NOW - 1001 }), NOW, 1000)).toBe(false);
    expect(isGenerating(snap({ sessionID: "s", active: false, lastActivityAt: NOW }), NOW, 1000)).toBe(false);
  });
});

describe("collectMeterEntries", () => {
  const NOW = 1_000_000;

  it("shows only the root when no subagent has a reading", () => {
    const entries = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root"],
      snapshots: new Map([["root", snap({ sessionID: "root" })]]),
      now: NOW,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "main", isRoot: true, generating: true });
    expect(hasSubagentEntries(entries)).toBe(false);
  });

  it("labels children with their agent name and keeps the root as main", () => {
    const entries = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root", "childA", "childB"],
      snapshots: new Map([
        ["root", snap({ sessionID: "root" })],
        ["childA", snap({ sessionID: "childA" })],
        ["childB", snap({ sessionID: "childB" })],
      ]),
      agentOf: (id) => (id === "childA" ? "explore" : undefined),
      now: NOW,
    });

    expect(entries.map((e) => e.label)).toEqual(["main", "explore", shortSessionLabel("childB")]);
    expect(hasSubagentEntries(entries)).toBe(true);
  });

  it("falls back to a short session identifier when no agent name exists", () => {
    const entries = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root", "abcdefghij"],
      snapshots: new Map([
        ["root", snap({ sessionID: "root" })],
        ["abcdefghij", snap({ sessionID: "abcdefghij" })],
      ]),
      now: NOW,
    });

    expect(entries[1]?.label).toBe("efghij");
  });

  it("falls back to the short id when the name resolver throws or returns blank", () => {
    const entries = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root", "child-throws", "child-blank"],
      snapshots: new Map([
        ["root", snap({ sessionID: "root" })],
        ["child-throws", snap({ sessionID: "child-throws", startedAt: NOW - 2 })],
        ["child-blank", snap({ sessionID: "child-blank", startedAt: NOW - 1 })],
      ]),
      agentOf: (id) => {
        if (id === "child-throws") {
          throw new Error("session store drifted");
        }
        return "  ";
      },
      now: NOW,
    });

    expect(entries.map((e) => e.label)).toEqual([
      "main",
      shortSessionLabel("child-throws"),
      shortSessionLabel("child-blank"),
    ]);
  });

  it("puts the root first, then keeps children in spawn order", () => {
    const entries = collectMeterEntries({
      rootID: "root",
      memberIDs: ["lateSpawner", "root", "earlySpawner"],
      snapshots: new Map([
        ["root", snap({ sessionID: "root", startedAt: NOW - 3000 })],
        // Recency must NOT matter: the late spawner is the most recently active but
        // renders after the early one, or the columns swap every time activity trades.
        ["earlySpawner", snap({ sessionID: "earlySpawner", startedAt: NOW - 2000, lastActivityAt: NOW - 2000 })],
        ["lateSpawner", snap({ sessionID: "lateSpawner", startedAt: NOW - 10, lastActivityAt: NOW - 10 })],
      ]),
      now: NOW,
    });

    expect(entries.map((e) => e.sessionID)).toEqual(["root", "earlySpawner", "lateSpawner"]);
  });

  it("breaks same-millisecond spawns deterministically instead of flickering", () => {
    const make = () =>
      collectMeterEntries({
        rootID: "root",
        memberIDs: ["root", "bbb", "aaa"],
        snapshots: new Map([
          ["root", snap({ sessionID: "root" })],
          ["bbb", snap({ sessionID: "bbb", startedAt: NOW })],
          ["aaa", snap({ sessionID: "aaa", startedAt: NOW })],
        ]),
        now: NOW,
      }).map((e) => e.sessionID);

    expect(make()).toEqual(make());
    expect(make()).toEqual(["root", "aaa", "bbb"]);
  });

  it("drops finished subagents after the linger window but keeps fresh ones", () => {
    const memberIDs = ["root", "fresh", "stale"];
    const snapshots = new Map([
      ["root", snap({ sessionID: "root", active: false })],
      ["fresh", snap({ sessionID: "fresh", active: false, lastActivityAt: NOW - 500 })],
      ["stale", snap({ sessionID: "stale", active: false, lastActivityAt: NOW - SUBAGENT_LINGER_MS - 1 })],
    ]);

    const before = collectMeterEntries({ rootID: "root", memberIDs, snapshots, now: NOW });
    expect(before.map((e) => e.sessionID)).toEqual(["root", "fresh"]);
  });

  it("ages out a session whose active flag was stranded by a crash", () => {
    // Cancelled or disconnected: no step end, no idle, so `active` is never cleared.
    const entries = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root", "dead"],
      snapshots: new Map([
        ["root", snap({ sessionID: "root", active: false })],
        ["dead", snap({ sessionID: "dead", active: true, instantTps: 90, lastActivityAt: NOW - SUBAGENT_LINGER_MS - 1 })],
      ]),
      isRunning: () => false,
      now: NOW,
    });

    expect(entries.map((e) => e.sessionID)).toEqual(["root"]);
  });

  it("keeps a subagent visible through a long tool call while the host reports it running", () => {
    const snapshots = new Map([
      ["root", snap({ sessionID: "root", active: false })],
      // Last token 10s ago: the subagent is inside a slow bash/grep call, not finished.
      ["busy", snap({ sessionID: "busy", active: false, avgTps: 45, lastActivityAt: NOW - 10_000 })],
    ]);

    const running = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root", "busy"],
      snapshots,
      isRunning: (id) => id === "busy",
      now: NOW,
    });
    expect(running.map((e) => e.sessionID)).toEqual(["root", "busy"]);
    // Shown at its frozen average and excluded from Σ — it is not generating.
    expect(running[1]).toMatchObject({ generating: false, tps: 45 });

    // A throwing status API degrades to the recency rule rather than breaking the footer.
    const drifted = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root", "busy"],
      snapshots,
      isRunning: () => {
        throw new Error("status unavailable");
      },
      now: NOW,
    });
    expect(drifted.map((e) => e.sessionID)).toEqual(["root"]);
  });

  it("keeps the root's frozen reading regardless of age", () => {
    const entries = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root"],
      snapshots: new Map([["root", snap({ sessionID: "root", active: false, lastActivityAt: NOW - 600_000 })]]),
      now: NOW,
    });

    expect(entries).toHaveLength(1);
    expect(hasSubagentEntries(entries)).toBe(false);
  });

  it("skips family members that have no reading yet", () => {
    const entries = collectMeterEntries({
      rootID: "root",
      memberIDs: ["root", "quiet"],
      snapshots: new Map([["root", snap({ sessionID: "root" })]]),
      now: NOW,
    });

    expect(entries.map((e) => e.sessionID)).toEqual(["root"]);
  });
});

describe("formatAggregateLine", () => {
  function entry(partial: Partial<AgentMeterEntry> & { sessionID: string }): AgentMeterEntry {
    return {
      label: partial.sessionID,
      isRoot: false,
      tps: 0,
      instantTps: 0,
      generating: true,
      ...partial,
    };
  }

  it("sums the generating subagents while the waiting root drops out on its own", () => {
    const line = formatAggregateLine([
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 63.4, instantTps: 63.4, generating: false }),
      entry({ sessionID: "a", label: "explore", tps: 91.2, instantTps: 91.2 }),
      entry({ sessionID: "b", label: "general", tps: 85.9, instantTps: 85.9 }),
      entry({ sessionID: "c", label: "reviewer", tps: 77.6, instantTps: 77.6 }),
    ]);

    // 91.2 + 85.9 + 77.6 = 254.7 -> 255. main is dispatching and waiting, so its frozen
    // rate is not live throughput.
    expect(line).toBe("TPS Σ 255 | main 63 | explore 91 | general 86 | reviewer 78");
  });

  it("counts the root once it is generating again", () => {
    // Children done but still lingering; main is streaming its summary.
    const line = formatAggregateLine([
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 85, instantTps: 85 }),
      entry({ sessionID: "a", label: "explore", tps: 40, instantTps: 0, generating: false }),
      entry({ sessionID: "b", label: "general", tps: 38, instantTps: 0, generating: false }),
    ]);

    expect(line).toBe("TPS Σ 85 | main 85 | explore 40 | general 38");
  });

  it("excludes sessions that are not generating while still showing their average", () => {
    const line = formatAggregateLine([
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 50, instantTps: 50, generating: false }),
      // A v1 child inside a tool call: active, but its 12.4 is a frozen rate.
      entry({ sessionID: "a", label: "explore", tps: 40, instantTps: 12.4, generating: false }),
    ]);

    expect(line).toBe("TPS Σ 0 | main 50 | explore 40");
  });

  it("caps displayed entries and appends +N for the overflow", () => {
    const rows = [
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 10, instantTps: 10, generating: false }),
      ...Array.from({ length: MAX_METER_ENTRIES }, (_, i) =>
        entry({ sessionID: `c${i}`, label: `agent${i}`, tps: 20, instantTps: 20 })
      ),
      entry({ sessionID: "extra", label: "extra", tps: 30, instantTps: 30 }),
    ];

    const line = formatAggregateLine(rows);
    expect(line).toContain(`| +${rows.length - MAX_METER_ENTRIES}`);
    expect(line).not.toContain("extra ");
    // Every generating entry counts, shown or not: 20*4 + 30 = 110.
    expect(line.startsWith("TPS Σ 110 |")).toBe(true);
  });

  it("rounds every displayed figure to an integer", () => {
    const line = formatAggregateLine([
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 12.49, instantTps: 12.49 }),
    ]);
    expect(line).toContain("main 12");
  });
});

describe("aggregateReading", () => {
  const row = (generating: boolean, instantTps: number): AgentMeterEntry => ({
    sessionID: `s${instantTps}`,
    label: "x",
    isRoot: false,
    tps: instantTps,
    instantTps,
    generating,
  });

  it("colours by the mean per-stream rate of the generating entries", () => {
    // Σ would be 240 — "fast" against any per-stream threshold. The mean is what the
    // slow/fast thresholds are defined against.
    expect(aggregateReading([row(true, 60), row(true, 100), row(true, 80), row(false, 5)])).toEqual({
      active: true,
      instantTps: 80,
    });
  });

  it("is idle when nothing is generating", () => {
    expect(aggregateReading([row(false, 60)])).toEqual({ active: false, instantTps: 0 });
  });
});

describe("sameIDs", () => {
  it("compares id lists by content and order", () => {
    expect(sameIDs(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIDs(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameIDs(["a"], ["a", "b"])).toBe(false);
  });
});

function useStableEnv(): void {
  beforeEach(() => {
    for (const key of Object.keys(stableEnv)) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = stableEnv[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(stableEnv)) {
      const previous = originalEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    originalEnv.clear();
  });
}

describe("multi-session footer integration", () => {
  useStableEnv();

  it("aggregates a main session and concurrent subagents from live meter state", async () => {
    const { createMeter } = await import("../v2/meter.js");
    const meter = createMeter(loadConfigSync());

    try {
      for (const [id, text] of [
        ["root", "main agent streaming along here"],
        ["subA", "explore agent scanning the codebase"],
        ["subB", "general agent doing general things"],
      ] as const) {
        meter.handleEvent(textDelta(id, text));
      }
      await delay(60);

      const snapshots = meter.getSnapshots();
      expect(snapshots.get("root")?.active).toBe(true);
      expect(snapshots.get("subA")?.active).toBe(true);

      const entries = collectMeterEntries({
        rootID: "root",
        memberIDs: ["root", "subA", "subB"],
        snapshots,
        agentOf: (id) => (id === "subA" ? "explore" : id === "subB" ? "general" : undefined),
        now: Date.now(),
      });

      expect(hasSubagentEntries(entries)).toBe(true);
      expect(entries.every((e) => e.generating)).toBe(true);
      const line = formatAggregateLine(entries);

      // Everyone is streaming, so Σ covers all three — the root included.
      const expectedSum = Math.round(entries.reduce((acc, e) => acc + e.instantTps, 0));
      expect(line).toBe(`TPS Σ ${expectedSum} | main ${Math.round(entries[0]!.tps)} | explore ${Math.round(entries[1]!.tps)} | general ${Math.round(entries[2]!.tps)}`);
      // Every streamed session stamped its latest activity and its first-token spawn time.
      expect(snapshots.get("subA")?.lastActivityAt).toBeGreaterThan(0);
      expect(snapshots.get("subA")?.startedAt).toBeGreaterThan(0);
    } finally {
      meter.dispose();
    }
  });

  it("ages out a completed subagent from the aggregate after the linger window", async () => {
    const { createMeter } = await import("../v2/meter.js");
    const meter = createMeter(loadConfigSync());

    try {
      meter.handleEvent(textDelta("root", "the main turn continues onward"));
      meter.handleEvent(textDelta("subA", "short-lived explore work"));
      await delay(60);

      // Subagent finishes its whole turn...
      meter.handleEvent(stepEnded("subA", "stop", { output: 25, reasoning: 0 }));
      const finishedAt = meter.getSnapshots().get("subA")?.lastActivityAt ?? 0;
      expect(finishedAt).toBeGreaterThan(0);

      const select = (now: number) =>
        collectMeterEntries({
          rootID: "root",
          memberIDs: ["root", "subA"],
          snapshots: meter.getSnapshots(),
          now,
        });

      // ...is still listed immediately (frozen average, excluded from Sigma)...
      const soon = select(finishedAt);
      expect(soon.map((e) => e.label)).toContain(shortSessionLabel("subA"));
      const finishedEntry = soon.find((e) => !e.isRoot)!;
      expect(finishedEntry.generating).toBe(false);
      expect(finishedEntry.tps).toBeGreaterThan(0);

      // ...and vanishes once quiet past the linger window, while the root persists.
      const later = select(finishedAt + SUBAGENT_LINGER_MS + 1);
      expect(later.map((e) => e.sessionID)).toEqual(["root"]);
      expect(hasSubagentEntries(later)).toBe(false);
    } finally {
      meter.dispose();
    }
  });

  it("stamps lastActivityAt on the local clock even when the host clock is skewed", async () => {
    const { createMeter } = await import("../v2/meter.js");
    const meter = createMeter(loadConfigSync());

    try {
      // A remote service 10s behind: tolerated by eventTime, fatal to a 4s linger window
      // if the footer compared the host stamp against its own Date.now().
      const skew = 10_000;
      meter.handleEvent(textDelta("subA", "remote service streaming", Date.now() - skew));
      await delay(60);
      expect(Math.abs(Date.now() - (meter.getSnapshots().get("subA")?.lastActivityAt ?? 0))).toBeLessThan(1000);

      meter.handleEvent(stepEnded("subA", "stop", { output: 5, reasoning: 0 }, Date.now() - skew));
      const settled = meter.getSnapshots().get("subA");
      expect(settled?.active).toBe(false);
      expect(Math.abs(Date.now() - (settled?.lastActivityAt ?? 0))).toBeLessThan(1000);
    } finally {
      meter.dispose();
    }
  });

  it("holds spawn order through tool calls and rejoins at the end after going idle", async () => {
    const { createMeter } = await import("../v2/meter.js");
    const meter = createMeter(loadConfigSync());
    const order = () =>
      collectMeterEntries({
        rootID: "root",
        memberIDs: ["root", "subA", "subB"],
        snapshots: meter.getSnapshots(),
        now: Date.now(),
      }).map((e) => e.sessionID);

    try {
      meter.handleEvent(textDelta("root", "dispatching two subagents now"));
      meter.handleEvent(textDelta("subA", "first subagent output", Date.now() - 5));
      await delay(20);
      meter.handleEvent(textDelta("subB", "second subagent output"));
      await delay(60);
      expect(order()).toEqual(["root", "subA", "subB"]);

      // A tool-call break is not the end of the run: subA keeps its column.
      meter.handleEvent(stepEnded("subA", "tool-calls", { output: 5, reasoning: 0 }));
      meter.handleEvent(textDelta("subA", "resumed after the tool returned"));
      await delay(60);
      expect(order()).toEqual(["root", "subA", "subB"]);

      // Finished and re-dispatched: a new spawn, so it rejoins after subB.
      meter.handleEvent(stepEnded("subA", "stop", { output: 5, reasoning: 0 }));
      meter.handleEvent(idle("subA"));
      await delay(5);
      meter.handleEvent(textDelta("subA", "continued with the same session id"));
      await delay(60);
      expect(order()).toEqual(["root", "subB", "subA"]);
    } finally {
      meter.dispose();
    }
  });

  it("frees the spawn stamp of a session swept as stale", async () => {
    const { createMeter } = await import("../v2/meter.js");
    const { CLEANUP_INTERVAL_MS, MAX_MESSAGE_AGE_MS } = await import("../constants.js");
    const meter = createMeter(loadConfigSync());
    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;

    try {
      meter.handleEvent(textDelta("ses_gone", "streams and then disconnects"));
      clock += 40;
      meter.handleEvent(textDelta("ses_gone", " without a terminal event"));
      const firstSpawn = meter.getSnapshots().get("ses_gone")?.startedAt ?? 0;
      expect(firstSpawn).toBeGreaterThan(0);

      clock += MAX_MESSAGE_AGE_MS + CLEANUP_INTERVAL_MS + 1;
      meter.handleEvent(textDelta("ses_other", "a later event triggers the sweep"));

      // Had the stamp survived the sweep, this would still report the old spawn time.
      meter.handleEvent(textDelta("ses_gone", "the session comes back to life"));
      clock += 40;
      meter.handleEvent(textDelta("ses_gone", " and keeps streaming"));
      expect(meter.getSnapshots().get("ses_gone")?.startedAt).toBeGreaterThan(firstSpawn);
    } finally {
      Date.now = realNow;
      meter.dispose();
    }
  });
});

describe("v2 footer slot", () => {
  useStableEnv();

  type Renderable = Awaited<ReturnType<typeof import("@opentui/solid").testRender>>;
  const renderers: Renderable[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const setup of renderers.splice(0)) {
      setup.renderer.destroy();
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  const SUBDUED = [128, 128, 128] as const;

  interface FakeTree {
    root?: (sessionID: string) => string;
    family?: (rootID: string) => string[] | undefined;
    get?: (sessionID: string) => { agent?: string } | undefined;
    status?: (sessionID: string) => "idle" | "running";
  }

  async function createFooter(tree: FakeTree | undefined) {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { setupTui } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");
    const { testRender } = await import("@opentui/solid");

    const rgb = (r: number, g: number, b: number) => RGBA.fromInts(r, g, b, 255);
    const theme = {
      text: {
        default: rgb(255, 255, 255),
        subdued: rgb(...SUBDUED),
        feedback: {
          error: { default: rgb(255, 0, 0) },
          warning: { default: rgb(255, 255, 0) },
          success: { default: rgb(0, 255, 0) },
          info: { default: rgb(0, 0, 255) },
        },
      },
    };

    const handlers = new Map<string, (event: unknown) => void>();
    let footerRender: ((input: unknown) => unknown) | undefined;

    const session = tree
      ? {
          get: tree.get ?? (() => undefined),
          root: tree.root ?? ((id: string) => id),
          family: tree.family ?? ((id: string) => [id]),
          cost: () => 0,
          status: tree.status ?? (() => "idle"),
        }
      : undefined;

    const cleanup = setupTui({
      options: undefined,
      theme,
      data: {
        on: (type: string, handler: (event: unknown) => void) => {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
        session,
      },
      ui: {
        slot: (claim: Record<string, unknown>) => {
          if (claim.after === "prompt.footer.status") {
            footerRender = claim.render as (input: unknown) => unknown;
          }
          return () => {};
        },
      },
    } as never);
    if (typeof cleanup === "function") {
      cleanups.push(cleanup);
    }

    const emit = (event: V2UnknownEvent) => handlers.get(event.type)?.(event);

    async function render(sessionID: string) {
      if (!footerRender) throw new Error("footer slot was not registered");
      const render = footerRender;
      const setup = await testRender(() => render({ sessionID }) as never, { width: 160, height: 3 });
      renderers.push(setup);
      await setup.flush();
      return {
        setup,
        frame: () => setup.captureCharFrame(),
        /** fg colour of the span carrying the meter text, as 0-255 ints. */
        color: () => {
          for (const line of setup.captureSpans().lines) {
            for (const span of line.spans) {
              if (span.text.includes("TPS")) {
                return [span.fg.r, span.fg.g, span.fg.b].map((c) => Math.round(c * 255));
              }
            }
          }
          return undefined;
        },
      };
    }

    return { emit, render, handlers };
  }

  const familyTree: FakeTree = {
    root: () => "root",
    family: () => ["root", "subA", "subB"],
    get: (id) => (id === "subA" ? { agent: "explore" } : id === "subB" ? { agent: "general" } : undefined),
  };

  it("renders main plus live subagents, with Σ covering everything generating", async () => {
    const footer = await createFooter(familyTree);
    footer.emit(textDelta("root", "main agent streaming along here"));
    footer.emit(textDelta("subA", "explore agent scanning the codebase"));
    await delay(60);

    const view = await footer.render("root");
    const match = view.frame().match(/TPS Σ (\d+) \| main (\d+) \| explore (\d+)/);
    expect(match).not.toBeNull();
    const [, sum, main, explore] = match!.map(Number);
    // Each column rounds separately, so the rounded total may differ by one.
    expect(Math.abs(sum! - (main! + explore!))).toBeLessThanOrEqual(1);
  });

  it("still shows streaming subagents when the root has no reading of its own", async () => {
    // The root's first step was a pure tool call (task dispatch): no text, no reading.
    const footer = await createFooter(familyTree);
    footer.emit(textDelta("subA", "explore agent scanning the codebase"));
    footer.emit(textDelta("subB", "general agent doing general things"));
    await delay(60);

    const frame = (await footer.render("root")).frame();
    expect(frame).toMatch(/TPS Σ \d+ \| explore \d+ \| general \d+/);
  });

  it("colours the aggregate by its own state, not by the waiting root", async () => {
    const footer = await createFooter(familyTree);
    footer.emit(textDelta("root", "planning the fan-out before dispatch"));
    await delay(60);
    // The root dispatches: its step ends to run the task tool, so its reading settles.
    footer.emit(stepEnded("root", "tool-calls", { output: 8, reasoning: 0 }));
    footer.emit(textDelta("subA", "explore agent scanning the codebase"));
    await delay(60);

    const view = await footer.render("root");
    expect(view.frame()).toContain("Σ");
    expect(view.color()).toBeDefined();
    expect(view.color()).not.toEqual([...SUBDUED]);
  });

  it("keeps rendering when the host's session lookup throws", async () => {
    const footer = await createFooter({
      ...familyTree,
      get: () => {
        throw new Error("unsynced session");
      },
    });
    footer.emit(textDelta("root", "main agent streaming along here"));
    footer.emit(textDelta("subA", "explore agent scanning the codebase"));
    await delay(60);

    const frame = (await footer.render("root")).frame();
    expect(frame).toMatch(/TPS Σ \d+ \| main \d+ \| subA \d+/);
  });

  it("falls back to the single-session meter when the family lookup drifts", async () => {
    const footer = await createFooter({ root: () => "root", family: () => undefined });
    footer.emit(textDelta("root", "main agent streaming along here"));
    footer.emit(textDelta("subA", "explore agent scanning the codebase"));
    await delay(60);

    // Viewing the child: a stale root with no members would render `Σ | explore` and no main.
    const frame = (await footer.render("subA")).frame();
    expect(frame).toContain("TPS");
    expect(frame).not.toContain("Σ");
    expect(frame).not.toContain("main");
  });

  it("ages finished subagents out on the heartbeat, with no further events", async () => {
    const footer = await createFooter(familyTree);
    footer.emit(textDelta("root", "main agent streaming along here"));
    footer.emit(textDelta("subA", "explore agent scanning the codebase"));
    await delay(60);
    footer.emit(stepEnded("subA", "stop", { output: 9, reasoning: 0 }));

    const view = await footer.render("root");
    expect(view.frame()).toContain("explore");

    const realNow = Date.now;
    const jumped = realNow.call(Date) + SUBAGENT_LINGER_MS + 1000;
    Date.now = () => jumped;
    try {
      // Nothing publishes from here on; only the heartbeat can re-run the filter.
      await delay(700);
      await view.setup.renderOnce();
      expect(view.frame()).not.toContain("explore");
      expect(view.frame()).not.toContain("Σ");
      expect(view.frame()).toContain("TPS");
    } finally {
      Date.now = realNow;
    }
  });

  it("releases its event subscriptions when the footer slot cannot be claimed", async () => {
    const { setupTui } = await import("../v2/tui.js");
    const subscribed = new Map<string, unknown>();

    // The plugin load still fails — but nothing it registered may outlive it.
    expect(() =>
      setupTui({
        options: undefined,
        theme: {},
        data: {
          on: (type: string, handler: unknown) => {
            subscribed.set(type, handler);
            return () => subscribed.delete(type);
          },
        },
        ui: {
          slot: () => {
            throw new Error("slot API drifted");
          },
        },
      } as never)
    ).toThrow("slot API drifted");
    expect(subscribed.size).toBe(0);
  });
});
