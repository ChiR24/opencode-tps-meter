## v0.4.0-beta.1 — OpenCode v2 support (beta)

> Released as a **prerelease** on purpose. It targets `opencode2`, which is itself beta and
> whose plugin API is documented as subject to change before 2.0 is stable. v1 support is
> unchanged and unaffected. Install with `opencode-tps-meter@beta`.

The plugin now runs on **both** OpenCode generations from one package. Nothing about v1 behaviour changes.

### ✨ Added

- **OpenCode v2 (`opencode2`) support** — new `opencode-tps-meter/v2` and `opencode-tps-meter/v2/tui` entry points, built on v2's `Plugin.define({ id, setup })` shape.
- **Exact final token totals on v2** — `session.step.ended` carries provider-reported `tokens.output` / `tokens.reasoning`, so the closing figure is no longer a character-count estimate. The heuristic still drives the live rolling rate.
- **Inline plugin options on v2** — values passed via `opencode.json` `plugins[].options` override config files and environment variables.
- **Dual-shaped default entries** — `opencode-tps-meter` and `opencode-tps-meter/tui` carry both the v1 and v2 plugin shapes, so the bare package name works on either host.

### 📈 v2-only metrics and surfaces

- **Self-calibrating tokenizer** — each step compares streamed heuristic tokens against the
  provider's reported count and learns a per-model correction (EWMA, fractional carry, samples
  outside 0.25-4x rejected). The live rate stops being a fixed chars/4 guess.
- **Generation vs end-to-end throughput** — tool execution is bracketed by
  `session.tool.called`/`.success` and subtracted, so dead time no longer dilutes the rate.
- **Time to first token** — measured from `session.execution.started` on the host clock.
- **Hidden overhead** — the residual between cumulative session usage and the sum of per-step
  deltas is exactly the auto-title and compaction spend.
- **Per-subagent sidebar panel** — exact attribution via `ctx.data.session.root`/`.family`,
  replacing v1's session-ID-comparison heuristic.
- **Durable ledger and `/tps` dashboard** — per-model mean/best throughput and mean TTFT,
  persisted through `ctx.storage.store` and live-synced across TUI windows. v1's TUI KV is
  documented as unsupported in v2, so v1 plugins have no durable state at all.
- **Wire-level TTFB** — the server half times provider dispatch to response headers via
  `ctx.session.hook`. Server and TUI are separate processes, so this is exposed to embedders
  via `getWireTimings()` and cannot currently reach the on-screen meter.

### ⚡ Latency

- **Incremental token counting.** Delta counting re-read the entire accumulated response on
  every chunk — O(total) per delta, O(n^2) per response. With the word heuristic that measured
  **10,223ms** to absorb a 186k-character stream (1.7ms of blocking work per delta); it is now
  **12.2ms**, and linear. Counts are proven identical to the batch counter across every
  algorithm, corpus and chunk size, including words split across chunk boundaries. The full
  response text is also no longer retained in memory.
- **Live updates were being dropped.** `publish()` recorded its timestamp on the host event
  clock while the throttle timer compared against `Date.now()`, and a timer whose guard failed
  was discarded without rescheduling — so the meter sat stale until the next delta happened to
  arrive. Measured over 120 deltas at a 10ms cadence: **8 updates, p50 184ms, p95 450ms**. All
  scheduling is now decided on one clock and the timer publishes what is pending rather than
  re-testing its preconditions: **120 updates, p50 15.3ms, p95 18.0ms** — and the p50 is the
  benchmark's own timer granularity, since the publish is synchronous inside `handleEvent`
  (~1ms).
- **v2 display throttle lowered to 8ms** (`V2_UPDATE_INTERVAL_MS`). The host flushes events in
  ~10ms batches, so this is the floor past which publishing more often cannot reveal anything
  new. v1 keeps its 50ms default, which exists for the much more expensive toast path; an
  explicit `updateIntervalMs` still wins on both.
- **Faster smoothing on v2.** The EWMA half-life is now a tracker option. v2 uses 120ms instead
  of 250ms, cutting time-to-90%-of-a-steady-rate from **940ms to 540ms**. v1 is untouched:
  omitting the option behaves exactly as before, and a test asserts it.

### 🐞 Fixed

- **`session.usage.updated` was misused as a per-step total.** It is a cumulative session
  figure that also includes auto-title and compaction tokens, so a long session reported the
  whole-session total as a single step's output.
- **Two clocks were mixed.** Token timestamps came from the host while elapsed came from
  `src/tracker.ts`'s own `Date.now()`. v2 now derives elapsed from host-stamped first/last
  token times.
- **Tool-call steps skipped token accounting**, and overhead was tracked in per-turn state that
  is destroyed on every step end — so it always read zero. Both now session-scoped.

### 🔄 Changed

- `@opentui/solid` and `solid-js` moved from `dependencies` to **optional peer dependencies**. The TUI host supplies the renderer and reactive runtime; a nested copy would give the plugin a separate reactive graph and the meter would render once and then freeze.
- Meter text formatting extracted to `src/format.ts` so both hosts render identical output.
- `loadConfigSync()` accepts an optional overrides argument (backward compatible).

### 📝 Notes on v2

v2 removed the entire `message.*` event family; the meter now consumes `session.text.delta`, `session.reasoning.delta`, `session.step.ended`, `session.usage.updated`, and `session.idle`. Role filtering is gone because text and reasoning deltas are assistant output by construction.

v2 server plugins have no UI surface — no client, no toast API — so on v2 the meter would render exclusively from the TUI entry, and `toastFallback` has no effect.

The v2 TUI plugin API is implemented in the shipped `opencode2` beta: its built-in TUI plugins use
`Plugin.define({ id, setup })` with `ctx.ui.slot` and `ctx.data.on`, which is exactly what this
package's v2 TUI entry targets. TUI plugins are registered in `~/.config/opencode/cli.json` under
`plugins`, and v2 provides a plugin manager dialog (`plugins.list`) for inspecting and toggling them.

**v2 is beta.** Verified loading against `opencode2` beta `0.0.0-beta-17639`.

Two v2 loader constraints drove the final design:
1. The default export must be an **object**. v2 rejects a callable default with
   `SchemaError(Expected object at ["default"])`, so the plugin now exports
   `{ id, server, setup }` — v1 reads `server`, v2 reads `setup`.
2. v2's `plugins` array does not resolve **subpath** specifiers; each string is treated as an npm
   package name or local path. Register the bare package name.

### 📦 Installation

OpenCode v1:

```json
{
  "plugin": ["opencode-tps-meter@latest"]
}
```

OpenCode v2 (note the `plugins` key):

```json
{
  "plugins": ["opencode-tps-meter@latest"]
}
```

### 🔗 Links

- [README](https://github.com/ChiR24/opencode-tps-meter#readme)
- [Full Documentation](https://github.com/ChiR24/opencode-tps-meter/blob/main/README.md)
