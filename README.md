
<div align="center">

# OpenCode TPS Meter

**Real-time AI token throughput visualization for OpenCode**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-Runtime-000?logo=bun&logoColor=white)](https://bun.sh)
[![OpenCode](https://img.shields.io/badge/OpenCode-Plugin-7C3AED?logo=code&logoColor=white)](https://opencode.ai)
[![NPM Version](https://img.shields.io/npm/v/opencode-tps-meter.svg)](https://www.npmjs.com/package/opencode-tps-meter)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

</div>

```
92.4 TPS · avg 78.1 · 1,842 tok · cache 91% · session cache 87%
TPS Σ 318 | main 63 | explore 91 | general 86 | +1
```

A live tokens-per-second meter plugin for OpenCode. Track AI token throughput in real-time with a configurable rolling window display. Only assistant output is counted — on v1, user and system messages are filtered out by role; on v2, text and reasoning events are assistant output by construction. File parts are never counted.

> **Note:** Time display is disabled by default. Enable with `showElapsed: true` in configuration.

---

## Features

- **Runs on both OpenCode generations** — one package, v1 (`opencode`) and v2 (`opencode2`)
- **Real-time Monitoring** — Live TPS calculation over a configurable rolling window, exact from the second streamed chunk
- **Accurate Rates** — Chunks are rated over the interval they were generated in, never over the instant they arrived, so batched output cannot spike the reading
- **Exact final totals on v2** — Provider-reported token counts replace the heuristic estimate when a step ends, and calibrate the live estimate per model
- **Multi-Session Footer** — While subagents run, the footer becomes a single aggregate line (`TPS Σ 318 | main 63 | explore 91 | …`) on both hosts
- **Prompt Cache Hit Rate** — Per-step and whole-session cache hit rate, from provider-reported usage
- **Smart Filtering** — Tracks only assistant text/reasoning (plus tool-call arguments on v2); excludes user prompts, tool results, patches, snapshots, and files
- **Noise Suppression** — Nothing is shown until a rate is measurable (at least 50ms of generation) and the configurable startup delay (10ms) has passed
- **Multi-Session Support** — Isolated tracking per session with automatic cleanup
- **Throttled UI Updates** — Configurable update intervals to prevent UI flooding
- **Optional Time Display** — Elapsed time display (disabled by default, enable with `showElapsed: true`)
- **TPS-Based Color Coding** — Visual feedback with color-coded persistent TUI text based on throughput speed
- **Persistent TUI Meter** — OpenCode TUI slot display beside the session prompt
- **Opt-in Toast Fallback** — Legacy v1 toast UI is disabled by default; enable it only for older OpenCode surfaces
- **Zero Console Logging** — Safe for TUI environments (no console.* calls)
- **Dual Format** — ESM and CommonJS builds for maximum compatibility
- **Heuristic Token Counting** — Fast approximation without heavy dependencies

---

## OpenCode version support

One package supports both OpenCode generations. They install as separate binaries (`opencode` and `opencode2`) and can run side by side.

| | OpenCode v1 (`opencode`) | OpenCode v2 (`opencode2`) |
|---|---|---|
| Config key | `"plugin"` | `"plugins"` |
| Inline plugin options | Not available | `plugins[].options` |
| Meter renders in | TUI session prompt (`session_prompt_right` slot) | TUI prompt footer (placed after the `prompt.footer.status` box) |
| Registered as | `opencode-tps-meter` | `opencode-tps-meter` |
| Default export shape accepted by the host | function *or* `{ id, server }` | `{ id, setup }` (object required) |
| Multi-session footer | Yes | Yes |
| Toast fallback | Available (opt-in) | Not available — v2 server plugins have no UI surface |
| Sidebar panel, dashboard, `/tps` commands, durable ledger | Not available | Yes |

This package's default export is an object, `{ id, server, setup }`: v1 reads `server`, v2 reads `setup`, and each ignores the other's key.

> Tested on OpenCode v2 (server reports `features: server+tui, status: active`), whose shipped binary implements the v2 TUI plugin API this package targets — its own built-in TUI plugins (`opencode.notifications`, `diff-viewer`) use `Plugin.define({ id, setup })` with `ctx.ui.slot({ append, render })` and `ctx.data.on(...)`.

---

## Installation

### OpenCode v1

Install with OpenCode's plugin installer so the persistent TUI entrypoint is registered:

```bash
opencode plug opencode-tps-meter@latest
```

For manual installation, add the package to your TUI config (`~/.config/opencode/tui.json` or `tui.jsonc`) for persistent display:

```json
{
  "plugin": ["opencode-tps-meter@latest"]
}
```

### OpenCode v2 (`opencode2`)

```bash
npm install opencode-tps-meter
```

v2 replaced layered `tui.json(c)` files with a single global `cli.json`, and renamed the plugin config key to `plugins`. Register in `opencode.json`:

```json
{
  "plugins": ["opencode-tps-meter@latest"]
}
```

The single package name is all you need — the default export carries both plugin shapes, so v1 reads `server` and v2 reads `setup`.

> **Do not use subpath specifiers in `plugins`.** v2 treats every string in that array as an npm package name or a local path, so `"opencode-tps-meter/v2"` is not resolved as a subpath — it is attempted as a package install and fails. The `opencode-tps-meter/v2` and `/v2/tui` exports exist for programmatic `import` only.

v2 also accepts inline options, which take priority over config files and environment variables:

```json
{
  "plugins": [
    {
      "package": "opencode-tps-meter@latest",
      "options": { "showElapsed": true, "enableColorCoding": true }
    }
  ]
}
```

### Local builds

```bash
bun install
bun run build
```

Register the built **`dist` directory**, not the repository root.

OpenCode v1 — `opencode.json` (server) and `tui.json` (TUI):

```json
{ "plugin": ["file:///abs/path/to/opencode-tps-meter/dist"] }
```

OpenCode v2 — `opencode.json` and `cli.json`:

```json
{ "plugins": ["file:///abs/path/to/opencode-tps-meter/dist"] }
```

On v2, a local directory is resolved by file path (`<dir>/server` or `<dir>/index` for the server, `<dir>/tui` for the TUI, trying the usual script extensions) and `package.json` `exports` is **ignored**. The repository root has no `index.*`/`tui.*` files, so it is skipped without an error and no meter appears. `dist/` contains both `index.mjs` and `tui.mjs`. A correctly registered v2 plugin reports `"features":{"server":true,"tui":true},"state":{"status":"active"}` from `/api/plugin`.

`exports["./server"]` and `exports["./tui"]` are only consulted for npm-package specs (`"opencode-tps-meter"`).

---

## Quick Start

The plugin hooks into OpenCode events and starts tracking TPS after installation.

On v1, the meter renders in the session prompt area via `opencode-tps-meter/tui`. OpenCode's installer detects that entrypoint; manual installs need the package listed in TUI config.

On v2, TUI plugins are registered in the global `~/.config/opencode/cli.json` under `plugins` (auto-migrated from v1's `tui.json`). Per OpenCode's loader spec, a package with an `exports` map is resolved via `./tui` or `./server` and **never** falls back to `exports["."]`, so this package publishes both.

**Note on the v2 TUI module shape:** v2 requires `{ id, setup }`. Plugins exporting only v1's `{ id, tui }` are rejected by the loader. This package's TUI module exports both keys, so it satisfies v1 and v2 from one file.

v2 ships a plugin manager dialog — open the command palette (`ctrl+p`) and run **Open plugin manager dialog** (`plugins.list`) to see which TUI plugins loaded, and to enable/disable them with `space`. Runtime enable/disable state is persisted and overrides config at startup, so check there first if the meter does not appear.

If you intentionally want the old toast UI on an older v1 surface, add the package to normal OpenCode plugin config too and set `toastFallback: true` or `TPS_METER_TOAST_FALLBACK=true`. This option does nothing on v2.

### Package Exports

When using the plugin with OpenCode, you only need the default package export for your host generation.

```typescript
import TpsMeterPlugin from 'opencode-tps-meter';          // v1 server (also carries the v2 shape)
import TpsMeterTuiPlugin from 'opencode-tps-meter/tui';   // v1 TUI (also carries the v2 shape)
import TpsMeterV2 from 'opencode-tps-meter/v2';           // v2 server only
import TpsMeterV2Tui from 'opencode-tps-meter/v2/tui';    // v2 TUI only
```

Internal tracker/tokenizer/UI helper modules are not public package exports. For experiments or forks, clone the repository and import helpers from local source paths instead of from the published package.

### Multi-session footer

When a session fans out to subagents, the footer swaps its single-session line for one aggregate line, on **both** hosts:

```
TPS Σ 318 | main 63 | explore 91 | general 86 | reviewer 78 | +2
```

- **Σ** is the sum of every session streaming tokens right now. A root that is waiting on its subagents is not generating, so it drops out of Σ on its own, and counts again once it resumes (say, to summarise their results).
- **`main`** is the root session; the other columns are labeled by agent name. Same-named subagents get a short id suffix, e.g. `explore(9B5c)`; a session with no known agent name falls back to the last six characters of its session id.
- A column shows the live rate while that session generates and its frozen average afterwards. Columns keep their **spawn order** (no swapping as activity trades places). At most four are shown, with the remainder collapsed into `+N`.
- A subagent stays visible while it generates, for about 4 seconds after its last token, and for as long as the host reports it running — so a subagent inside a long tool call keeps its column.
- The line is color-coded by the **mean per-stream rate** of what is generating, because the slow/fast thresholds are per-stream figures.
- With no subagents the footer is the ordinary single-session meter.

Attribution: v2 reads the real session tree from `ctx.data.session` (`root` / `family` / `get` / `status`). v1 learns parent links from `session.created` / `session.updated` (`info.parentID`) and `api.state.session`, and reads agent names from message payloads. If a host stops exposing these, the footer degrades to the single-session meter.

### v2-only capabilities

These need APIs that do not exist on v1, so they are inert on `opencode`.

| Feature | What you get | v2 API |
|---|---|---|
| Calibrated live rate | The streaming estimate is corrected against provider token counts, learned per model and saved so the next session starts calibrated | `session.step.started` (model/agent) + `session.step.ended` (tokens), `ctx.storage.store` |
| Tool-call output counted | Arguments the model writes for a tool call (a file write, an edit) count as output, so a step that only calls a tool still has a real reading | `session.tool.input.delta` / `.ended` |
| Tool time | Time the turn spent running tools, shown separately in the detailed footer; it is never inside a step's rate window | `session.tool.called` / `.success` / `.failed` |
| Time to first token | Measured from turn start on the host clock | `session.execution.started` + event `created` |
| Hidden overhead | Tokens spent on auto-title and compaction that no step reports | `session.usage.updated` residual |
| Sidebar breakdown | A "Throughput" panel in the session sidebar listing every session in the family (root marked `>`) with its rate and token count; shown only once work has fanned out | `ctx.data.session`, `sidebar.content` slot |
| Durable ledger + dashboard | Per-model mean/best throughput and TTFT, persisted and shared across windows | `ctx.storage.store`, `ctx.ui.router` |
| Wire-level TTFB | Provider dispatch to response headers, below the streaming pipeline. Server and TUI are separate processes, so this is exposed to embedders via `getWireTimings()` and does **not** reach the on-screen meter | `ctx.session.hook("http.request"/"http.response")` |

Every one of these is feature-detected. A host that exposes none of the optional APIs still gets the footer meter and nothing else.

**Commands** (command palette — "Throughput meter" in the "TPS Meter" group — `/tps`, or a key you bind):

```text
/tps              open the throughput dashboard
/tps detail       toast with current stats (also: details)
/tps compact      default footer
/tps detailed     footer also shows tools / ttft / overhead (and "aborted" for an interrupted turn)
/tps hidden       hide the meter
/tps reset        clear the durable ledger (per-model calibration is kept)
```

Any other argument cycles the footer through `compact` → `detailed` → `hidden`. With no argument, `/tps` opens the dashboard; on a host without a router it cycles instead. The detailed extras are not shown while the multi-session aggregate line is on screen.

The **dashboard** lists live sessions (model, instantaneous and average rate, tokens) above a per-model table of mean rate, best rate, mean time to first token and sample count, sorted by mean rate.

**Latency.** Token counting is incremental — each chunk is scanned once and never re-read, so absorbing a long response is linear rather than quadratic. The live rate is exact from the second chunk of a stream (about 100ms in on v2) with no seed value or smoothing lag, and the publish is synchronous, so a chunk is on screen about a millisecond after it arrives. The v2 display throttle defaults to 8ms; v1 keeps its 50ms default for the costlier toast path. Tune with `updateIntervalMs` (display throttle) and `rollingWindowMs` (averaging window). On v2 an explicit `updateIntervalMs` overrides the 8ms default, except that the v1 default value `50` is indistinguishable from "unset" and still resolves to 8ms; values below 10 are clamped to 10.

**Clock note.** The TUI delivers events in ~10ms batches, so wall-clock time inside a handler is flush time shared by the whole batch. All timing uses each event's host-stamped `created`.

### Peer dependencies

`@opentui/solid` and `solid-js` are optional peer dependencies rather than bundled dependencies. The TUI host supplies the renderer and reactive runtime; installing a second copy inside the plugin would give it a separate reactive graph and the meter would render once and never update. `@opencode-ai/plugin` (`>=1.15.13`) is an optional peer dependency as well and is external in the build.

---

## Configuration

Configuration starts with built-in defaults, then merges these sources in order (later sources override earlier ones):

1. **Built-in Defaults**
2. **Project Config** (`.opencode/tps-meter.json`, relative to the working directory)
3. **Global Config** (`~/.config/opencode/tps-meter.json`)
4. **Environment Variables** (`TPS_METER_*`)
5. **Inline Options** (v2 only: `plugins[].options` in `opencode.json`)

> **Note:** Environment variables override all config files, and v2 inline options override everything. Global config overrides project config in the current implementation.

Invalid input never throws: an unreadable or malformed config file is ignored, numbers above a range in the table below are clamped to it (negative or non-numeric values fall back to the default), and unknown `format` / `fallbackTokenHeuristic` values fall back to the default. If `slowTpsThreshold` is not strictly below `fastTpsThreshold`, both fall back to their defaults.

### Environment Variables

```bash
# Core settings
TPS_METER_ENABLED=true                   # Enable/disable plugin
TPS_METER_TOAST_FALLBACK=false           # Opt into old toast UI when needed (v1 only)
TPS_METER_UPDATE_INTERVAL_MS=50          # UI update throttle (ms); v2 resolves the default to 8
TPS_METER_INITIAL_DISPLAY_DELAY_MS=10    # First live display delay; set 0 for absolute fastest
TPS_METER_ROLLING_WINDOW_MS=1000          # TPS calculation window (ms)
TPS_METER_FORMAT=compact                  # compact | verbose | minimal (accepted, no visible effect — see Display Formats)
TPS_METER_MIN_VISIBLE_TPS=0               # Minimum TPS to display

# Display toggles
TPS_METER_SHOW_AVERAGE=true
TPS_METER_SHOW_INSTANT=true
TPS_METER_SHOW_TOTAL_TOKENS=true
TPS_METER_SHOW_ELAPSED=false
TPS_METER_SHOW_CACHE_HIT=true

# Token counting heuristic
TPS_METER_FALLBACK_HEURISTIC=chars_div_4  # chars_div_4 | chars_div_3 | words_div_0_75

# Color coding (visual feedback based on TPS speed)
TPS_METER_ENABLE_COLOR_CODING=false       # Enable color-coded TUI text
TPS_METER_SLOW_TPS_THRESHOLD=10           # Below this = red (slow)
TPS_METER_FAST_TPS_THRESHOLD=50           # Above this = green (fast)
```

Boolean variables are enabled only by the exact string `true`; any other value (including `1` or `TRUE`) reads as `false`. Non-numeric values for numeric variables, and unknown values for `TPS_METER_FORMAT` / `TPS_METER_FALLBACK_HEURISTIC`, are ignored.

### JSON Configuration

Create `.opencode/tps-meter.json` in your project root:

```json
{
  "enabled": true,
  "toastFallback": false,
  "updateIntervalMs": 50,
  "initialDisplayDelayMs": 10,
  "rollingWindowMs": 1000,
  "showAverage": true,
  "showInstant": true,
  "showTotalTokens": true,
  "showElapsed": false,
  "showCacheHit": true,
  "format": "compact",
  "minVisibleTPS": 0,
  "fallbackTokenHeuristic": "chars_div_4",
  "enableColorCoding": false,
  "slowTpsThreshold": 10,
  "fastTpsThreshold": 50
}
```

#### Enable Time Display

To show elapsed time in the meter:

```json
{
  "showElapsed": true
}
```

Output: `92.4 TPS · avg 78.1 · 1,842 tok · 00:23`

### Default Configuration

| Option | Type | Default | Range / values | Description |
|--------|------|---------|----------------|-------------|
| `enabled` | `boolean` | `true` | | Enable/disable the plugin |
| `toastFallback` | `boolean` | `false` | | Emit legacy toast notifications from the v1 server plugin |
| `updateIntervalMs` | `number` | `50` (v2: `8`) | 10–5000 | UI update interval in milliseconds |
| `initialDisplayDelayMs` | `number` | `10` | 0–1000 | Startup delay before the first live TPS display; set `0` for absolute fastest updates |
| `rollingWindowMs` | `number` | `1000` | 100–30000 | Rolling window for TPS calculation; also the recency window for "generating" in the multi-session footer |
| `showAverage` | `boolean` | `true` | | Show average TPS in display |
| `showInstant` | `boolean` | `true` | | Show instantaneous TPS in display |
| `showTotalTokens` | `boolean` | `true` | | Show total token count |
| `showElapsed` | `boolean` | `false` | | Show elapsed time |
| `showCacheHit` | `boolean` | `true` | | Show the prompt cache hit rate (provider-reported) |
| `format` | `string` | `"compact"` | `compact`, `verbose`, `minimal` | Accepted and validated, but **currently has no effect** on any display — see [Display Formats](#display-formats) |
| `minVisibleTPS` | `number` | `0` | 0–10000 | Minimum TPS value to trigger display |
| `fallbackTokenHeuristic` | `string` | `"chars_div_4"` | `chars_div_4`, `chars_div_3`, `words_div_0_75` | Token counting method |
| `enableColorCoding` | `boolean` | `false` | | Enable TPS-based color coding |
| `slowTpsThreshold` | `number` | `10` | 0–10000 | TPS below this shows red (slow) |
| `fastTpsThreshold` | `number` | `50` | 0–10000 | TPS above this shows green (fast) |

---

## Color Coding

Enable visual feedback with color-coded TUI text based on token throughput speed:

```json
{
  "enableColorCoding": true,
  "slowTpsThreshold": 10,
  "fastTpsThreshold": 50
}
```

| Color | TPS Range | Meaning |
|-------|-----------|---------|
| 🔴 **Red** | Below `slowTpsThreshold` | Slow generation |
| 🟡 **Yellow** | Between thresholds | Medium speed |
| 🟢 **Green** | Above `fastTpsThreshold` | Fast generation |
| ⚪ **Muted** | — | Settled reading (not streaming), shown in the theme's muted text color |

With color coding off, a streaming reading uses the theme's normal text color and a settled one the muted color. While subagents run, the aggregate line is colored by the mean per-stream rate of the sessions that are generating.

On v2 the meter reads the host theme live, so switching themes recolors it without restarting the TUI. It resolves the current token names (`text.base`, `text.muted`, `feedback.<kind>.base`) and falls back to the older ones.

**Note:** Persistent TUI display supports color coding directly. Legacy toast color coding is available only when `toastFallback` is enabled and OpenCode exposes TUI toast methods (`client.tui.showToast` or `client.tui.publish`); the fallback `client.toast` methods only support info/success variants. The toast's final-stats message is always green (`success`).

---

## Cache Hit Rate

OpenCode reports provider token usage as `{ input, output, reasoning, cache: { read, write } }`,
where `input` EXCLUDES cache reads and writes. The meter therefore computes the prompt-side
total as `input + cache.read + cache.write` and shows the cached share:

```
cache hit rate = cache.read / (input + cache.read + cache.write)
```

The persistent meter shows two figures once a provider-reported step has settled:

- `cache 91%` — the last settled step.
- `session cache 87%` — every reported step in the session so far, so it stays on screen while the next step streams.

During streaming of a session's first step no cache accounting is available yet, so the segments are omitted rather than shown as `0%` — nothing appears until the first step of a session has finished, which is expected and not a fault. A step that ends in a tool call without streaming any text still updates both figures. Toggle with `showCacheHit` / `TPS_METER_SHOW_CACHE_HIT`.

The figure also appears in the v2 `/tps detail` toast and in the v1 toast (`cache: 91%`, last step only).

---

## Display Formats

### Persistent meter (v1 TUI and v2 footer)

```
92.4 TPS · avg 78.1 · 1,842 tok · cache 91% · session cache 87%
```

- The leading figure is the rolling instantaneous rate while tokens stream; once the step settles it becomes the average, so a frozen meter reads as a summary rather than a stale live value.
- Segments follow the toggles: `showInstant` (leading `TPS`), `showAverage` (`avg`), `showTotalTokens` (`tok`), `showElapsed` (`MM:SS`) and `showCacheHit` (`cache`, `session cache`). With every toggle off the line reads `TPS meter`.

With `showElapsed: true`:

```
92.4 TPS · avg 78.1 · 1,842 tok · 00:23 · cache 91% · session cache 87%
```

### Multi-session aggregate line

See [Multi-session footer](#multi-session-footer):

```
TPS Σ 318 | main 63 | explore 91 | general 86 | reviewer 78 | +2
```

### v2 detailed mode (`/tps detailed`)

```
92.4 TPS · avg 78.1 · 1,842 tok · cache 91% · tools 1.2s · ttft 340ms · +512 ovh
```

Each extra appears only when measured: `tools` (time the turn spent running tools), `ttft` (time to first token), `+N ovh` (hidden auto-title/compaction tokens), `aborted` (interrupted turn).

### v1 toast fallback (`toastFallback: true`)

```
TPS: 92.4 (avg 78.1) | tokens: 1,842 | 00:23 | cache: 91%
explore(a1b2c3…) 63.2 (avg 60.1) | tokens: 500 | 00:08
```

The first line always describes the primary session; each active background agent adds a line of its own. When a message completes, a 2-second final-stats toast shows the settled figures — its instantaneous figure reads `TPS: 0.0` because the stream has ended; the average and totals are the part to read.

### `format` option

`compact`, `verbose` and `minimal` are accepted and validated by the config loader, but no renderer reads the value: every surface above uses the single layout shown. It is retained so existing config files keep loading.

---

## Package API

The published package exposes only the OpenCode plugin entrypoints:

```typescript
import TpsMeterPlugin from 'opencode-tps-meter';
import TpsMeterTuiPlugin from 'opencode-tps-meter/tui';
import TpsMeterV2 from 'opencode-tps-meter/v2';
import TpsMeterV2Tui from 'opencode-tps-meter/v2/tui';
```

- `opencode-tps-meter` is the dual-host server entrypoint: an object `{ id, server, setup }`. v1 calls `server` (the toast fallback, which emits nothing unless `toastFallback` is enabled); v2 calls `setup`, which dispatches on the context it receives — a TUI context lazy-loads the TUI module, a server context runs the v2 server half. (v2 rejects a bare-function default export, which is why this is an object.)
- `opencode-tps-meter/tui` is the persistent TUI entrypoint: an object `{ id, tui, setup }`, with `tui` for v1 and `setup` for v2.
- `opencode-tps-meter/v2` and `opencode-tps-meter/v2/tui` are plain `{ id, setup }` v2 definitions with no v1 shape, for hosts that reject the dual-shaped modules.

Tracker, tokenizer, and UI helper modules are internal implementation details and are not exported as public package subpaths. If you need those helpers for experimentation, clone or fork the repository and import them from local source files.

---

## Token Counting Heuristics

| Method | Algorithm | Best For | Accuracy |
|--------|-----------|----------|----------|
| `chars_div_4` | `Math.ceil(chars / 4)` | General text | ~75% |
| `words_div_0_75` | `Math.ceil(words / 0.75)` | English prose | ~80% |
| `chars_div_3` | `Math.ceil(chars / 3)` | Code | ~70% |

**Note:** This plugin uses fast heuristic token counting. It does not include gpt-tokenizer or similar heavy tokenization libraries to keep the bundle size small and avoid bundling issues. Streaming deltas are counted incrementally, and the running counts equal what counting the whole text at once would give. On v2 the heuristic is additionally scaled by a per-model factor learned from provider token counts (accepted range 0.25×–4×).

---

## How It Works

### Event Handling (OpenCode v1)

The v1 server plugin (toast fallback) and the v1 TUI meter both consume the `message.*` family. The server plugin subscribes to four event types:

1. **`message.part.delta`** — Processes live text deltas when OpenCode emits incremental streaming updates
   - Updates live TPS while preserving text cache state for later full-part updates
   - Zero-token text deltas, such as whitespace under word-based heuristics, are cached so later full updates do not re-count already streamed text

2. **`message.part.updated`** — Processes full text/reasoning part updates
   - **Role Filtering**: Only tracks parts belonging to messages with `role: "assistant"`
   - **User prompts excluded**: Prevents TPS spikes from user input (which would appear as thousands of TPS since prompts arrive instantly)
   - **Counted parts**: Only `text` and `reasoning` are counted toward TPS
   - **Ignored parts**: `tool`, `patch`, `snapshot`, `file`, `subtask`, `agent`, `retry`, `compaction`
   - **Startup delay**: TPS display begins after `initialDisplayDelayMs` (10ms by default) for fast live feedback
   - Calculates delta tokens between consecutive updates
   - Updates tracker and throttled UI display

3. **`message.updated`** — Handles message status changes
   - Records role information (`user`, `assistant`, `system`) for each message ID, and the agent name carried by the payload
   - Used to filter parts in `message.part.updated` events
   - Processes official token counts from API responses when available
   - Displays final stats (toast fallback) when a message completes with a valid finish reason

4. **`session.idle`** — Cleanup trigger
   - Removes the tracker and all session-specific caches (role cache, token cache, part text cache, agent names) for that session
   - Cleans up the whole UI once no tracked sessions remain

The v1 TUI meter handles the same four events with its own state and adds `session.created` / `session.updated`, which carry the `parentID` links used for the multi-session footer. On `message.updated` (completed) it settles the reading and freezes it on screen — including a step that ends in a tool call, whose reading stays visible until the next step streams. On `session.idle` it keeps the latest streamed stats visible as an inactive reading (when a rate was measurable) and frees the session's trackers.

### Event Handling (OpenCode v2)

v2 removed the entire `message.*` event family and replaced it with granular session events:

| v1 event | v2 replacement |
|---|---|
| `message.part.delta` (field `text`) | `session.text.delta` |
| `message.part.updated` (reasoning) | `session.reasoning.delta` |
| `message.updated` (completed) | `session.step.ended` |
| `message.updated` (`info.tokens`) | `session.usage.updated` |
| `session.idle` | `session.idle` (unchanged) |

The v2 entries subscribe to those plus eleven more that feed the v2-only surfaces: `session.step.started` and `session.step.failed`; `session.tool.input.delta`, `.input.ended`, `session.tool.called`, `.success` and `.failed`; and `session.execution.started`, `.succeeded`, `.failed` and `.interrupted`. Events without a non-empty string `sessionID` are ignored, and provider token fields are coerced to numbers before any arithmetic.

Consequences worth knowing:

- **No role filtering is needed.** `session.text.delta` and `session.reasoning.delta` are assistant output by construction, so v1's message-role cache, part-type filtering, and part-text extraction have no v2 equivalent — user prompts can no longer leak into the count.
- **Final totals are exact, not heuristic.** `session.step.ended` carries provider-reported `tokens.output` and `tokens.reasoning`, which the meter prefers over its own character-based estimate. The heuristic still drives the live rolling rate, since deltas arrive before any usage report.
- **The settled average describes what streamed.** It is the streamed tokens divided by the time they streamed over, corrected by the provider's count when the two agree within 2x. Reasoning the provider reports but the host never streamed is left out of that comparison, so hidden reasoning cannot inflate the rate.
- **Sessions that go quiet without a terminal event** (crash, cancel, dropped connection) have their working state freed after five minutes. Their last reading stays on screen; retained readings are capped at 64 sessions.

`session.step.ended` reports the same finish reasons as v1 (`stop`, `length`, `tool-calls`, `content-filter`, `error`, `unknown`), so tool-call and error handling behave identically across both hosts: a `tool-calls` finish freezes the reading on screen instead of clearing it, and `unknown` discards it. A `session.step.failed` freezes the reading where it was and still counts any usage the provider reported.

### Output Counted

Only model output contributes to TPS:
- `text` — Assistant output text
- `reasoning` — Assistant reasoning stream
- Tool-call arguments the model writes (v2 only, from `session.tool.input.*`)

Tool results, snapshots, patches and file contents are ignored: they are not tokens the model generated.

### How the Rate Is Measured

Hosts batch output before publishing it (v2 flushes every ~100ms), so each chunk's tokens were
generated over the interval since the previous chunk, not at the instant it arrived. The tracker
rates every chunk over that interval:

- **The opening chunk counts toward the total but never toward a rate.** It was generated over an
  interval the meter never saw (time to first token included). Dividing it by the few milliseconds
  before the first update is what produced five-digit readings.
- **No reading is shown until a rate is measurable** (at least 50ms of generation, normally the
  second chunk). A response that arrives in a single chunk shows only its settled figures.
- **The live rate is the rolling window** (`rollingWindowMs`), timed entirely by the timestamps
  tokens were recorded with: host event times on v2, local time on v1. Clocks are never mixed.
- **A stalled stream shows its rate falling.** If a live stream goes quiet for 250ms its reading is
  republished with the rate as of now, and again every 250ms until the rate reaches zero or output
  resumes.
- **Tool-call arguments are rated like any other chunk**, over the gap since the previous one.
  Many providers deliver a tool call whole, and the host then emits its start and end ~100ms
  apart, so that gap says nothing about how long the model took to write it.
- **A step too short to time** (a single chunk, such as a tool call delivered whole) settles at
  its tokens over the step's whole duration, from when the step began. That includes time to
  first token, so it reads low rather than high.
- **Calibration is weighted by size and saved per model.** Each step's provider count corrects
  the heuristic in proportion to how many tokens it covered, so a short tool call (whose count
  includes call framing) barely moves it. When reasoning streamed but the provider reports
  none, the step is left out, since its count cannot be compared.

---

## Build System

This project uses **Bun** for building dual-format outputs:

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type-check
bun run typecheck

# Build ESM + CJS outputs
bun run build
```

### Build Outputs

- `dist/index.mjs` — ESM build
- `dist/index.js` — CommonJS build (with OpenCode compatibility fix)
- `dist/index.d.ts` — TypeScript declarations
- `dist/tui.mjs` — OpenCode TUI plugin ESM build
- `dist/tui.js` — internal CommonJS TUI artifact generated by the build; public TUI loading uses the ESM `opencode-tps-meter/tui` export
- `dist/tui.d.ts` — OpenCode TUI plugin declarations
- `dist/v2/server.mjs` — OpenCode v2 server plugin (`opencode-tps-meter/v2`)
- `dist/v2/tui.mjs` — OpenCode v2 TUI plugin (`opencode-tps-meter/v2/tui`)
- `dist/v2/*.d.ts` — declarations for the v2 modules
- `dist/package.json` — `{ "type": "commonjs" }`, so the `.js` artifacts load as CommonJS under the root package's `"type": "module"`

**Note:** The CJS build requires a manual export fix for OpenCode compatibility, applied by `build.ts` after bundling:
```typescript
// Removes: module.exports = __toCommonJS(exports_src);
// Appends:
// module.exports = exports_src.default;
// module.exports.default = exports_src.default;
// Object.defineProperty(module.exports, "__esModule", { value: true });
```
`require('opencode-tps-meter')` therefore returns the dual-host plugin object (`{ id, server, setup }`), not a function.

### Benchmarks

```bash
bun run bench             # hotpath, publish, profile, memory and v1path benchmarks
bun bench/latency.ts      # time-to-accurate-reading with v2-style chunking (not part of `bench`)
bun run typecheck:bench   # type-check the benchmark scripts
```

---

## Troubleshooting

### Plugin Not Displaying

- ✅ Verify `TPS_METER_ENABLED` is not set to `false`
- ✅ **v1:** for persistent TUI display, install with `opencode plug opencode-tps-meter@latest` or add the package to OpenCode's TUI config (`~/.config/opencode/tui.json` or `tui.jsonc`)
- ✅ **v2:** use the `"plugins"` key, not `"plugin"` — and note `tui.json`/`tui.jsonc` are no longer read at all, having been replaced by a single global `cli.json`
- ✅ **v2:** register the bare package name (`opencode-tps-meter@latest`); subpath specifiers such as `opencode-tps-meter/v2` are not resolved in `plugins`
- ✅ **Local builds:** register `<repo>/dist`, not the repository root (see [Local builds](#local-builds))
- ✅ **v2:** open the plugin manager dialog (`plugins.list`) and check the plugin is enabled — runtime enable/disable state overrides config
- ✅ **v2:** confirm the host supplies `@opentui/solid` and `solid-js`; a nested copy inside the plugin gives the meter its own reactive graph, so it renders once and then freezes
- ✅ Verify your installed package exposes `opencode-tps-meter/tui` for TUI plugin loading
- ✅ If you still see a `TPS Meter` popup, you are seeing the old server plugin toast path; remove the package from normal OpenCode plugin config or set `toastFallback: false` / `TPS_METER_TOAST_FALLBACK=false`
- ✅ For intentional toast fallback, set `toastFallback: true` and check that OpenCode client has `tui.showToast`, `tui.publish`, or `toast.info` methods
- ✅ Nothing shows until a rate is measurable — at least 50ms of generation, so a response delivered in a single chunk shows only its settled figures
- ✅ Check that `minVisibleTPS` threshold is not set too high

### Two Readouts on OpenCode 2.x

OpenCode 2.x ships its own per-message `tok/s` readout next to each assistant reply. To show only this plugin's meter, set `"tps": false` under `session` in `cli.json`. To keep the built-in readout instead, run `/tps hidden`.

### Cache Segments Missing

`cache N%` and `session cache N%` appear only after a session's first step has finished and the provider has reported usage. This is expected. Also check `showCacheHit` / `TPS_METER_SHOW_CACHE_HIT`.

### High TPS Readings (Fixed)

Five-digit readings such as `TPS: 13590.0` came from dividing a host-batched opening chunk by the few milliseconds before the first update (and, on v1, from user prompts counted as instant tokens). Both are fixed: the opening chunk of a stream counts toward the total but never toward a rate, nothing is shown until a rate is measurable, and only assistant output is tracked. See [How the Rate Is Measured](#how-the-rate-is-measured). Set `initialDisplayDelayMs` to `0` for the lowest latency if you accept a jumpier first reading. If you still see spikes, update to the latest version.

### Incorrect Token Counts

- For general text: Use `fallbackTokenHeuristic: 'chars_div_4'` (default)
- For prose: Use `fallbackTokenHeuristic: 'words_div_0_75'`
- For code: Use `fallbackTokenHeuristic: 'chars_div_3'`
- Remember: Tool outputs, patches, snapshots, and file parts are always excluded from counting
- This plugin uses fast heuristics, not exact tokenizers like gpt-tokenizer; on v2 the final figure is the provider's exact count

### High CPU Usage

- Increase `updateIntervalMs` (try 100ms or 200ms)
- Increase `initialDisplayDelayMs` if the first live reading is too jumpy
- Increase `rollingWindowMs` if using short windows
- Disable `showElapsed` if not needed

### Import Errors

**Main Plugin (ESM & CommonJS):**
```typescript
import TpsMeterPlugin from 'opencode-tps-meter';
// or
const TpsMeterPlugin = require('opencode-tps-meter');
// both are the dual-host object { id, server, setup }
```

**OpenCode TUI Plugin:**
```typescript
import TpsMeterTuiPlugin from 'opencode-tps-meter/tui';
```

Helper modules are internal and are not exported as package subpaths. If you need tracker/tokenizer internals, use a local repository checkout or fork.

---

## Exported Types

```typescript
export type {
  BufferEntry,         // Ring buffer entry structure
  TPSTrackerOptions,   // Tracker configuration
  TPSTracker,          // Tracker interface
  UIManager,           // UI manager interface
  TokenCounter,        // Token counter interface
  Config,              // Plugin configuration
  OpenCodeClient,      // OpenCode client interface
  DisplayState,        // Display state structure
  AgentDisplayState,   // Per-agent display structure
  AgentIdentity,       // Agent identity metadata
  PluginContext,       // Plugin context
  Logger,              // Logger interface
  MessageEvent,        // Event structure
  PluginHandlers,      // Handler return type
} from 'opencode-tps-meter';
```

---

## License

MIT

---

<div align="center">

Made for the OpenCode community

</div>
