/**
 * OpenCode v2 TUI plugin — the persistent TPS meter for `opencode2`.
 *
 * Differences from the v1 TUI entry (src/tui.tsx):
 *
 *   v1 `{ id, tui(api, options, meta) }`   -> v2 `{ id, setup(ctx) }`
 *   v1 `api.slots.register({ slots })`     -> v2 `ctx.ui.slot(claim)`
 *   v1 slot `session_prompt_right`         -> v2 `prompt.footer.status`
 *   v1 `props.session_id` (required)       -> v2 `input.sessionID` (optional)
 *   v1 `api.event.on`                      -> v2 `ctx.data.on`
 *   v1 `api.theme.current.<token>`         -> v2 `ctx.theme.text.<token>`
 *   v1 `api.lifecycle.onDispose(fn)`       -> v2 return cleanup from `setup`
 *
 * Surfaces beyond v1's single status string: a sidebar panel breaking throughput down per
 * subagent, a full-screen dashboard over the durable ledger, and palette/slash commands.
 *
 * @module v2/tui
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import { defaultConfig, loadConfigSync } from "../config.js";
import { formatMeterText } from "../format.js";
import type { Config } from "../types.js";
import { createMeter, type V2Snapshot } from "./meter.js";
import { createLedger, type V2Ledger } from "./ledger.js";
import type {
  V2AnyMeterEvent,
  V2Cleanup,
  V2KeymapLayer,
  V2PluginDefinition,
  V2ResolvedTheme,
  V2Rgba,
  V2SlotInput,
  V2TuiContext,
  V2UnknownEvent,
} from "./types.js";

/** Events the TUI plugin subscribes to. */
const SUBSCRIBED_EVENTS: ReadonlyArray<V2AnyMeterEvent["type"]> = [
  "session.text.delta",
  "session.reasoning.delta",
  "session.step.ended",
  "session.usage.updated",
  "session.idle",
  "session.step.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
];

/** How much the footer meter shows. Cycled by the `/tps` command. */
type DisplayMode = "compact" | "detailed" | "hidden";

const MODE_ORDER: readonly DisplayMode[] = ["compact", "detailed", "hidden"];

/** Route name for the dashboard page. */
const DASHBOARD_ROUTE = "tps";

function loadTuiConfig(options?: Readonly<Record<string, unknown>>): Config {
  try {
    return loadConfigSync(options as Partial<Config> | undefined);
  } catch {
    return defaultConfig;
  }
}

function tps(value: number): string {
  return value.toFixed(1);
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/**
 * Maps a reading onto v2's nested theme tokens.
 * v1's flat `error`/`warning`/`success` moved under `text.feedback.<kind>.default`,
 * and `textMuted` became `text.subdued`.
 */
function colorForSnapshot(
  theme: V2ResolvedTheme,
  config: Config,
  snapshot: V2Snapshot
): V2Rgba {
  if (!snapshot.active) {
    return theme.text.subdued;
  }
  if (!config.enableColorCoding) {
    return theme.text.default;
  }
  if (snapshot.instantTps < config.slowTpsThreshold) {
    return theme.text.feedback.error.default;
  }
  if (snapshot.instantTps > config.fastTpsThreshold) {
    return theme.text.feedback.success.default;
  }
  return theme.text.feedback.warning.default;
}

function MeterView(props: {
  input: V2SlotInput;
  theme: V2ResolvedTheme;
  config: Config;
  mode: () => DisplayMode;
  snapshots: () => ReadonlyMap<string, V2Snapshot>;
}) {
  // sessionID is optional in v2 — the footer also renders on surfaces with no session.
  const current = createMemo(() => {
    if (props.mode() === "hidden") {
      return undefined;
    }
    const sessionID = props.input.sessionID;
    return sessionID ? props.snapshots().get(sessionID) : undefined;
  });

  const line = createMemo(() => {
    const snapshot = current();
    if (!snapshot) {
      return "";
    }
    const base = formatMeterText(snapshot, props.config);
    if (props.mode() !== "detailed") {
      return base;
    }
    const extra: string[] = [];
    // generationTps only differs from the headline once tool time has been subtracted.
    if (snapshot.toolMs > 0) {
      extra.push(`gen ${tps(snapshot.generationTps)}`);
    }
    if (snapshot.ttftMs > 0) {
      extra.push(`ttft ${ms(snapshot.ttftMs)}`);
    }
    if (snapshot.overheadTokens > 0) {
      extra.push(`+${snapshot.overheadTokens} ovh`);
    }
    if (snapshot.interrupted) {
      extra.push("aborted");
    }
    return extra.length > 0 ? `${base} · ${extra.join(" · ")}` : base;
  });

  return (
    <Show when={current()} fallback={<box flexShrink={0} />}>
      {(snapshot) => (
        <box flexDirection="row" flexShrink={0}>
          <text fg={colorForSnapshot(props.theme, props.config, snapshot())}>{line()}</text>
        </box>
      )}
    </Show>
  );
}

interface FamilyRow {
  id: string;
  label: string;
  isRoot: boolean;
  running: boolean;
  tps: number;
  tokens: number;
}

/**
 * Per-subagent throughput, rendered in the session sidebar.
 *
 * v1 had to guess at subagent relationships by comparing session IDs against a heuristically
 * chosen "primary" session (see src/index.ts). v2 exposes the real tree via
 * `ctx.data.session.root` / `.family`, so attribution is exact rather than inferred.
 */
function SidebarPanel(props: {
  input: V2SlotInput;
  ctx: V2TuiContext;
  theme: V2ResolvedTheme;
  snapshots: () => ReadonlyMap<string, V2Snapshot>;
}) {
  // Split deliberately: the session tree and each agent's name change rarely, while
  // snapshots change on every token publish (up to ~125/s). Resolving the family inside the
  // snapshot-dependent memo re-ran root/family/get for every row on every publish.
  const family = createMemo<Array<{ id: string; label: string; isRoot: boolean }>>(() => {
    const data = props.ctx.data.session;
    const sessionID = props.input.sessionID;
    if (!data || !sessionID) {
      return [];
    }
    let rootID: string;
    let ids: string[];
    try {
      rootID = data.root(sessionID);
      ids = data.family(rootID) ?? [];
    } catch {
      return [];
    }
    // A solo session is already covered by the footer meter; only show the breakdown
    // once work has actually fanned out.
    if (ids.length <= 1) {
      return [];
    }
    return ids.map((id) => ({
      id,
      label: data.get(id)?.agent ?? (id === rootID ? "main" : id.slice(-6)),
      isRoot: id === rootID,
    }));
  });

  const rows = createMemo<FamilyRow[]>(() => {
    const members = family();
    if (members.length === 0) {
      return [];
    }
    const data = props.ctx.data.session;
    const snaps = props.snapshots();
    return members.map((member) => {
      const snapshot = snaps.get(member.id);
      return {
        ...member,
        running: data?.status(member.id) === "running",
        tps: snapshot ? (snapshot.active ? snapshot.instantTps : snapshot.avgTps) : 0,
        tokens: snapshot?.totalTokens ?? 0,
      };
    });
  });

  return (
    <Show when={rows().length > 0} fallback={<box flexShrink={0} />}>
      <box flexDirection="column" flexShrink={0}>
        <text fg={props.theme.text.subdued}>Throughput</text>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={row.running ? props.theme.text.default : props.theme.text.subdued}>
                {`${row.isRoot ? ">" : " "} ${row.label} ${tps(row.tps)} t/s ${row.tokens} tok`}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}

/**
 * Full-screen dashboard over the durable ledger.
 *
 * Everything here outlives the TUI process and is shared across windows, which is only
 * possible because of `ctx.storage.store`.
 */
function DashboardPage(props: {
  ledger: V2Ledger;
  theme: V2ResolvedTheme;
  snapshots: () => ReadonlyMap<string, V2Snapshot>;
}) {
  const models = createMemo(() => {
    const data = props.ledger.read();
    return Object.entries(data.models ?? {})
      .map(([key, entry]) => ({
        key,
        entry,
        meanTps: entry.generationMs > 0 ? entry.tokens / (entry.generationMs / 1000) : 0,
      }))
      .sort((a, b) => b.meanTps - a.meanTps);
  });

  const live = createMemo(() => [...props.snapshots().values()].filter((s) => s.active));

  const header =
    "model".padEnd(34) +
    "mean".padStart(8) +
    "best".padStart(8) +
    "ttft".padStart(9) +
    "n".padStart(6);

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={props.theme.text.default}>Throughput dashboard</text>

      <Show when={live().length > 0}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={props.theme.text.subdued}>Live</text>
          <For each={live()}>
            {(s) => (
              <text fg={props.theme.text.default}>
                {`  ${s.modelKey}  ${tps(s.instantTps)} t/s  gen ${tps(s.generationTps)}  ${s.totalTokens} tok`}
              </text>
            )}
          </For>
        </box>
      </Show>

      <text fg={props.theme.text.subdued}>{header}</text>
      <Show
        when={models().length > 0}
        fallback={<text fg={props.theme.text.subdued}>  no completed steps recorded yet</text>}
      >
        <For each={models()}>
          {(row) => (
            <text fg={props.theme.text.default}>
              {row.key.slice(0, 33).padEnd(34) +
                tps(row.meanTps).padStart(8) +
                tps(row.entry.bestTps).padStart(8) +
                (row.entry.ttftSamples > 0 ? ms(row.entry.meanTtftMs) : "-").padStart(9) +
                String(row.entry.samples).padStart(6)}
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}

/**
 * Registers the plugin's commands.
 *
 * `ctx.keymap.layer` creates a layer owned by the CALLING COMPONENT, so it cannot be invoked
 * from bare `setup` — it needs a reactive owner. Mounting a null-rendering component in the
 * `app` slot is the pattern the host's own built-in plugins use for exactly this.
 */
function CommandLayer(props: {
  ctx: V2TuiContext;
  mode: () => DisplayMode;
  setMode: (next: DisplayMode) => void;
  snapshots: () => ReadonlyMap<string, V2Snapshot>;
  ledger: V2Ledger;
}) {
  const describe = (): string => {
    const entries = [...props.snapshots().values()];
    if (entries.length === 0) {
      return "No throughput recorded yet.";
    }
    return entries
      .map((s) => {
        const parts = [`${tps(s.active ? s.instantTps : s.avgTps)} TPS`, `${s.totalTokens} tok`];
        if (s.toolMs > 0) parts.push(`gen ${tps(s.generationTps)}`);
        if (s.ttftMs > 0) parts.push(`ttft ${ms(s.ttftMs)}`);
        if (s.overheadTokens > 0) parts.push(`+${s.overheadTokens} overhead`);
        return parts.join(" · ");
      })
      .join(" | ");
  };

  const layer = (): V2KeymapLayer => ({
    mode: "global",
    commands: [
      {
        id: "tps.toggle",
        title: "Throughput meter",
        description: "Open the dashboard, cycle the meter, or show current stats",
        group: "TPS Meter",
        palette: true,
        slash: { name: "tps", arguments: true },
        run: (input?: string) => {
          const arg = (input ?? "").trim().toLowerCase();

          if (arg === "" && props.ctx.ui.router) {
            props.ctx.ui.router.navigate({ type: "plugin", name: DASHBOARD_ROUTE });
            return;
          }
          if (arg === "detail" || arg === "details") {
            props.ctx.ui.toast?.show({
              title: "Throughput",
              message: describe(),
              variant: "info",
              duration: 6000,
            });
            return;
          }
          if (arg === "reset") {
            props.ledger.clear();
            props.ctx.ui.toast?.show({
              title: "Throughput",
              message: "Ledger cleared.",
              variant: "success",
            });
            return;
          }
          if (arg === "compact" || arg === "detailed" || arg === "hidden") {
            props.setMode(arg as DisplayMode);
            return;
          }
          const index = MODE_ORDER.indexOf(props.mode());
          props.setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length] as DisplayMode);
        },
      },
    ],
  });

  try {
    props.ctx.keymap?.layer(layer);
  } catch {
    // Command registration is a nicety; the meter matters more.
  }
  return null;
}

/**
 * v2 TUI setup. Returns a cleanup function; v2 calls it on disable, reload, and shutdown.
 */
export function setupTui(ctx: V2TuiContext): V2Cleanup | void {
  const config = loadTuiConfig(ctx.options);
  if (!config.enabled) {
    return;
  }

  const ledger = createLedger(ctx.storage);
  const meter = createMeter(config, {
    onStepSettled: (measurement) => {
      try {
        ledger.record(measurement);
      } catch {
        // A durable-store failure must never interrupt metering.
      }
    },
  });
  const [snapshots, setSnapshots] = createSignal<ReadonlyMap<string, V2Snapshot>>(new Map());
  const [mode, setMode] = createSignal<DisplayMode>("compact");
  const disposers: Array<() => void> = [];

  disposers.push(meter.subscribe((next) => setSnapshots(() => next)));

  for (const type of SUBSCRIBED_EVENTS) {
    disposers.push(
      ctx.data.on(type, (event) => {
        meter.handleEvent(event as unknown as V2UnknownEvent);
      })
    );
  }

  // The footer meter is the ONE surface that must exist. It is claimed first and outside any
  // guard, so a failure in an optional surface below can never cost us the meter itself.
  disposers.push(
    ctx.ui.slot({
      // PREPEND, not append. The host's own child in this slot is a box with flexGrow:1,
      // and while a turn is running it renders a second flexGrow:1 box holding the spinner
      // and the "esc interrupt" hint. Appending puts the meter after that greedy box, so it
      // is squeezed to zero width the moment anything runs — thinking, tool calls, or
      // compaction — and only reappears when the session goes idle. Prepending lays the
      // meter out first, and MeterView's flexShrink={0} keeps its width.
      prepend: "prompt.footer.status",
      render: (input) => (
        <MeterView
          input={input}
          theme={ctx.theme}
          config={config}
          mode={mode}
          snapshots={snapshots}
        />
      ),
    })
  );

  /**
   * Registers an optional surface.
   *
   * These APIs are beta and typed structurally in src/v2/types.ts — presence does not
   * guarantee the signature matches. Previously a throw here aborted `setup`, which the host
   * treats as a failed plugin load: one bad optional call and the user gets NO meter at all,
   * with nothing in the log because TUI plugin failures are silent.
   */
  function optional(label: string, register: () => (() => void) | undefined): void {
    try {
      const dispose = register();
      if (typeof dispose === "function") {
        disposers.push(dispose);
      }
    } catch {
      // Degrade to the footer meter; `label` is retained for future diagnostics.
      void label;
    }
  }

  // Per-subagent breakdown. Only renders when the session actually has a family.
  if (ctx.data.session) {
    optional("sidebar", () =>
      ctx.ui.slot({
        append: "sidebar.content",
        render: (input) => (
          <SidebarPanel input={input} ctx={ctx} theme={ctx.theme} snapshots={snapshots} />
        ),
      })
    );
  }

  if (ctx.ui.router) {
    optional("dashboard", () =>
      ctx.ui.router?.register({
        name: DASHBOARD_ROUTE,
        render: () => <DashboardPage ledger={ledger} theme={ctx.theme} snapshots={snapshots} />,
      })
    );
  }

  // Commands need a reactive owner; the `app` slot provides one without drawing anything.
  if (ctx.keymap) {
    optional("commands", () =>
      ctx.ui.slot({
        append: "app",
        render: () => (
          <CommandLayer
            ctx={ctx}
            mode={mode}
            setMode={setMode}
            snapshots={snapshots}
            ledger={ledger}
          />
        ),
      })
    );
  }

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
    disposers.length = 0;
    meter.dispose();
    setSnapshots(() => new Map<string, V2Snapshot>());
  };
}

/** v2 TUI plugin definition. Structurally what `Plugin.define` from `@opencode-ai/plugin/tui` returns. */
export const v2TuiPlugin: V2PluginDefinition<V2TuiContext> = {
  id: "opencode-tps-meter",
  setup: setupTui,
};

export default v2TuiPlugin;
