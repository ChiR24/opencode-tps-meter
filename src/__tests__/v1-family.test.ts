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

import { agentNameFromMessage } from "../agentName.js";

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

/** Runs `body` with Date.now() shifted forward, restoring the real clock afterwards. */
async function withClockAdvancedBy<T>(ms: number, body: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const shifted = realNow.call(Date) + ms;
  Date.now = () => shifted;
  try {
    return await body();
  } finally {
    Date.now = realNow;
  }
}

interface RegisteredSlotPlugin {
  slots: {
    session_prompt_right?: (ctx: object, props: { session_id: string }) => unknown;
  };
}

type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry" };

describe("v1 multi-session footer", () => {
  type Renderable = Awaited<ReturnType<typeof import("@opentui/solid").testRender>>;
  // Torn down in afterEach, so a failing assertion cannot leak a renderer, its heartbeat,
  // or the plugin's subscriptions into the next test.
  const renderers: Renderable[] = [];
  const pendingDisposers: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    for (const key of Object.keys(stableEnv)) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = stableEnv[key];
    }
  });

  afterEach(async () => {
    for (const setup of renderers.splice(0)) {
      setup.renderer.destroy();
    }
    for (const dispose of pendingDisposers.splice(0)) {
      await dispose();
    }
    for (const key of Object.keys(stableEnv)) {
      const previous = originalEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    originalEnv.clear();
  });

  async function createHarness(options: { status?: (sessionId: string) => SessionStatus } = {}) {
    const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
    ensureSolidTransformPlugin();
    const { RGBA } = await import("@opentui/core");
    const { testRender } = await import("@opentui/solid");
    const { default: plugin } = await import("../tui.js");

    const handlers = new Map<string, (event: unknown) => void>();
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
          pendingDisposers.push(callback);
          return () => {};
        },
      },
      theme: { current: { text: color, textMuted: color, error: color, warning: color, success: color } },
      ...(options.status
        ? { state: { session: { get: () => undefined, status: options.status } } }
        : {}),
    };

    await plugin.tui(api as never, undefined, { id: "opencode-tps-meter" } as never);

    const emitSessionCreated = (id: string, parentID?: string) => {
      handlers.get("session.created")?.({
        type: "session.created",
        properties: { info: { id, parentID, title: id, version: "1", projectID: "p", directory: ".", time: { created: Date.now(), updated: Date.now() } } },
      });
    };

    /** Announces the session's owning agent the way message payloads do on v1. */
    const announceAgent = (sessionId: string, agent: unknown, role: "user" | "assistant" = "user") => {
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

    /** Completes the session's assistant message; `completedAt` is SERVER time. */
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

    const goIdle = (sessionId: string) => {
      handlers.get("session.idle")?.({ type: "session.idle", properties: { sessionID: sessionId } });
    };

    async function renderView(sessionId: string, width = 160) {
      const slot = slotPlugin?.slots.session_prompt_right;
      if (!slot) throw new Error("session_prompt_right slot was not registered");
      const setup = await testRender(() => slot({ theme: {} }, { session_id: sessionId }) as never, {
        width,
        height: 5,
      });
      renderers.push(setup);
      await setup.flush();
      return { setup, frame: () => setup.captureCharFrame() };
    }

    async function renderFrame(sessionId: string, width = 160): Promise<string> {
      return (await renderView(sessionId, width)).frame();
    }

    return {
      handlers,
      emitSessionCreated,
      announceAgent,
      stream,
      finishChild,
      goIdle,
      renderView,
      renderFrame,
    };
  }

  it("keeps the single-agent meter untouched when no subagents exist", async () => {
    const { stream, renderFrame } = await createHarness();

    await stream("main-solo");
    const frame = await renderFrame("main-solo");

    expect(frame).toContain("TPS");
    expect(frame).toContain("tok");
    expect(frame).not.toContain("Σ");
  });

  it("shows a live subagent next to main in the aggregate line", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-1");
    h.emitSessionCreated("child-explore", "root-1");
    h.announceAgent("child-explore", "explore");

    await h.stream("root-1");
    await h.stream("child-explore");
    const frame = await h.renderFrame("root-1");

    expect(frame).toMatch(/TPS Σ \d+/);
    expect(frame).toContain("main ");
    expect(frame).toContain("explore ");
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
      expect(frame).toMatch(/TPS Σ \d+/);
      expect(frame).toContain("main ");
      expect(frame).toContain("general ");
    }
  });

  it("picks up a parent link learned after the child's first reading", async () => {
    const h = await createHarness();

    await h.stream("root-late");
    await h.stream("child-late");
    const view = await h.renderView("root-late");
    expect(view.frame()).not.toContain("Σ");

    // No publish follows: the link alone must re-resolve the family.
    h.emitSessionCreated("child-late", "root-late");
    await view.setup.renderOnce();
    expect(view.frame()).toMatch(/TPS Σ \d+/);
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
  });

  it("moves a re-dispatched subagent to the end once its previous run went idle", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-r");
    h.emitSessionCreated("child-a", "root-r");
    h.emitSessionCreated("child-b", "root-r");
    h.announceAgent("child-a", "aaa");
    h.announceAgent("child-b", "bbb");

    await h.stream("root-r");
    await h.stream("child-a");
    await h.stream("child-b");

    h.finishChild("child-a", 20);
    h.goIdle("child-a");
    await h.stream("child-a", "continued with the same session id");

    const frame = await h.renderFrame("root-r");
    expect(frame.indexOf("bbb ")).toBeGreaterThan(frame.indexOf("main "));
    expect(frame.indexOf("aaa ")).toBeGreaterThan(frame.indexOf("bbb "));
  });

  it("drops finished subagents after the linger window while main persists", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-4");
    h.emitSessionCreated("child-done", "root-4");
    h.announceAgent("child-done", "reviewer");

    await h.stream("root-4");
    await h.stream("child-done");
    h.finishChild("child-done", 42);

    const fresh = await h.renderFrame("root-4");
    expect(fresh).toContain("reviewer "); // still within the linger window

    await withClockAdvancedBy(4000 + 1000, async () => {
      const later = await h.renderFrame("root-4");
      expect(later).not.toContain("reviewer ");
      expect(later).not.toContain("Σ");
      expect(later).toContain("TPS"); // main reading persists exactly as before
    });
  });

  it("ages finished subagents on the local clock, whatever the server's clock says", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-skew");
    h.emitSessionCreated("child-skew", "root-skew");
    h.announceAgent("child-skew", "reviewer");

    await h.stream("root-skew");
    await h.stream("child-skew");
    // The server's clock runs a minute ahead of the TUI's.
    h.finishChild("child-skew", 42, Date.now() + 60_000);

    expect(await h.renderFrame("root-skew")).toContain("reviewer ");
    await withClockAdvancedBy(4000 + 1000, async () => {
      expect(await h.renderFrame("root-skew")).not.toContain("reviewer ");
    });
  });

  it("does not count a subagent sitting in a tool call toward Σ", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-tool");
    h.emitSessionCreated("child-tool", "root-tool");
    h.announceAgent("child-tool", "explore");

    await h.stream("root-tool");
    await h.stream("child-tool", "explore agent streams quickly before running bash");

    // v1 keeps the child's message open — and its reading active — while its tool runs.
    await withClockAdvancedBy(2000, async () => {
      const frame = await h.renderFrame("root-tool");
      expect(frame).toContain("explore ");
      expect(frame).toMatch(/TPS Σ 0 \|/);
    });
  });

  it("keeps a busy subagent visible through a long tool call but drops a dead one", async () => {
    const busy = new Set(["child-busy"]);
    const h = await createHarness({
      status: (id) => (busy.has(id) ? { type: "busy" } : { type: "idle" }),
    });

    h.emitSessionCreated("root-5");
    h.emitSessionCreated("child-busy", "root-5");
    h.emitSessionCreated("child-dead", "root-5");
    h.announceAgent("child-busy", "busy");
    h.announceAgent("child-dead", "dead");

    await h.stream("root-5");
    await h.stream("child-busy");
    await h.stream("child-dead"); // then its connection drops: no completion, no idle

    await withClockAdvancedBy(10_000, async () => {
      const frame = await h.renderFrame("root-5");
      expect(frame).toContain("busy ");
      expect(frame).not.toContain("dead ");
    });
  });

  it("shows streaming subagents even when the root has no reading of its own", async () => {
    const h = await createHarness();

    // The root's first step was a pure tool call (task dispatch): no text, no reading.
    h.emitSessionCreated("root-quiet");
    h.emitSessionCreated("child-loud", "root-quiet");
    h.announceAgent("child-loud", "explore");
    await h.stream("child-loud");

    const frame = await h.renderFrame("root-quiet");
    expect(frame).toMatch(/TPS Σ \d+ \| explore \d+/);
  });

  it("labels an AgentIdentity by its type, exactly as the v1 server plugin does", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-id");
    h.emitSessionCreated("child-id", "root-id");
    h.announceAgent("child-id", { type: "explore", name: "Explore Agent" });

    await h.stream("root-id");
    await h.stream("child-id");

    const frame = await h.renderFrame("root-id");
    expect(frame).toContain("explore ");
    expect(frame).not.toContain("Explore Agent");
  });

  it("caps entries at four and appends +N overflow", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-6");
    for (let i = 0; i < 5; i += 1) {
      h.emitSessionCreated(`child-${i}`, "root-6");
      h.announceAgent(`child-${i}`, `agent${i}`);
    }

    await h.stream("root-6");
    for (let i = 0; i < 5; i += 1) {
      await h.stream(`child-${i}`, `payload number ${i}`);
    }

    const frame = await h.renderFrame("root-6", 240);
    // Six qualifying entries, four rendered in spawn order: main plus the three
    // earliest-spawned agents, then the overflow.
    expect(frame).toContain("| +2");
    expect(frame).toContain("agent0 ");
    expect(frame).toContain("agent1 ");
    expect(frame).toContain("agent2 ");
    expect(frame).not.toContain("agent3 ");
    expect(frame).not.toContain("agent4 ");
  });

  it("excludes unrelated sessions even when they stream concurrently", async () => {
    const h = await createHarness();

    // No parent links at all: two unrelated roots.
    await h.stream("unrelated-main");
    await h.stream("unrelated-other");

    const frame = await h.renderFrame("unrelated-main");
    expect(frame).not.toContain("Σ"); // no family relationship -> single-agent view
    expect(frame).toContain("TPS");
  });

  it("falls back to short ids when no agent name was announced", async () => {
    const h = await createHarness();

    h.emitSessionCreated("root-7");
    h.emitSessionCreated("abcdefghijklmnop", "root-7");

    await h.stream("root-7");
    await h.stream("abcdefghijklmnop");

    const frame = await h.renderFrame("root-7");
    expect(frame).toMatch(/TPS Σ \d+/);
    expect(frame).toContain("klmnop "); // last six characters, never an invented name
  });
});

describe("agentNameFromMessage", () => {
  it("prefers a plain agent string over every other field", () => {
    expect(agentNameFromMessage({ agent: "explore", agentType: "legacy", mode: "build" })).toBe("explore");
  });

  it("reads an AgentIdentity as type, then name, then id", () => {
    expect(agentNameFromMessage({ agent: { type: "explore", name: "Explore Agent", id: "a1" } })).toBe("explore");
    expect(agentNameFromMessage({ agent: { name: "Explore Agent", id: "a1" } })).toBe("Explore Agent");
    expect(agentNameFromMessage({ agent: { id: "a1" } })).toBe("a1");
  });

  it("falls back to the legacy agentType, then the assistant mode", () => {
    expect(agentNameFromMessage({ agentType: "legacy", mode: "build" })).toBe("legacy");
    expect(agentNameFromMessage({ mode: "build" })).toBe("build");
  });

  it("skips empty fields and rejects non-objects", () => {
    expect(agentNameFromMessage({ agent: "", agentType: "legacy" })).toBe("legacy");
    expect(agentNameFromMessage({ agent: { type: "" }, mode: "build" })).toBe("build");
    expect(agentNameFromMessage({})).toBeUndefined();
    expect(agentNameFromMessage(null)).toBeUndefined();
    expect(agentNameFromMessage("explore")).toBeUndefined();
  });
});
