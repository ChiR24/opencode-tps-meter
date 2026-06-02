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
  TPS_METER_SLOW_TPS_THRESHOLD: "10",
  TPS_METER_FAST_TPS_THRESHOLD: "50",
} as const;

const originalEnv = new Map<keyof typeof stableEnv, string | undefined>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RegisteredSlotPlugin {
  slots: {
    session_prompt_right?: (ctx: object, props: { session_id: string }) => unknown;
  };
}

describe("TUI plugin", () => {
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
    const theme = {
      text: color,
      textMuted: color,
      error: color,
      warning: color,
      success: color,
    };

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
            if (handlers.get(type) === handler) {
              handlers.delete(type);
            }
          };
        },
      },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose(callback: () => void | Promise<void>) {
          disposeCallbacks.push(callback);
          return () => {
            const index = disposeCallbacks.indexOf(callback);
            if (index >= 0) {
              disposeCallbacks.splice(index, 1);
            }
          };
        },
      },
      theme: {
        current: theme,
      },
    };

    await plugin.tui(api as never, undefined, {
      id: "opencode-tps-meter",
      source: "file",
      spec: "opencode-tps-meter",
      target: "src/tui.tsx",
      enabled: true,
      active: true,
      state: "first",
      first_time: Date.now(),
      last_time: Date.now(),
      time_changed: Date.now(),
      load_count: 1,
      fingerprint: "test",
    } as never);

    return { handlers, slotPlugin, testRender, theme, disposeCallbacks };
  }

  it("renders an empty persistent session prompt slot before stats exist", async () => {
    const { slotPlugin, testRender, theme } = await createHarness();

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-empty" }), { width: 80, height: 5 });
    await setup.flush();

    expect(setup.captureCharFrame()).not.toContain("TPS");
  });

  it("renders final TPS stats in the persistent session prompt slot", async () => {
    const { handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    if (!messageUpdated) {
      throw new Error("message.updated handler was not registered");
    }

    const completedAt = Date.now();
    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: completedAt - 1000, completed: completedAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 42,
            reasoning: 8,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        },
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-1" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("TPS");
    expect(frame).toContain("50 tok");
  });

  it("does not double count a delta followed by the full part update", async () => {
    const { handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    const partDelta = handlers.get("message.part.delta");
    const partUpdated = handlers.get("message.part.updated");
    if (!messageUpdated || !partDelta || !partUpdated) {
      throw new Error("required TUI handlers were not registered");
    }

    const createdAt = Date.now();
    const completedAt = createdAt + 10_000;
    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-dedupe",
        info: {
          id: "message-dedupe",
          sessionID: "session-dedupe",
          role: "assistant",
          time: { created: createdAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });

    partDelta({
      type: "message.part.delta",
      properties: {
        sessionID: "session-dedupe",
        messageID: "message-dedupe",
        partID: "part-1",
        field: "text",
        delta: "abcd",
      },
    });

    partUpdated({
      type: "message.part.updated",
      properties: {
        sessionID: "session-dedupe",
        time: completedAt,
        part: {
          id: "part-1",
          sessionID: "session-dedupe",
          messageID: "message-dedupe",
          type: "text",
          text: "abcd",
        },
      },
    });

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-dedupe",
        info: {
          id: "message-dedupe",
          sessionID: "session-dedupe",
          role: "assistant",
          time: { created: createdAt, completed: completedAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        },
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-dedupe" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("TPS");
    expect(frame).toContain("1 tok");
    expect(frame).not.toContain("2 tok");
  });

  it("caches zero-token deltas before full part updates", async () => {
    process.env.TPS_METER_FALLBACK_HEURISTIC = "words_div_0_75";

    const { handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    const partDelta = handlers.get("message.part.delta");
    const partUpdated = handlers.get("message.part.updated");
    if (!messageUpdated || !partDelta || !partUpdated) {
      throw new Error("required TUI handlers were not registered");
    }

    const createdAt = Date.now();
    const completedAt = createdAt + 10_000;
    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-zero-token-dedupe",
        info: {
          id: "message-zero-token-dedupe",
          sessionID: "session-zero-token-dedupe",
          role: "assistant",
          time: { created: createdAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });

    for (const delta of ["hello", " ", "world"]) {
      partDelta({
        type: "message.part.delta",
        properties: {
          sessionID: "session-zero-token-dedupe",
          messageID: "message-zero-token-dedupe",
          partID: "part-1",
          field: "text",
          delta,
        },
      });
    }

    partUpdated({
      type: "message.part.updated",
      properties: {
        sessionID: "session-zero-token-dedupe",
        time: completedAt,
        part: {
          id: "part-1",
          sessionID: "session-zero-token-dedupe",
          messageID: "message-zero-token-dedupe",
          type: "text",
          text: "hello world",
        },
      },
    });

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-zero-token-dedupe",
        info: {
          id: "message-zero-token-dedupe",
          sessionID: "session-zero-token-dedupe",
          role: "assistant",
          time: { created: createdAt, completed: completedAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        },
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-zero-token-dedupe" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("3 tok");
    expect(frame).not.toContain("7 tok");
  });

  it("keeps final snapshots isolated by session", async () => {
    const { handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    if (!messageUpdated) {
      throw new Error("message.updated handler was not registered");
    }

    const completedAt = Date.now();
    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-a",
        info: {
          id: "message-a",
          sessionID: "session-a",
          role: "assistant",
          time: { created: completedAt - 1000, completed: completedAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        },
      },
    });

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-b",
        info: {
          id: "message-b",
          sessionID: "session-b",
          role: "assistant",
          time: { created: completedAt - 2000, completed: completedAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 12,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        },
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-a" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("50 tok");
    expect(frame).not.toContain("12 tok");
  });

  it("uses official final token totals over streamed heuristic counts", async () => {
    const { handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    const partDelta = handlers.get("message.part.delta");
    if (!messageUpdated || !partDelta) {
      throw new Error("required TUI handlers were not registered");
    }

    const createdAt = Date.now();
    const completedAt = createdAt + 1000;
    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-official",
        info: {
          id: "message-official",
          sessionID: "session-official",
          role: "assistant",
          time: { created: createdAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });

    partDelta({
      type: "message.part.delta",
      properties: {
        sessionID: "session-official",
        messageID: "message-official",
        partID: "part-1",
        field: "text",
        delta: "x".repeat(100),
      },
    });

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-official",
        info: {
          id: "message-official",
          sessionID: "session-official",
          role: "assistant",
          time: { created: createdAt, completed: completedAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 2,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        },
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-official" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("2 tok");
    expect(frame).not.toContain("25 tok");
  });

  it("counts tiny streamed chunks by cumulative text instead of per-chunk ceilings", async () => {
    const { handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    const partDelta = handlers.get("message.part.delta");
    if (!messageUpdated || !partDelta) {
      throw new Error("required TUI handlers were not registered");
    }

    const createdAt = Date.now();
    const completedAt = createdAt + 10_000;
    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-tiny-chunks",
        info: {
          id: "message-tiny-chunks",
          sessionID: "session-tiny-chunks",
          role: "assistant",
          time: { created: createdAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });

    for (let i = 0; i < 10; i += 1) {
      partDelta({
        type: "message.part.delta",
        properties: {
          sessionID: "session-tiny-chunks",
          messageID: "message-tiny-chunks",
          partID: "part-1",
          field: "text",
          delta: "x",
        },
      });
    }

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-tiny-chunks",
        info: {
          id: "message-tiny-chunks",
          sessionID: "session-tiny-chunks",
          role: "assistant",
          time: { created: createdAt, completed: completedAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        },
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-tiny-chunks" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("3 tok");
    expect(frame).not.toContain("10 tok");
  });

  it("publishes the first live snapshot after the configured latency without waiting for another delta", async () => {
    const { disposeCallbacks, handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    const partDelta = handlers.get("message.part.delta");
    if (!messageUpdated || !partDelta) {
      throw new Error("required TUI handlers were not registered");
    }

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-live-latency",
        info: {
          id: "message-live-latency",
          sessionID: "session-live-latency",
          role: "assistant",
          time: { created: Date.now() },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });

    partDelta({
      type: "message.part.delta",
      properties: {
        sessionID: "session-live-latency",
        messageID: "message-live-latency",
        partID: "part-1",
        field: "text",
        delta: "abcd",
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    await delay(40);

    const delayed = await testRender(() => slot({ theme }, { session_id: "session-live-latency" }), { width: 80, height: 5 });
    await delayed.flush();
    const frame = delayed.captureCharFrame();

    expect(frame).toContain("TPS");
    expect(frame).toContain("1 tok");

    for (const callback of disposeCallbacks) {
      await callback();
    }
  });

  it("keeps the latest streamed stats visible after the session idles", async () => {
    const { disposeCallbacks, handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    const partDelta = handlers.get("message.part.delta");
    const sessionIdle = handlers.get("session.idle");
    if (!messageUpdated || !partDelta || !sessionIdle) {
      throw new Error("required TUI handlers were not registered");
    }

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-idle-persist",
        info: {
          id: "message-idle-persist",
          sessionID: "session-idle-persist",
          role: "assistant",
          time: { created: Date.now() },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });

    partDelta({
      type: "message.part.delta",
      properties: {
        sessionID: "session-idle-persist",
        messageID: "message-idle-persist",
        partID: "part-1",
        field: "text",
        delta: "abcd",
      },
    });

    await delay(40);

    sessionIdle({
      type: "session.idle",
      properties: {
        sessionID: "session-idle-persist",
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-idle-persist" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("TPS");
    expect(frame).toContain("1 tok");

    for (const callback of disposeCallbacks) {
      await callback();
    }
  });

  it("keeps streamed stats visible when an assistant message finishes for a tool call", async () => {
    const { disposeCallbacks, handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    const partDelta = handlers.get("message.part.delta");
    if (!messageUpdated || !partDelta) {
      throw new Error("required TUI handlers were not registered");
    }

    const createdAt = Date.now();
    const completedAt = createdAt + 1000;
    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-tool-call-persist",
        info: {
          id: "message-tool-call-persist",
          sessionID: "session-tool-call-persist",
          role: "assistant",
          time: { created: createdAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });

    partDelta({
      type: "message.part.delta",
      properties: {
        sessionID: "session-tool-call-persist",
        messageID: "message-tool-call-persist",
        partID: "part-1",
        field: "text",
        delta: "abcd",
      },
    });

    await delay(40);

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-tool-call-persist",
        info: {
          id: "message-tool-call-persist",
          sessionID: "session-tool-call-persist",
          role: "assistant",
          time: { created: createdAt, completed: completedAt },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "tool-calls",
        },
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-tool-call-persist" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("TPS");
    expect(frame).toContain("1 tok");

    for (const callback of disposeCallbacks) {
      await callback();
    }
  });

  it("does not create an idle snapshot before the startup delay", async () => {
    process.env.TPS_METER_INITIAL_DISPLAY_DELAY_MS = "1000";
    const { disposeCallbacks, handlers, slotPlugin, testRender, theme } = await createHarness();

    const messageUpdated = handlers.get("message.updated");
    const partDelta = handlers.get("message.part.delta");
    const sessionIdle = handlers.get("session.idle");
    if (!messageUpdated || !partDelta || !sessionIdle) {
      throw new Error("required TUI handlers were not registered");
    }

    messageUpdated({
      type: "message.updated",
      properties: {
        sessionID: "session-idle-before-delay",
        info: {
          id: "message-idle-before-delay",
          sessionID: "session-idle-before-delay",
          role: "assistant",
          time: { created: Date.now() },
          parentID: "parent-1",
          modelID: "model",
          providerID: "provider",
          mode: "chat",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });

    partDelta({
      type: "message.part.delta",
      properties: {
        sessionID: "session-idle-before-delay",
        messageID: "message-idle-before-delay",
        partID: "part-1",
        field: "text",
        delta: "abcd",
      },
    });

    sessionIdle({
      type: "session.idle",
      properties: {
        sessionID: "session-idle-before-delay",
      },
    });

    const slot = slotPlugin?.slots.session_prompt_right;
    if (!slot) {
      throw new Error("session_prompt_right slot was not registered");
    }

    const setup = await testRender(() => slot({ theme }, { session_id: "session-idle-before-delay" }), { width: 80, height: 5 });
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).not.toContain("TPS");
    expect(frame).not.toContain("1 tok");

    for (const callback of disposeCallbacks) {
      await callback();
    }
  });

  it("removes event handlers on lifecycle dispose", async () => {
    const { disposeCallbacks, handlers } = await createHarness();

    expect(handlers.size).toBe(4);
    for (const callback of disposeCallbacks) {
      await callback();
    }

    expect(handlers.size).toBe(0);
  });
});
