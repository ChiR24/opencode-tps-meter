/**
 * Multi-session footer aggregate tests.
 *
 * Covers the selection/labeling/formatting rules in src/v2/family.ts plus their
 * integration with the live meter (snapshot.lastActivityAt, aggregate over real streams).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  MAX_METER_ENTRIES,
  SUBAGENT_LINGER_MS,
  collectMeterEntries,
  formatAggregateLine,
  hasSubagentEntries,
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
  tokens?: { output: number; reasoning: number }
): V2UnknownEvent {
  eventId += 1;
  return {
    id: `evt_${eventId}`,
    created: Date.now(),
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
    expect(entries[0]).toMatchObject({ label: "main", isRoot: true, active: true });
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

    // An actively generating session never ages out, however old its stamp.
    const generating = new Map(snapshots);
    generating.set("stale", snap({ sessionID: "stale", active: true, lastActivityAt: NOW - SUBAGENT_LINGER_MS - 1 }));
    const kept = collectMeterEntries({ rootID: "root", memberIDs, snapshots: generating, now: NOW });
    expect(kept.map((e) => e.sessionID)).toEqual(["root", "fresh", "stale"]);
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
      active: true,
      ...partial,
    };
  }

  it("sums instantaneous TPS across currently generating sessions", () => {
    const line = formatAggregateLine([
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 63.4, instantTps: 63.4 }),
      entry({ sessionID: "a", label: "explore", tps: 91.2, instantTps: 91.2 }),
      entry({ sessionID: "b", label: "general", tps: 85.9, instantTps: 85.9 }),
      entry({ sessionID: "c", label: "reviewer", tps: 77.6, instantTps: 77.6 }),
    ]);

    // 63.4 + 91.2 + 85.9 + 77.6 = 318.1 -> 318
    expect(line).toBe("TPS \u03A3 318 | main 63 | explore 91 | general 86 | reviewer 78");
  });

  it("excludes finished sessions from the sum while still showing their average", () => {
    const line = formatAggregateLine([
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 50, instantTps: 50 }),
      entry({ sessionID: "a", label: "explore", tps: 40, instantTps: 12.4, active: false }),
    ]);

    expect(line).toBe("TPS \u03A3 50 | main 50 | explore 40");
  });

  it("caps displayed entries and appends +N for the overflow", () => {
    const rows = [
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 10, instantTps: 10 }),
      ...Array.from({ length: MAX_METER_ENTRIES }, (_, i) =>
        entry({ sessionID: `c${i}`, label: `agent${i}`, tps: 20, instantTps: 20 })
      ),
      entry({ sessionID: "extra", label: "extra", tps: 30, instantTps: 30 }),
    ];

    const line = formatAggregateLine(rows);
    expect(line).toContain(`| +${rows.length - MAX_METER_ENTRIES}`);
    expect(line).not.toContain("extra ");
    // All six are generating: 10 + 20*4 + 30 = 120.
    expect(line.startsWith("TPS \u03A3 120 |")).toBe(true);
  });

  it("rounds every displayed figure to an integer", () => {
    const line = formatAggregateLine([
      entry({ sessionID: "r", label: "main", isRoot: true, tps: 12.49, instantTps: 12.49 }),
    ]);
    expect(line).toContain("main 12");
  });
});

describe("multi-session footer integration", () => {
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
      const line = formatAggregateLine(entries);

      const expectedSum = Math.round(
        [...snapshots.values()].reduce((acc, s) => acc + s.instantTps, 0)
      );
      expect(line).toBe(`TPS \u03A3 ${expectedSum} | main ${Math.round(entries[0]!.tps)} | explore ${Math.round(entries[1]!.tps)} | general ${Math.round(entries[2]!.tps)}`);
      // Every streamed session stamped its latest host time and its first-token spawn time.
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
      expect(finishedEntry.active).toBe(false);
      expect(finishedEntry.tps).toBeGreaterThan(0);

      // ...and vanishes once quiet past the linger window, while the root persists.
      const later = select(finishedAt + SUBAGENT_LINGER_MS + 1);
      expect(later.map((e) => e.sessionID)).toEqual(["root"]);
      expect(hasSubagentEntries(later)).toBe(false);
    } finally {
      meter.dispose();
    }
  });

  it("renders through the footer slot with the session tree attached", async () => {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { setupTui } = await import("../v2/tui.js");
    const { RGBA } = await import("@opentui/core");

    const color = RGBA.fromInts(255, 255, 255, 255);
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

    let footerRender: ((input: unknown) => unknown) | undefined;

    const cleanup = setupTui({
      options: undefined,
      theme,
      data: {
        on: () => () => {},
        session: {
          get: () => ({ agent: "explore" }),
          root: () => "root",
          family: () => ["root", "subA"],
          cost: () => 0,
          status: () => "running",
        },
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

    expect(typeof footerRender).toBe("function");

    // The slot render itself needs a live opentui host renderer (JSX createElement throws
    // without one), so only its presence is asserted here; the selection and formatting it
    // performs are covered by the pure-function tests above.

    expect(typeof cleanup).toBe("function");
    await (cleanup as () => void | Promise<void>)();
  });
});
