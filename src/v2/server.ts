/**
 * OpenCode v2 server plugin entry.
 *
 * Scope note: unlike v1, the v2 server context exposes no UI surface — there is no
 * `client`, no toast API, and no way to publish TUI events from a server plugin. The
 * meter therefore renders exclusively from the v2 TUI entry (src/v2/tui.tsx); this entry
 * exists so the package registers cleanly under v2's `plugins` array, and so measurements
 * only reachable below the streaming pipeline are available to embedders and tests.
 *
 * The v1 `toastFallback` option has no effect here.
 *
 * @module v2/server
 */

import { defaultConfig, loadConfigSync } from "../config.js";
import type { Config } from "../types.js";
import { createMeter, type V2Meter, type V2Snapshot } from "./meter.js";
import type {
  V2Cleanup,
  V2HttpHookInput,
  V2PluginDefinition,
  V2ServerContext,
  V2UnknownEvent,
} from "./types.js";

/** Snapshots tracked by the most recent server setup, for embedders and tests. */
let activeMeter: V2Meter | null = null;

/**
 * Wire-level latency per session.
 *
 * This is strictly below what the TUI can see. `session.text.delta` timing includes the
 * provider's queueing plus OpenCode's own streaming pipeline; the HTTP hooks measure the
 * request-dispatch to response-headers gap directly, which is the true network + queue
 * cost. v1 had no equivalent hook.
 */
export interface WireTiming {
  /** Milliseconds from provider request dispatch to response headers. */
  ttfbMs: number;
  /** Requests measured this session. */
  samples: number;
  providerID?: string;
}

const wireTimings = new Map<string, WireTiming>();

/** Current per-session readings, or an empty map when the plugin is not running. */
export function getSnapshots(): ReadonlyMap<string, V2Snapshot> {
  return activeMeter?.getSnapshots() ?? new Map<string, V2Snapshot>();
}

/**
 * Wire-level timings observed by the server half.
 *
 * NOTE: server and TUI are separate processes with no shared memory, so these numbers
 * cannot reach the on-screen meter as things stand. They are exposed for embedders and for
 * the day a plugin-owned channel between the two halves exists.
 */
export function getWireTimings(): ReadonlyMap<string, WireTiming> {
  return wireTimings;
}

function loadServerConfig(options?: Readonly<Record<string, unknown>>): Config {
  try {
    return loadConfigSync(options as Partial<Config> | undefined);
  } catch {
    return defaultConfig;
  }
}

/**
 * v2 server setup. Returns a cleanup function; v2 calls it on disable, reload, and shutdown.
 */
export function setupServer(ctx: V2ServerContext): V2Cleanup | void {
  const config = loadServerConfig(ctx.options);
  if (!config.enabled) {
    return;
  }

  const meter = createMeter(config);
  activeMeter = meter;

  // v2 delivers events as an async iterable rather than v1's callback hook, so the
  // stream is drained on its own task and stopped via AbortSignal on cleanup.
  const controller = new AbortController();

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) {
          break;
        }
        meter.handleEvent(event as V2UnknownEvent);
      }
    } catch {
      // Stream ended or was aborted during shutdown; nothing to recover.
    }
  })();

  // Wire-level TTFB. Both hook bodies are one-shot streams — reading either would consume
  // the payload out from under the provider — so only timestamps are taken here.
  const dispatchedAt = new Map<string, number>();

  if (ctx.session?.hook) {
    try {
      ctx.session.hook("http.request", (input: V2HttpHookInput) => {
        const sessionID = input?.sessionID;
        if (typeof sessionID === "string" && sessionID.length > 0) {
          dispatchedAt.set(sessionID, Date.now());
        }
      });

      ctx.session.hook("http.response", (input: V2HttpHookInput) => {
        const sessionID = input?.sessionID;
        if (typeof sessionID !== "string" || sessionID.length === 0) {
          return;
        }
        const started = dispatchedAt.get(sessionID);
        if (started === undefined) {
          return;
        }
        dispatchedAt.delete(sessionID);

        const elapsed = Date.now() - started;
        if (elapsed < 0) {
          return;
        }
        const existing = wireTimings.get(sessionID);
        if (!existing) {
          wireTimings.set(sessionID, {
            ttfbMs: elapsed,
            samples: 1,
            providerID: input?.providerID,
          });
          return;
        }
        wireTimings.set(sessionID, {
          ttfbMs: (existing.ttfbMs * existing.samples + elapsed) / (existing.samples + 1),
          samples: existing.samples + 1,
          providerID: input?.providerID ?? existing.providerID,
        });
      });
    } catch {
      // The hook API is beta; a signature change must not take the whole plugin down.
    }
  }

  return () => {
    controller.abort();
    meter.dispose();
    dispatchedAt.clear();
    wireTimings.clear();
    if (activeMeter === meter) {
      activeMeter = null;
    }
  };
}

/** v2 server plugin definition. Structurally what `Plugin.define` from `@opencode-ai/plugin` returns. */
export const v2ServerPlugin: V2PluginDefinition<V2ServerContext> = {
  id: "opencode-tps-meter",
  setup: setupServer,
};

export default v2ServerPlugin;
