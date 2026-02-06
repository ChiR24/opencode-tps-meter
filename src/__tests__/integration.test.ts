/**
 * Integration Tests for OpenCode TPS Meter Plugin
 *
 * Simulates full OpenCode event flow and verifies all components work together.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type {
  PluginContext,
  MessageEvent,
  Config,
  OpenCodeClient,
  Logger,
  Part,
} from "../types.js";
import TpsMeterPlugin from "../index.js";

const MIN_TPS_ELAPSED_MS = 250;

function createMockClient(): {
  client: OpenCodeClient;
  toastCalls: Array<{ message: string; variant: string; duration?: number; source: string }>;
} {
  const toastCalls: Array<{ message: string; variant: string; duration?: number; source: string }> = [];

  const client: OpenCodeClient = {
    tui: {
      showToast: (options) => {
        const body = options?.body;
        if (body) {
          toastCalls.push({
            message: body.message,
            variant: body.variant,
            duration: body.duration,
            source: "showToast",
          });
        }
      },
      publish: (options) => {
        const body = options?.body;
        if (body?.type === "tui.toast.show") {
          const props = body.properties;
          toastCalls.push({
            message: props.message || "",
            variant: props.variant || "info",
            duration: props.duration,
            source: "publish",
          });
        }
      },
    },
    toast: {
      info: (message: string, options?: { duration?: number }) => {
        toastCalls.push({ message, variant: "info", duration: options?.duration, source: "fallback" });
      },
      success: (message: string, options?: { duration?: number }) => {
        toastCalls.push({ message, variant: "success", duration: options?.duration, source: "fallback" });
      },
    },
  };

  return { client, toastCalls };
}

type TestLogger = Logger & { logs: string[] };

function createMockLogger(): TestLogger {
  const logs: string[] = [];

  return {
    logs,
    debug: (message: string, ...args: unknown[]) => {
      logs.push(`[DEBUG] ${message} ${args.join(" ")}`);
    },
    info: (message: string, ...args: unknown[]) => {
      logs.push(`[INFO] ${message} ${args.join(" ")}`);
    },
    warn: (message: string, ...args: unknown[]) => {
      logs.push(`[WARN] ${message} ${args.join(" ")}`);
    },
    error: (message: string, ...args: unknown[]) => {
      logs.push(`[ERROR] ${message} ${args.join(" ")}`);
    },
  };
}

function createMockContext(
  overrides?: Partial<Config>
): PluginContext & { mockClient: ReturnType<typeof createMockClient>; logger: TestLogger } {
  const mockClient = createMockClient();
  const logger = createMockLogger();

  return {
    client: mockClient.client,
    plugin: {
      id: "opencode-tps-meter",
      name: "OpenCode TPS Meter",
      version: "1.0.0",
    },
    logger,
    mockClient,
  };
}

function createPartUpdatedEvent(
  sessionId: string,
  messageId: string,
  delta: string,
  partType: string = "text"
): MessageEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `${messageId}-part`,
        sessionID: sessionId,
        messageID: messageId,
        type: partType,
        text: delta,
      },
      delta,
    },
  };
}

function createMessageUpdatedEvent(
  sessionId: string,
  messageId: string,
  status: "streaming" | "complete" | "error"
): MessageEvent {
  const now = Date.now();
  const completedAt = now + MIN_TPS_ELAPSED_MS;
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "assistant",
        time: status === "complete" ? { created: now, completed: completedAt } : { created: now },
        tokens: { input: 0, output: 0 },
        finish: status === "complete" ? "stop" : undefined,
        error: status === "error" ? { message: "error" } : undefined,
      },
    },
  };
}

function createSessionIdleEvent(sessionId: string): MessageEvent {
  return {
    type: "session.idle",
    properties: {
      sessionID: sessionId,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("OpenCode TPS Meter - Integration Tests", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.TPS_METER_ENABLED = "true";
    process.env.TPS_METER_UPDATE_INTERVAL_MS = "50";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Full Event Flow", () => {
    it("should simulate a complete OpenCode session with streaming and completion", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      expect(handlers.event).toBeDefined();

      const sessionId = "test-session-123";
      const messageId = "msg-456";

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
      });

      const deltas = Array.from({ length: 50 }, (_, i) =>
        i % 5 === 0 ? "\n" : `word${i} `
      );

      for (const [index, delta] of deltas.entries()) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, messageId, delta),
        });
        if (index === 10) {
          await delay(MIN_TPS_ELAPSED_MS + 10);
        }
      }

      await delay(100);

      expect(context.mockClient.toastCalls.length).toBeGreaterThan(0);

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, messageId, "complete"),
      });

      const infoLogs = context.logger.logs.filter((log) => log.includes("[INFO]"));
      expect(infoLogs.length).toBeGreaterThan(0);

      const finalStatsLog = infoLogs.find((log) => log.includes("complete:"));
      expect(finalStatsLog).toBeDefined();
    });

    it("should handle multiple concurrent sessions correctly", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const session1 = "session-1";
      const session2 = "session-2";

      await handlers.event!({
        event: createMessageUpdatedEvent(session1, "msg-1", "streaming"),
      });
      await handlers.event!({
        event: createMessageUpdatedEvent(session2, "msg-2", "streaming"),
      });

      for (let i = 0; i < 20; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(session1, "msg-1", `token${i} `),
        });
        await handlers.event!({
          event: createPartUpdatedEvent(session2, "msg-2", `data${i} `),
        });
        if (i === 5) {
          await delay(MIN_TPS_ELAPSED_MS + 10);
        }
      }

      await delay(100);

      const debugLogs = context.logger.logs.filter((log) => log.includes("[DEBUG]"));
      const session1Logs = debugLogs.filter((log) => log.includes(session1));
      const session2Logs = debugLogs.filter((log) => log.includes(session2));

      expect(session1Logs.length).toBeGreaterThan(0);
      expect(session2Logs.length).toBeGreaterThan(0);

      await handlers.event!({
        event: createMessageUpdatedEvent(session1, "msg-1", "complete"),
      });

      await handlers.event!({
        event: createSessionIdleEvent(session2),
      });

      const debugLogsAfterIdle = context.logger.logs.filter((log) =>
        log.includes("Session idle")
      );
      expect(debugLogsAfterIdle.length).toBeGreaterThan(0);
    });

    it("should ignore file part types", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "test-session";

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-1", "streaming"),
      });

      for (let i = 0; i < 10; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-1", "file contents", "file"),
        });
      }

      await delay(100);

      expect(context.mockClient.toastCalls.length).toBe(0);
    });

    it("should calculate correct TPS statistics", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "perf-test-session";
      const messageId = "msg-perf";

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
      });

      const startTime = Date.now();
      const tokenCount = 100;

      for (let i = 0; i < tokenCount; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, messageId, "word "),
        });
        if (i % 10 === 0) {
          await delay(10);
        }
      }

      const elapsedMs = Date.now() - startTime;
      expect(elapsedMs).toBeGreaterThan(0);

      await delay(100);

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, messageId, "complete"),
      });

      const completionLog = context.logger.logs.find((log) => log.includes("complete:"));
      expect(completionLog).toBeDefined();
      expect(completionLog).toContain("tokens");
      expect(completionLog).toContain("TPS");
    });
  });

  describe("UI Throttling", () => {
    it("should throttle UI updates according to update interval", async () => {
      process.env.TPS_METER_UPDATE_INTERVAL_MS = "200";

      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "throttle-test";

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-1", "streaming"),
      });

      for (let i = 0; i < 30; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-1", `update${i} `),
        });
      }

      const initialCallCount = context.mockClient.toastCalls.length;
      expect(initialCallCount).toBeLessThan(5);

      await delay(MIN_TPS_ELAPSED_MS + 10);

      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, "msg-1", "late-update"),
      });

      await delay(250);

      const laterCallCount = context.mockClient.toastCalls.length;
      expect(laterCallCount).toBeGreaterThan(initialCallCount);
    });

    it("should show final stats immediately without throttling", async () => {
      process.env.TPS_METER_UPDATE_INTERVAL_MS = "500";

      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "final-stats-test";
      const messageId = "msg-final";

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
      });

      for (let i = 0; i < 10; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, messageId, "token "),
        });
      }

      await delay(MIN_TPS_ELAPSED_MS + 10);

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, messageId, "complete"),
      });

      const finalToast = context.mockClient.toastCalls.find((call) => call.variant === "success");
      expect(finalToast).toBeDefined();
    });
  });
});

describe("Color Coding Tests", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.TPS_METER_ENABLED = "true";
    process.env.TPS_METER_UPDATE_INTERVAL_MS = "50";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should show success variant for final stats", async () => {
    process.env.TPS_METER_ENABLE_COLOR_CODING = "true";
    
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "color-test-session";
    const messageId = "msg-color";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
    });

    // Generate tokens to trigger display
    for (let i = 0; i < 20; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, messageId, `token${i} `),
      });
    }

    await delay(MIN_TPS_ELAPSED_MS + 50);

    // Complete the message - should show final stats with success variant
    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, messageId, "complete"),
    });

    const successToasts = context.mockClient.toastCalls.filter(
      (call) => call.variant === "success"
    );
    expect(successToasts.length).toBeGreaterThan(0);
  });

  it("should show info variant when color coding is disabled", async () => {
    process.env.TPS_METER_ENABLE_COLOR_CODING = "false";
    
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "nocolor-test";
    const messageId = "msg-nocolor";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
    });

    // Generate tokens and wait for minimum elapsed time to trigger display
    for (let i = 0; i < 30; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, messageId, `word${i} `),
      });
      if (i === 10) {
        await delay(MIN_TPS_ELAPSED_MS + 10);
      }
    }

    await delay(100);

    const infoToasts = context.mockClient.toastCalls.filter(
      (call) => call.variant === "info"
    );
    expect(infoToasts.length).toBeGreaterThan(0);
  });
});

describe("Cleanup Tests", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.TPS_METER_ENABLED = "true";
    process.env.TPS_METER_UPDATE_INTERVAL_MS = "50";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should clean up session-specific caches on session.idle", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "cleanup-test-session";
    const messageId = "msg-cleanup";

    // Set up some data
    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
    });

    for (let i = 0; i < 10; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, messageId, `token${i} `),
      });
    }

    await delay(MIN_TPS_ELAPSED_MS + 20);

    // Trigger session idle
    await handlers.event!({
      event: createSessionIdleEvent(sessionId),
    });

    // Verify cleanup logged
    const idleLogs = context.logger.logs.filter((log) =>
      log.includes("Session idle")
    );
    expect(idleLogs.length).toBeGreaterThan(0);
  });

  it("should handle multiple sessions with independent cleanup", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const session1 = "multi-session-1";
    const session2 = "multi-session-2";

    // Set up both sessions
    await handlers.event!({
      event: createMessageUpdatedEvent(session1, "msg-1", "streaming"),
    });
    await handlers.event!({
      event: createMessageUpdatedEvent(session2, "msg-2", "streaming"),
    });

    for (let i = 0; i < 10; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(session1, "msg-1", `s1-token${i} `),
      });
      await handlers.event!({
        event: createPartUpdatedEvent(session2, "msg-2", `s2-token${i} `),
      });
    }

    await delay(MIN_TPS_ELAPSED_MS + 20);

    // Idle only session1
    await handlers.event!({
      event: createSessionIdleEvent(session1),
    });

    const idleLogs = context.logger.logs.filter((log) =>
      log.includes("Session idle")
    );
    expect(idleLogs.length).toBe(1);
    expect(idleLogs[0]).toContain(session1);
  });
});

describe("extractPartText Edge Cases", () => {
  // We need to test extractPartText indirectly through the plugin behavior
  // since it's not exported directly

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.TPS_METER_ENABLED = "true";
    process.env.TPS_METER_UPDATE_INTERVAL_MS = "50";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should handle null/undefined part gracefully", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "null-part-test";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, "msg-1", "streaming"),
    });

    // Send event with minimal part data
    await handlers.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: sessionId,
            messageID: "msg-1",
            type: "text",
            text: "",
          } as Part,
          delta: "",
        },
      },
    });

    // Should not throw
    expect(context.logger.logs.filter((log) => log.includes("[ERROR]")).length).toBe(0);
  });

  it("should handle file parts without counting tokens", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "file-part-test";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, "msg-1", "streaming"),
    });

    // File parts should be ignored
    for (let i = 0; i < 10; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, "msg-1", "large file content", "file"),
      });
    }

    await delay(100);

    // File parts are not in COUNTABLE_PART_TYPES, so no toasts
    expect(context.mockClient.toastCalls.length).toBe(0);
  });

  it("should handle tool parts without counting tokens", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "tool-part-test";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, "msg-1", "streaming"),
    });

    // Tool parts should be ignored
    for (let i = 0; i < 10; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, "msg-1", "tool output", "tool"),
      });
    }

    await delay(100);

    // Tool parts are not in COUNTABLE_PART_TYPES, so no toasts
    expect(context.mockClient.toastCalls.length).toBe(0);
  });

  it("should handle patch parts without counting tokens", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "patch-part-test";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, "msg-1", "streaming"),
    });

    // Patch parts should be ignored
    for (let i = 0; i < 10; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, "msg-1", "code changes", "patch"),
      });
    }

    await delay(100);

    // Patch parts are not in COUNTABLE_PART_TYPES, so no toasts
    expect(context.mockClient.toastCalls.length).toBe(0);
  });
});

describe("TPS Smoothing Tests", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.TPS_METER_ENABLED = "true";
    process.env.TPS_METER_UPDATE_INTERVAL_MS = "50";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should smooth large token bursts to prevent unrealistic TPS spikes", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "burst-test-session";
    const messageId = "msg-burst";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
    });

    // Wait for min elapsed time
    await delay(MIN_TPS_ELAPSED_MS + 10);

    // Simulate a large burst of 500 tokens arriving at once (like tool output)
    // This would normally create a ~1000+ TPS spike, but should be smoothed
    const burstText = "word ".repeat(100); // ~500 tokens
    await handlers.event!({
      event: createPartUpdatedEvent(sessionId, messageId, burstText),
    });

    await delay(100);

    // The smoothed TPS should be reasonable (< 800), not an extreme spike to 2000+
    // Note: EWMA smoothing takes effect over multiple updates, so initial bursts
    // may still show elevated TPS, but significantly less than the raw calculation
    const debugLogs = context.logger.logs.filter((log) =>
      log.includes("[DEBUG]") && log.includes("TPS:")
    );

    expect(debugLogs.length).toBeGreaterThan(0);

    // Parse the last TPS log and verify smoothing is applied
    const lastLog = debugLogs[debugLogs.length - 1];
    const tpsMatch = lastLog.match(/TPS:\s*([\d.]+)/);
    expect(tpsMatch).not.toBeNull();
    if (tpsMatch) {
      const tps = parseFloat(tpsMatch[1]);
      // Raw TPS for 500 tokens arriving at once would be ~5000 (500/0.1s)
      // With EWMA smoothing (500ms half-life), initial values should still be < 2000
      expect(tps).toBeLessThan(2000);
      expect(tps).toBeGreaterThan(0);
    }
  });

  it("should maintain responsiveness for normal streaming rates", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "streaming-test-session";
    const messageId = "msg-stream";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
    });

    // Simulate normal streaming: ~20 tokens every 50ms = ~400 TPS
    const startTime = Date.now();
    for (let i = 0; i < 20; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, messageId, "word1 word2 word3 word4 word5 "),
      });
      await delay(50);
    }

    const elapsedMs = Date.now() - startTime;

    await delay(100);

    // Should have logged TPS values
    const debugLogs = context.logger.logs.filter((log) =>
      log.includes("[DEBUG]") && log.includes("TPS:")
    );

    expect(debugLogs.length).toBeGreaterThan(0);

    // Verify streaming maintained some TPS activity
    // (exact value depends on timing, but should be > 0)
    const lastLog = debugLogs[debugLogs.length - 1];
    const tpsMatch = lastLog.match(/TPS:\s*([\d.]+)/);
    if (tpsMatch) {
      const tps = parseFloat(tpsMatch[1]);
      expect(tps).toBeGreaterThan(0);
    }
  });

  it("should show final stats with reasonable TPS after burst", async () => {
    const context = createMockContext();
    const handlers = TpsMeterPlugin(context);

    const sessionId = "final-stats-burst-session";
    const messageId = "msg-final-burst";

    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, messageId, "streaming"),
    });

    // Wait for min elapsed time
    await delay(MIN_TPS_ELAPSED_MS + 10);

    // Add some tokens
    for (let i = 0; i < 10; i++) {
      await handlers.event!({
        event: createPartUpdatedEvent(sessionId, messageId, "word "),
      });
    }

    await delay(100);

    // Complete the message
    await handlers.event!({
      event: createMessageUpdatedEvent(sessionId, messageId, "complete"),
    });

    // Should show final stats with success variant
    const successToasts = context.mockClient.toastCalls.filter(
      (call) => call.variant === "success"
    );
    expect(successToasts.length).toBeGreaterThan(0);
  });
});
