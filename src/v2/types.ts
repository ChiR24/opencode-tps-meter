/**
 * Structural type definitions for the OpenCode v2 (`opencode2`) plugin surface.
 *
 * These mirror `@opencode-ai/plugin@next` (verified against 0.0.0-next-17293) but are
 * declared locally on purpose:
 *
 * - v1 and v2 types ship under the same package name, so both cannot be installed at once
 *   while this package still supports v1.
 * - The v2 API is beta and explicitly documented as subject to change; structural types keep
 *   a churning upstream from breaking our build.
 *
 * Only the members this plugin actually consumes are declared.
 *
 * @module v2/types
 */

import type { RGBA } from "@opentui/core";

/** Workspace/directory a v2 event originated from. */
export interface V2LocationRef {
  directory: string;
  workspaceID?: string;
}

/** Common envelope shared by every v2 event. */
export interface V2Envelope<Type extends string, Data> {
  id: string;
  created: number;
  type: Type;
  location?: V2LocationRef;
  data: Data;
}

/** Provider-reported token usage, attached to step and usage events. */
export interface V2TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

/**
 * Finish reasons reported by `session.step.ended`.
 * Same vocabulary as v1's `message.updated` `info.finish`, so the existing
 * INVALID_FINISH_REASONS / TOOL_CALL_FINISH_REASON constants apply unchanged.
 */
export type V2FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "unknown";

/** Streaming assistant text chunk. Replaces v1 `message.part.delta` (field === "text"). */
export type V2SessionTextDelta = V2Envelope<
  "session.text.delta",
  {
    sessionID: string;
    assistantMessageID: string;
    ordinal: number;
    delta: string;
  }
>;

/** Streaming assistant reasoning chunk. */
export type V2SessionReasoningDelta = V2Envelope<
  "session.reasoning.delta",
  {
    sessionID: string;
    assistantMessageID: string;
    ordinal: number;
    delta: string;
  }
>;

/** A model step finished. Replaces v1 `message.updated` with `info.time.completed`. */
export type V2SessionStepEnded = V2Envelope<
  "session.step.ended",
  {
    sessionID: string;
    assistantMessageID: string;
    finish: V2FinishReason;
    cost: number;
    tokens: V2TokenUsage;
  }
>;

/** Cumulative session usage. Used as a fallback when a step reports no tokens. */
export type V2SessionUsageUpdated = V2Envelope<
  "session.usage.updated",
  {
    sessionID: string;
    cost: number;
    tokens: V2TokenUsage;
  }
>;

/** Session went idle. Carried over from v1 unchanged. */
export type V2SessionIdle = V2Envelope<"session.idle", { sessionID: string }>;

/** Union of every event this plugin subscribes to. */
export type V2MeterEvent =
  | V2SessionTextDelta
  | V2SessionReasoningDelta
  | V2SessionStepEnded
  | V2SessionUsageUpdated
  | V2SessionIdle;

/** Any v2 event; narrowed to V2MeterEvent before use. */
export interface V2UnknownEvent {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// =============================================================================
// Server plugin context (`@opencode-ai/plugin`)
// =============================================================================

/**
 * v2 server plugin context.
 *
 * Note `event.subscribe()` returns an AsyncIterable, not a callback registration —
 * a deliberate difference from both v1's `event` hook and v2's TUI `data.on`.
 */
export interface V2ServerContext {
  readonly app?: {
    readonly name: string;
    readonly version: string;
    readonly channel: string;
  };
  readonly options?: Readonly<Record<string, unknown>>;
  readonly event: {
    readonly subscribe: (
      requestOptions?: { signal?: AbortSignal }
    ) => AsyncIterable<V2UnknownEvent>;
  };
  /**
   * Provider-dispatch hooks. `http.response` fires when response HEADERS arrive, which is
   * the only place a true wire-level time-to-first-byte can be measured — it sits below the
   * streaming pipeline the TUI observes. v1 exposed nothing comparable.
   */
  readonly session?: {
    readonly hook: (
      name: "http.request" | "http.response",
      callback: (input: V2HttpHookInput) => void | Promise<void>
    ) => unknown;
  };
}

/** Payload handed to the provider HTTP hooks. */
export interface V2HttpHookInput {
  readonly sessionID?: string;
  readonly providerID?: string;
  /** Present on http.request. Body is a one-shot stream: never read it here. */
  readonly request?: unknown;
  /** Present on http.response. Body is a one-shot stream: never read it here. */
  readonly response?: unknown;
}

/** Cleanup returned from a v2 `setup` function. */
export type V2Cleanup = () => Promise<void> | void;

/** Shape both v2 server and v2 TUI plugin modules must satisfy. */
export interface V2PluginDefinition<Context> {
  readonly id: string;
  readonly setup: (context: Context) => Promise<V2Cleanup | void> | V2Cleanup | void;
}

// =============================================================================
// TUI plugin context (`@opencode-ai/plugin/tui`)
// =============================================================================

/** An `@opentui/core` RGBA colour value. v2 theme tokens resolve to these. */
export type V2Rgba = RGBA;

/** Resolved theme token subset used by the meter. Replaces v1's flat `theme.current`. */
export interface V2ResolvedTheme {
  readonly text: {
    readonly default: V2Rgba;
    readonly subdued: V2Rgba;
    readonly feedback: Readonly<
      Record<"error" | "warning" | "success" | "info", { readonly default: V2Rgba }>
    >;
  };
}

/** Reactive props published by the `prompt.footer.*` slots. */
export interface V2PromptFooterInput {
  readonly sessionID?: string;
  readonly mode: "normal" | "shell";
}

/**
 * Slot paths published by the v2 TUI host.
 * v1's `session_prompt_right` has no direct successor; `prompt.footer.status` is the
 * status region beside the prompt and is the closest equivalent.
 */
export type V2SlotPath =
  | "app"
  | "home.footer"
  | "prompt.footer"
  | "prompt.footer.status"
  | "prompt.footer.file"
  | "session.composer.top"
  | "sidebar.content"
  | "sidebar.footer";

/**
 * Reactive input a slot publishes. Paths differ in what they carry: `prompt.footer.*` gives
 * an optional sessionID plus the prompt mode, while `sidebar.content` gives a required
 * sessionID and no mode. The union covers both.
 */
export interface V2SlotInput {
  readonly sessionID?: string;
  readonly mode?: "normal" | "shell";
}

/** One contribution to the v2 slot tree. */
export interface V2SlotClaim {
  readonly render: (input: V2SlotInput) => unknown;
  readonly append?: V2SlotPath;
  readonly prepend?: V2SlotPath;
  readonly before?: V2SlotPath;
  readonly after?: V2SlotPath;
  readonly replace?: V2SlotPath;
}

/** A command contributed to the palette, slash completion, and keybindings. */
export interface V2KeymapCommand {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly group?: string;
  readonly palette?: true;
  readonly slash?: {
    readonly name: string;
    readonly aliases?: string[];
    readonly arguments?: true;
  };
  readonly bind?: false | string;
  readonly enabled?: boolean | (() => boolean);
  readonly run: (input?: string) => void | false | Promise<void>;
}

/** A reactive keymap layer. Must be registered from inside a reactive owner. */
export interface V2KeymapLayer {
  readonly mode?: string;
  readonly enabled?: boolean | (() => boolean);
  readonly priority?: number;
  readonly commands?: readonly V2KeymapCommand[];
  readonly bindings?: readonly string[];
}

export type V2ToastVariant = "info" | "success" | "warning" | "error";

/** v2 TUI plugin context. */
export interface V2TuiContext {
  readonly options?: Readonly<Record<string, unknown>>;
  readonly theme: V2ResolvedTheme;
  readonly data: {
    readonly on: <Type extends V2AnyMeterEvent["type"]>(
      type: Type,
      handler: (event: Extract<V2AnyMeterEvent, { type: Type }>) => void
    ) => () => void;
    /** Synced session metadata. Replaces v1's parentID-sniffing for subagent attribution. */
    readonly session?: V2SessionData;
  };
  readonly ui: {
    readonly slot: (claim: V2SlotClaim) => () => void;
    readonly router?: V2Router;
    readonly toast?: {
      readonly show: (options: {
        readonly title?: string;
        readonly message: string;
        readonly variant?: V2ToastVariant;
        readonly duration?: number;
      }) => void;
    };
  };
  /**
   * Reactive keymap. `layer` is owned by the calling component, so it must be invoked from
   * inside a rendered component rather than from bare `setup`.
   */
  readonly keymap?: {
    readonly layer: (input: () => V2KeymapLayer) => void;
  };
  /** Durable + ephemeral plugin state. No v1 equivalent. */
  readonly storage?: V2Storage;
}

// =============================================================================
// Extended surface (Tier 2/3): attribution, turn decomposition, storage, routing
// =============================================================================

/** Model reference carried by step and selection events. */
export interface V2ModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/**
 * A model step began.
 *
 * Carries the agent and model that produced the step — v1's StepStartPart carried neither,
 * which is why v1 could not attribute throughput to a model or agent.
 */
export type V2SessionStepStarted = V2Envelope<
  "session.step.started",
  {
    sessionID: string;
    assistantMessageID: string;
    agent?: string;
    model?: V2ModelRef;
  }
>;

/** The model began generating a tool call's arguments. */
export type V2SessionToolInputStarted = V2Envelope<
  "session.tool.input.started",
  { sessionID: string; assistantMessageID?: string; id: string; name?: string }
>;

/** Tool execution began (host stamps time.ran from this event's `created`). */
export type V2SessionToolCalled = V2Envelope<
  "session.tool.called",
  { sessionID: string; id: string; name?: string; executed?: boolean }
>;

/** Tool execution ended, successfully or not. */
export type V2SessionToolSettled = V2Envelope<
  "session.tool.success" | "session.tool.failed",
  { sessionID: string; id: string; name?: string }
>;

/** A turn began — the user's prompt was admitted and work started. */
export type V2SessionExecutionStarted = V2Envelope<
  "session.execution.started",
  { sessionID: string }
>;

/** A turn ended. `interrupted` marks an aborted turn, whose numbers must not be trusted. */
export type V2SessionExecutionSettled = V2Envelope<
  "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted",
  { sessionID: string; reason?: string; error?: { message?: string } }
>;

/** Extended union the meter consumes for Tier 2 metrics. */
export type V2ExtendedEvent =
  | V2SessionStepStarted
  | V2SessionToolInputStarted
  | V2SessionToolCalled
  | V2SessionToolSettled
  | V2SessionExecutionStarted
  | V2SessionExecutionSettled;

/** Everything the meter subscribes to. */
export type V2AnyMeterEvent = V2MeterEvent | V2ExtendedEvent;

// ---------------------------------------------------------------- TUI extras

/** Solid store tuple returned by both storage tiers. */
export type V2StoreHandle<Value extends object> = readonly [
  Value,
  (mutation: (draft: Value) => void) => unknown,
];

/**
 * Durable and ephemeral plugin state.
 *
 * `store` persists to disk under a cross-process lock and live-syncs to every running TUI;
 * `memory` is synchronous and survives hot reload. v1 had neither — its TUI KV is documented
 * as unsupported in v2 — so a v1 plugin loses all state when the TUI exits.
 */
export interface V2Storage {
  readonly store: <Value extends object>(
    key: string,
    options: { readonly initial: Value }
  ) => V2StoreHandle<Value>;
  readonly memory: <Value extends object>(
    key: string,
    options: { readonly initial: Value }
  ) => V2StoreHandle<Value>;
}

/** Session metadata exposed to the TUI. */
export interface V2SessionInfo {
  readonly id?: string;
  readonly parentID?: string;
  readonly title?: string;
  readonly agent?: string;
  readonly model?: V2ModelRef;
}

/** Read side of the TUI's synced data store. */
export interface V2SessionData {
  readonly get: (sessionID: string) => V2SessionInfo | undefined;
  readonly root: (sessionID: string) => string;
  readonly family: (sessionID: string) => string[];
  readonly cost: (sessionID: string) => number;
  readonly status: (sessionID: string) => "idle" | "running";
}

/** A page contributed to the TUI router. */
export interface V2Page {
  readonly name: string;
  readonly render: (input: { readonly data?: Record<string, unknown> }) => unknown;
}

export interface V2Router {
  readonly register: (page: V2Page) => () => void;
  readonly navigate: (destination: Record<string, unknown>) => void;
  readonly current: () => { readonly type: string; readonly sessionID?: string };
}
