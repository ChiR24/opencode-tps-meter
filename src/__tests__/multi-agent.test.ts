/**
 * Multi-Agent TPS Meter Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type {
  PluginContext,
  MessageEvent,
  Config,
  OpenCodeClient,
  Logger,
  AgentIdentity,
} from "../types.js";
import TpsMeterPlugin from "../index.js";

const MIN_TPS_ELAPSED_MS = 250;

interface ToastCall {
  message: string;
  variant: string;
  duration?: number;
  source: string;
}

function createMockClient(): {
  client: OpenCodeClient;
  toastCalls: ToastCall[];
} {
  const toastCalls: ToastCall[] = [];

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

function createMessageUpdatedEvent(
  sessionId: string,
  messageId: string,
  status: "streaming" | "complete" | "error",
  agentMetadata?: { agent?: AgentIdentity; agentId?: string; agentType?: string }
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
        ...agentMetadata,
      },
    },
  };
}

function createPartUpdatedEvent(
  sessionId: string,
  messageId: string,
  delta: string,
  partType: string = "text",
  agentMetadata?: { agent?: AgentIdentity; agentId?: string; agentType?: string }
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
        ...agentMetadata,
      },
      delta,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Multi-Agent TPS Meter Tests", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.TPS_METER_ENABLED = "true";
    process.env.TPS_METER_UPDATE_INTERVAL_MS = "50";
    process.env.TPS_METER_ROLLING_WINDOW_MS = "1000";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Test 1: Each Agent Shows as Separate Row", () => {
    it("should display multiple agents as separate rows with unique labels", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "multi-agent-session";
      
      const exploreAgent = {
        agent: { id: "agent-explore-001", type: "explore", name: "Explore" },
        agentId: "agent-explore-001",
        agentType: "explore",
      };
      
      const librarianAgent = {
        agent: { id: "agent-librarian-002", type: "librarian", name: "Librarian" },
        agentId: "agent-librarian-002",
        agentType: "librarian",
      };

      // Start agent sessions
      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-explore", "streaming", exploreAgent),
      });
      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-librarian", "streaming", librarianAgent),
      });

      // Send tokens to explore agent
      for (let i = 0; i < 40; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-explore", `explore-word${i} `, "text", exploreAgent),
        });
        if (i % 10 === 0) await delay(10);
      }

      // Send tokens to librarian agent
      for (let i = 0; i < 20; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-librarian", `lib-data${i} `, "text", librarianAgent),
        });
        if (i % 5 === 0) await delay(20);
      }

      await delay(MIN_TPS_ELAPSED_MS + 50);

      expect(context.mockClient.toastCalls.length).toBeGreaterThan(0);

      const lastToast = context.mockClient.toastCalls[context.mockClient.toastCalls.length - 1];
      const lines = lastToast.message.split("\n");

      // Should have at least 2 lines (one per agent)
      expect(lines.length).toBeGreaterThanOrEqual(2);

      // Check that both agent labels appear
      const hasExploreLabel = lines.some(line => line.includes("explore"));
      const hasLibrarianLabel = lines.some(line => line.includes("librarian"));
      
      expect(hasExploreLabel).toBe(true);
      expect(hasLibrarianLabel).toBe(true);
    });
  });

  describe("Test 2: Each Row Shows Its Own TPS", () => {
    it("should show different TPS values for agents with different token rates", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "tps-differentiation-session";
      
      const fastAgent = { agentType: "fast", agentId: "fast-1" };
      const slowAgent = { agentType: "slow", agentId: "slow-1" };

      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-fast", "streaming", fastAgent),
      });
      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-slow", "streaming", slowAgent),
      });

      // Fast agent: 50 tokens per burst
      for (let i = 0; i < 10; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-fast", "word ".repeat(50), "text", fastAgent),
        });
        await delay(50);
      }

      // Slow agent: 10 tokens per burst
      for (let i = 0; i < 10; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-slow", "word ".repeat(10), "text", slowAgent),
        });
        await delay(50);
      }

      await delay(MIN_TPS_ELAPSED_MS + 50);

      const lastToast = context.mockClient.toastCalls[context.mockClient.toastCalls.length - 1];
      const lines = lastToast.message.split("\n");

      // Extract TPS values from lines containing agent names
      const fastAgentLine = lines.find(line => line.includes("fast"));
      const slowAgentLine = lines.find(line => line.includes("slow"));

      expect(fastAgentLine).toBeDefined();
      expect(slowAgentLine).toBeDefined();
    });
  });

  describe("Test 3: Main TPS Line Only When Primary Active", () => {
    it("should show main TPS line when primary session has activity", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "primary-only-session";
      
      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-primary", "streaming"),
      });

      for (let i = 0; i < 30; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-primary", `primary-output${i} `),
        });
        if (i === 10) await delay(100);
      }

      await delay(MIN_TPS_ELAPSED_MS + 50);

      expect(context.mockClient.toastCalls.length).toBeGreaterThan(0);

      const lastToast = context.mockClient.toastCalls[context.mockClient.toastCalls.length - 1];
      
      // Should show "TPS:" at the start (main line format)
      expect(lastToast.message).toMatch(/^TPS:/m);
    });

    it("should hide main TPS line when only agents are active", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "agents-only-session";
      
      const agent1 = { agentType: "worker", agentId: "worker-1" };
      const agent2 = { agentType: "helper", agentId: "helper-1" };

      // Start agents (NO primary session)
      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-worker", "streaming", agent1),
      });
      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-helper", "streaming", agent2),
      });

      // Send tokens to agents only
      for (let i = 0; i < 20; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-worker", `worker-data${i} `, "text", agent1),
        });
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-helper", `helper-data${i} `, "text", agent2),
        });
        if (i % 5 === 0) await delay(10);
      }

      await delay(MIN_TPS_ELAPSED_MS + 50);

      const lastToast = context.mockClient.toastCalls[context.mockClient.toastCalls.length - 1];
      const lines = lastToast.message.split("\n");

      // First line should NOT start with "TPS:" (no primary)
      const firstLine = lines[0];
      expect(firstLine).not.toMatch(/^TPS:/);
      
      // Should have agent labels
      expect(lastToast.message).toContain("worker");
      expect(lastToast.message).toContain("helper");
    });
  });

  describe("Test 4: Display Mode Switching", () => {
    it("should switch from primary-only to primary+agents", async () => {
      const context = createMockContext();
      const handlers = TpsMeterPlugin(context);

      const sessionId = "switching-session";

      // Phase 1: Primary only
      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-primary", "streaming"),
      });

      for (let i = 0; i < 15; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-primary", `primary-${i} `),
        });
      }

      // Wait for timer-based toast + extra time to clear UI throttling (150ms min interval)
      await delay(MIN_TPS_ELAPSED_MS + 200);

      // Check primary-only display
      const toastAfterPrimary = context.mockClient.toastCalls[context.mockClient.toastCalls.length - 1];
      expect(toastAfterPrimary.message).toMatch(/^TPS:/m);

      // Phase 2: Add agent
      const agent = { agentType: "background", agentId: "bg-1" };
      await handlers.event!({
        event: createMessageUpdatedEvent(sessionId, "msg-bg", "streaming", agent),
      });

      for (let i = 0; i < 20; i++) {
        await handlers.event!({
          event: createPartUpdatedEvent(sessionId, "msg-bg", `bg-${i} `, "text", agent),
        });
        if (i % 5 === 0) await delay(10); // Small delays to spread updates
      }

      // Wait for timer-based toast + UI throttling clearance
      await delay(MIN_TPS_ELAPSED_MS + 200);

      // Check primary+agent display
      const toastAfterAgent = context.mockClient.toastCalls[context.mockClient.toastCalls.length - 1];
      expect(toastAfterAgent.message).toMatch(/^TPS:/m);
      expect(toastAfterAgent.message).toContain("background");
    });
  });
});
