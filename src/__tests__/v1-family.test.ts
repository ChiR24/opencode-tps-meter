/**
 * Multi-session footer tests for the v1 TUI entry.
 *
 * v1 has no synced family API like v2's `ctx.data.session`, but the real tree is
 * available: `session.created`/`session.updated` carry `info.parentID` and
 * `api.state.session.get()` serves the same Session shape. These tests drive the
 * production event handlers through the same harness as tui.test.ts and assert on
 * rendered frames, so what is verified here is what the user sees.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

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
} as const;

const originalEnv = new Map<string, string | undefined>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RegisteredSlotPlugin {
  slots: {
    session_prompt_right?: (ctx: object, props: { session_id: string }) => unknown;
  };
}

describe("v1 multi-session footer", () => {
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

  async function createHarness() {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { RGBA } = await import("@opentui/core");
    const { testRender } = await import("@opentui/solid");
    const { default: plugin } = await import("../tui.js");

    const handlers = new Map<string, (event: unknown) => void>();
    const disposeCallbacks: Array<() => void | Promise<void>> = [];
    let slotPlugin: RegisteredSlotPlugin | undefined;
    const color = RGBA.fromInts(255, 255, 255, 255);

    const api = {
      slots: {
        register(next: RegisteredSlotPlugin) {
          slotPlugin = next;
          return "opencode-tps-meter";
        },
      },
      event: {
        on(type: string, handler: (event: unknown) => void) {
          handlers.set(type, handler);
          return () => {
            if (handlers.get(type) === handler) handlers.delete(type);
          };
        },
      },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose(callback: () => void | Promise<void>) {
          disposeCallbacks.push(callback);
          return () => {};
        },
      },
      theme: { current: { text: color, textMuted: color, error: color, warning: color, success: color } },
    };

    await plugin.tui(api as never, undefined, { id: "opencode-tps-meter" } as never);

    const emitSessionCreated = (id: string, parentID?: string) => {
      handlers.get("session.created")?.({
        type: "session.created",
        properties: { info: { id, parentID, title: id, version: "1", projectID: "p", directory: ".", time: { created: Date.now(), updated: Date.now() } } },
      });
    };

    /** Announces the session's owning agent the way message payloads do on v1. */
    const announceAgent = (sessionId: string, agent: string, role: "user" | "assistant" = "user") => {
      handlers.get("message.updated")?.({
        type: "message.updated",
        properties: {
          sessionID: sessionId,
          info: {
            id: `${sessionId}-msg-${role}`,
            sessionID: sessionId,
            role,
            time: { created: Date.now() },
            agent,
            tokens: { input: 0, output: 0 },
          },
        },
      });
    };

    /** Streams a little text so the session gets a live snapshot. */
    const stream = async (sessionId: string, text = "streamed output text here") => {
      handlers.get("message.updated")?.({
        type: "message.updated",
        properties: {
          sessionID: sessionId,
          info: {
            id: `${sessionId}-assistant`,
            sessionID: sessionId,
            role: "assistant",
            time: { created: Date.now() },
            tokens: { input: 0, output: 0 },
          },
        },
      });
      handlers.get("message.part.delta")?.({
        type: "message.part.delta",
        properties: {
          sessionID: sessionId,
          messageID: `${sessionId}-assistant`,
          partID: `${sessionId}-part`,
          field: "text",
          delta: text,
        },
      });
      await delay(60);
    };

    const finishChild = (sessionId: string, outputTokens: number, completedAt = Date.now()) => {
      handlers.get("message.updated")?.({
        type: "message.updated",
        properties: {
          sessionID: sessionId,
          info: {
            id: `${sessionId}-assistant`,
            sessionID: sessionId,
            role: "assistant",
            time: { created: completedAt - 5000, completed: completedAt },
            tokens: { input: 0, output: outputTokens },
            finish: "stop",
          },
        },
      });
    };

    async function renderFrame(sessionId: string, width = 160): Promise<string> {
      const slot = slotPlugin?.slots.session_prompt_right;
      if (!slot) throw new Error("session_prompt_right slot was not registered");
      const setup = await testRender(() => slot({ theme: {} }, { session_id: sessionId }), {
        width,
        height: 5,
      });
      await setup.flush();
      return setup.captureCharFrame();
    }

    return {
      handlers,
      disposeCallbacks,
      emitSessionCreated,
      announceAgent,
      stream,
      finishChild,
      renderFrame,
    };
  }

  it("keeps the single-agent meter untouched when no subagents exist", async () => {
    const { stream, renderFrame, disposeCallbacks } = await createHarness();

    await stream("main-solo");
    const frame = await renderFrame("main-solo");

    expect(frame).toContain("TPS");
    expect(frame).toContain("tok");
    expect(frame).not.toContain("\u03A3");

    for (const callback of disposeCallbacks) await callback();
  });

  it("shows a live subagent next to main in the aggregate line", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-1");
    h.emitSessionCreated("child-explore", "root-1");
    h.announceAgent("child-explore", "explore");

    await h.stream("root-1");
    await h.stream("child-explore");
    const frame = await h.renderFrame("root-1");

    expect(frame).toMatch(/TPS \u03A3 \d+/);
    expect(frame).toContain("main ");
    expect(frame).toContain("explore ");

    for (const callback of h.disposeCallbacks) await callback();
  });

  it("resolves the family even when viewing a child session slot", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-2");
    h.emitSessionCreated("child-general", "root-2");
    h.announceAgent("child-general", "general");

    await h.stream("root-2");
    await h.stream("child-general");

    // The footer renders for whichever session is selected; both must show the family.
    for (const selected of ["root-2", "child-general"]) {
      const frame = await h.renderFrame(selected);
      expect(frame).toMatch(/TPS \u03A3 \d+/);
      expect(frame).toContain("main ");
      expect(frame).toContain("general ");
    }

    for (const callback of h.disposeCallbacks) await callback();
  });

  it("keeps children in spawn order after the root", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-3");
    h.emitSessionCreated("child-a", "root-3");
    h.emitSessionCreated("child-b", "root-3");
    h.announceAgent("child-a", "aaa");
    h.announceAgent("child-b", "bbb");

    await h.stream("root-3");
    await h.stream("child-a");
    await delay(30); // let child-a's activity go stale relative to child-b...
    await h.stream("child-b"); // ...child-b is now the most recent, but child-a spawned first

    const frame = await h.renderFrame("root-3");
    const indexMain = frame.indexOf("main ");
    const indexA = frame.indexOf("aaa ");
    const indexB = frame.indexOf("bbb ");
    expect(indexMain).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeGreaterThan(indexMain);
    expect(indexB).toBeGreaterThan(indexA);

    for (const callback of h.disposeCallbacks) await callback();
  });

  it("drops finished subagents after the linger window while main persists", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-4");
    h.emitSessionCreated("child-done", "root-4");
    h.announceAgent("child-done", "reviewer");

    await h.stream("root-4");
    await h.stream("child-done");

    const completedAt = Date.now();
    h.finishChild("child-done", 42, completedAt);

    const fresh = await h.renderFrame("root-4");
    expect(fresh).toContain("reviewer "); // still within the linger window

    const realNow = Date.now;
    let clock = completedAt + 4000 + 1000; // past SUBAGENT_LINGER_MS
    Date.now = () => clock;
    try {
      const later = await h.renderFrame("root-4");
      expect(later).not.toContain("reviewer ");
      expect(later).not.toContain("\u03A3");
      expect(later).toContain("TPS"); // main reading persists exactly as before
    } finally {
      Date.now = realNow;
    }

    for (const callback of h.disposeCallbacks) await callback();
  });

  it("caps entries at four and appends +N overflow", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-5");
    for (let i = 0; i < 5; i += 1) {
      h.emitSessionCreated(`child-${i}`, "root-5");
      h.announceAgent(`child-${i}`, `agent${i}`);
    }

    await h.stream("root-5");
    for (let i = 0; i < 5; i += 1) {
      await h.stream(`child-${i}`, `payload number ${i}`);
    }

    const frame = await h.renderFrame("root-5", 240);
    // Six qualifying entries, four rendered in spawn order: main plus the three
    // earliest-spawned agents, then the overflow.
    expect(frame).toContain("| +2");
    expect(frame).toContain("agent0 ");
    expect(frame).toContain("agent1 ");
    expect(frame).toContain("agent2 ");
    expect(frame).not.toContain("agent3 ");
    expect(frame).not.toContain("agent4 ");

    for (const callback of h.disposeCallbacks) await callback();
  });

  it("excludes unrelated sessions even when they stream concurrently", async () => {
    const h = await createHarness();

    // No parent links at all: two unrelated roots.
    await h.stream("unrelated-main");
    await h.stream("unrelated-other");

    const frame = await h.renderFrame("unrelated-main");
    expect(frame).not.toContain("\u03A3"); // no family relationship -> single-agent view
    expect(frame).toContain("TPS");

    for (const callback of h.disposeCallbacks) await callback();
  });

  it("falls back to short ids when no agent name was announced", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-6");
    h.emitSessionCreated("abcdefghijklmnop", "root-6");

    await h.stream("root-6");
    await h.stream("abcdefghijklmnop");

    const frame = await h.renderFrame("root-6");
    expect(frame).toMatch(/TPS \u03A3 \d+/);
    expect(frame).toContain("klmnop "); // last six characters, never an invented name

    for (const callback of h.disposeCallbacks) await callback();
  });
});
