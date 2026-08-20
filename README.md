

<div align="center">

# OpenCode TPS Meter

**Real-time AI token throughput visualization for OpenCode**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-Runtime-000?logo=bun&logoColor=white)](https://bun.sh)
[![OpenCode](https://img.shields.io/badge/OpenCode-Plugin-7C3AED?logo=code&logoColor=white)](https://opencode.ai)
[![NPM Version](https://img.shields.io/npm/v/opencode-tps-meter.svg)](https://www.npmjs.com/package/opencode-tps-meter)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

```
╔══════════════════════════════════════════════════╗
║  TPS: 92.4 (avg 78.1) | tokens: 1,842            ║
╚══════════════════════════════════════════════════╝
```

A live tokens-per-second meter plugin for OpenCode. Track AI token throughput in real-time with a configurable rolling window display. Only tracks **assistant role** messages — user and system messages are automatically excluded from metrics. File parts are also excluded from token counting.

> **Note:** Time display is disabled by default. Enable with `showElapsed: true` in configuration.

---

## Features

- **Runs on both OpenCode generations** — one package, v1 (`opencode`) and v2 beta (`opencode2`)
- **Exact final totals on v2** — provider-reported token counts replace the heuristic estimate when the turn ends
- **Real-time Monitoring** — Live TPS calculation with configurable rolling window
- **Smart Filtering** — Tracks only assistant text/reasoning, excludes user prompts, tools, patches, snapshots, and files
- **Noise Suppression** — TPS display starts after a configurable 10ms startup delay for fast live feedback
- **Multi-Session Support** — Isolated tracking per session with automatic cleanup
- **Throttled UI Updates** — Configurable update intervals to prevent UI flooding
- **Optional Time Display** — Elapsed time display (disabled by default, enable with `showElapsed: true`)
- **TPS-Based Color Coding** — Visual feedback with color-coded persistent TUI text based on throughput speed
- **Persistent TUI Meter** — OpenCode TUI slot display beside the session prompt on supported versions
- **Opt-in Toast Fallback** — Legacy toast UI is disabled by default; enable it only for older OpenCode surfaces
- **Zero Console Logging** — Safe for TUI environments (no console.* calls)
- **Dual Format** — ESM and CommonJS builds for maximum compatibility
- **Heuristic Token Counting** — Fast approximation without heavy dependencies

---

## OpenCode version support

One package supports both OpenCode generations. They install as separate binaries (`opencode` and `opencode2`) and can run side by side.

| | OpenCode v1 (`opencode`) | OpenCode v2 beta (`opencode2`) |
|---|---|---|
| Config key | `"plugin"` | `"plugins"` |
| Meter renders in | TUI session prompt | TUI prompt footer status |
| Registered as | `opencode-tps-meter` | `opencode-tps-meter` |
| Default export shape | function *or* `{ id, server }` | `{ id, setup }` (object required) |
| Toast fallback | Available (opt-in) | Not available — v2 server plugins have no UI surface |

> **v2 is beta.** Its plugin API is documented as subject to change before 2.0 is stable. Verified against `opencode2` beta `0.0.0-beta-17639`, whose shipped binary implements the v2 TUI plugin API this package targets — its own built-in TUI plugins (`opencode.notifications`, `diff-viewer`) use `Plugin.define({ id, setup })` with `ctx.ui.slot({ append, render })` and `ctx.data.on(...)`.

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

v2 support ships as a **prerelease**, because `opencode2` is beta and its plugin API may still
change. Install it explicitly:

```bash
npm install opencode-tps-meter@beta
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

---

## Quick Start

The plugin hooks into OpenCode events and starts tracking TPS after installation.

On v1, the meter renders in the session prompt area via `opencode-tps-meter/tui`. OpenCode's installer detects that entrypoint; manual installs need the package listed in TUI config.

On v2, TUI plugins are registered in the global `~/.config/opencode/cli.json` under `plugins` (auto-migrated from v1's `tui.json`). Per OpenCode's loader spec, a package with an `exports` map is resolved via `./tui` or `./server` and **never** falls back to `exports["."]`, so this package publishes both.

**Registering a local checkout on v2:** a path spec must point at the built TUI **file**, not the
package directory. v2's TUI loader resolves a directory spec by appending `/tui` and opening that path
literally — it does not consult `package.json` `exports` and does not try extensions, so a directory
entry fails with `ENOENT ... open '<dir>/tui'`:

```json
{ "plugins": ["file:///abs/path/to/opencode-tps-meter/dist/tui.mjs"] }
```

`exports["./tui"]` is only used for npm-package specs (`"opencode-tps-meter"`).

**Note on the v2 TUI module shape:** v2 requires `{ id, setup }`. Plugins exporting only v1's
`{ id, tui }` are rejected by the loader. This package's TUI module exports both keys, so it satisfies
v1 and v2 from one file.

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

### v2-only capabilities

These need APIs that do not exist on v1, so they are inert on `opencode`.

| Feature | What you get | v2 API |
|---|---|---|
| Calibrated live rate | The streaming estimate is corrected against provider token counts, learned per model | `session.step.started` (model/agent) + `session.step.ended` (tokens) |
| Generation vs end-to-end TPS | Tool execution subtracted, so a turn that waited on a shell command still reports the model's real rate | `session.tool.called` / `.success` / `.failed` |
| Time to first token | Measured from turn start on the host clock | `session.execution.started` + event `created` |
| Hidden overhead | Tokens spent on auto-title and compaction that no step reports | `session.usage.updated` residual |
| Per-subagent breakdown | Sidebar panel with exact parent/child attribution | `ctx.data.session.root` / `.family` |
| Durable ledger + dashboard | Per-model mean/best throughput and TTFT, persisted and shared across windows | `ctx.storage.store`, `ctx.ui.router` |
| Wire-level TTFB | Provider dispatch to response headers, below the streaming pipeline | `ctx.session.hook("http.request"/"http.response")` |

Every one of these is feature-detected. A host that exposes none of the optional APIs still gets
the footer meter and nothing else.

**Commands** (palette, `/tps`, or a key you bind):

```text
/tps              open the throughput dashboard
/tps detail       toast with current stats
/tps detailed     footer shows gen / ttft / overhead
/tps compact      default footer
/tps hidden       hide the meter
/tps reset        clear the durable ledger
```

**Latency.** Token counting is incremental — each chunk is scanned once and never re-read, so
absorbing a long response is linear rather than quadratic. On v2 the displayed rate also uses a
shorter EWMA half-life (120ms vs v1's 250ms), since host-clock timestamps make the rolling
window accurate enough that extra exponential smoothing mostly just adds lag. The v2 display throttle defaults to 8ms — the host delivers events in ~10ms batches, so
publishing faster cannot reveal anything new — and the publish itself is synchronous, so a
delta is visible in about a millisecond. v1 keeps its 50ms default for the costlier toast path.
Tune with `updateIntervalMs` (display throttle) and `rollingWindowMs` (averaging window); an
explicit value overrides the default on either host.

**Clock note.** The TUI delivers events in ~10ms batches, so wall-clock time inside a handler is
flush time shared by the whole batch. All timing uses each event's host-stamped `created`.

### Peer dependencies

`@opentui/solid` and `solid-js` are optional peer dependencies rather than bundled dependencies. The TUI host supplies the renderer and reactive runtime; installing a second copy inside the plugin would give it a separate reactive graph and the meter would render once and never update.

---

## Configuration

Configuration starts with built-in defaults, then merges these sources in order (later sources override earlier ones):

1. **Built-in Defaults**
2. **Project Config** (`.opencode/tps-meter.json`)
3. **Global Config** (`~/.config/opencode/tps-meter.json`)
4. **Environment Variables** (`TPS_METER_*`)

> **Note:** Environment variables have the highest priority and override all config files. Global config overrides project config in the current implementation.

### Environment Variables

```bash
# Core settings
TPS_METER_ENABLED=true                   # Enable/disable plugin
TPS_METER_TOAST_FALLBACK=false           # Opt into old toast UI when needed
TPS_METER_UPDATE_INTERVAL_MS=50          # UI update throttle (ms)
TPS_METER_INITIAL_DISPLAY_DELAY_MS=10    # First live display delay; set 0 for absolute fastest
TPS_METER_ROLLING_WINDOW_MS=1000          # TPS calculation window (ms)
TPS_METER_FORMAT=compact                  # compact | verbose | minimal
TPS_METER_MIN_VISIBLE_TPS=0               # Minimum TPS to display

# Display toggles
TPS_METER_SHOW_AVERAGE=true
TPS_METER_SHOW_INSTANT=true
TPS_METER_SHOW_TOTAL_TOKENS=true
TPS_METER_SHOW_ELAPSED=false

# Token counting heuristic
TPS_METER_FALLBACK_HEURISTIC=chars_div_4  # chars_div_4 | chars_div_3 | words_div_0_75

# Color coding (visual feedback based on TPS speed)
TPS_METER_ENABLE_COLOR_CODING=false       # Enable color-coded TUI text
TPS_METER_SLOW_TPS_THRESHOLD=10           # Below this = red (slow)
TPS_METER_FAST_TPS_THRESHOLD=50           # Above this = green (fast)
```

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
  "showElapsed": true,
  "format": "compact"
}
```

Output: `TPS: 92.4 (avg 78.1) | tokens: 1,842 | 00:23`

### Default Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the plugin |
| `toastFallback` | `boolean` | `false` | Emit legacy toast notifications from the server plugin |
| `updateIntervalMs` | `number` | `50` | UI update interval in milliseconds |
| `initialDisplayDelayMs` | `number` | `10` | Startup delay before the first live TPS display; set `0` for absolute fastest updates |
| `rollingWindowMs` | `number` | `1000` | Rolling window for TPS calculation |
| `showAverage` | `boolean` | `true` | Show average TPS in display |
| `showInstant` | `boolean` | `true` | Show instantaneous TPS in display |
| `showTotalTokens` | `boolean` | `true` | Show total token count |
| `showElapsed` | `boolean` | `false` | Show elapsed time |
| `format` | `string` | `"compact"` | Display format: `compact`, `verbose`, `minimal` |
| `minVisibleTPS` | `number` | `0` | Minimum TPS value to trigger display |
| `fallbackTokenHeuristic` | `string` | `"chars_div_4"` | Token counting method |
| `enableColorCoding` | `boolean` | `false` | Enable TPS-based color coding |
| `slowTpsThreshold` | `number` | `10` | TPS below this shows red (slow) |
| `fastTpsThreshold` | `number` | `50` | TPS above this shows green (fast) |

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
| 🟢 **Green** | Final stats | Message complete |

**Note:** Persistent TUI display supports color coding directly. Legacy toast color coding is available only when `toastFallback` is enabled and OpenCode exposes TUI toast methods (`client.tui.showToast` or `client.tui.publish`); the fallback `client.toast` methods only support info/success variants.

---

## Display Formats

### Compact (Default)
```
TPS: 92.4 (avg 78.1) | tokens: 1,842
```

### Compact with Time (showElapsed: true)
```
TPS: 92.4 (avg 78.1) | tokens: 1,842 | 00:23
```

### Verbose
```
TPS Meter — Instant: 92.4 tokens/sec | Average: 78.1 tokens/sec | Total: 1,842 tokens
```

### Verbose with Time (showElapsed: true)
```
TPS Meter — Instant: 92.4 tokens/sec | Average: 78.1 tokens/sec | Total: 1,842 tokens | Duration: 23s
```

### Minimal
```
92.4 TPS (1,842 tokens)
```

---

## Package API

The published package exposes only the OpenCode plugin entrypoints:

```typescript
import TpsMeterPlugin from 'opencode-tps-meter';
import TpsMeterTuiPlugin from 'opencode-tps-meter/tui';
import TpsMeterV2 from 'opencode-tps-meter/v2';
import TpsMeterV2Tui from 'opencode-tps-meter/v2/tui';
```

- `opencode-tps-meter` is the v1 server/toast fallback entrypoint. It does not emit toasts unless `toastFallback` is enabled. The exported function also carries `id` and `setup` properties so a v2 host can load the same module.
- `opencode-tps-meter/tui` is the persistent v1 TUI entrypoint. The exported object carries both `tui` (v1) and `setup` (v2).
- `opencode-tps-meter/v2` and `opencode-tps-meter/v2/tui` are plain `{ id, setup }` v2 definitions with no callable v1 shape, for hosts that reject the dual-shaped modules.

Tracker, tokenizer, and UI helper modules are internal implementation details and are not exported as public package subpaths. If you need those helpers for experimentation, clone or fork the repository and import them from local source files.

---

## Token Counting Heuristics

| Method | Algorithm | Best For | Accuracy |
|--------|-----------|----------|----------|
| `chars_div_4` | `Math.ceil(chars / 4)` | General text | ~75% |
| `words_div_0_75` | `Math.ceil(words / 0.75)` | English prose | ~80% |
| `chars_div_3` | `Math.ceil(chars / 3)` | Code | ~70% |

**Note:** This plugin uses fast heuristic token counting. It does not include gpt-tokenizer or similar heavy tokenization libraries to keep the bundle size small and avoid bundling issues.

---

## How It Works

### Event Handling (OpenCode v1)

The plugin subscribes to four OpenCode event types:

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
   - Records role information (`user`, `assistant`, `system`) for each message ID
   - Used to filter parts in `message.part.updated` events
   - Processes official token counts from API responses when available
   - Displays final stats when message completes

4. **`session.idle`** — Persistence and cleanup trigger
   - Keeps the latest streamed TPS stats visible as an inactive status once the startup delay has elapsed
   - Removes tracker for the specific session
   - Clears all session-specific caches (role cache, token cache, part text cache)
   - Preserves completed session stats

### Event Handling (OpenCode v2)

v2 removed the entire `message.*` event family and replaced it with granular session events. The v2 entries subscribe to five:

| v1 event | v2 replacement |
|---|---|
| `message.part.delta` (field `text`) | `session.text.delta` |
| `message.part.updated` (reasoning) | `session.reasoning.delta` |
| `message.updated` (completed) | `session.step.ended` |
| `message.updated` (`info.tokens`) | `session.usage.updated` |
| `session.idle` | `session.idle` (unchanged) |

Two consequences worth knowing:

- **No role filtering is needed.** `session.text.delta` and `session.reasoning.delta` are assistant output by construction, so v1's message-role cache, part-type filtering, and part-text extraction have no v2 equivalent — user prompts can no longer leak into the count.
- **Final totals are exact, not heuristic.** `session.step.ended` carries provider-reported `tokens.output` and `tokens.reasoning`, which the meter prefers over its own character-based estimate. The heuristic still drives the live rolling rate, since deltas arrive before any usage report.

`session.step.ended` reports the same finish reasons as v1 (`stop`, `length`, `tool-calls`, `content-filter`, `error`, `unknown`), so tool-call and error handling behave identically across both hosts: a `tool-calls` finish freezes the reading on screen instead of clearing it, and `unknown` discards it.

### Part Types Counted

Only these message part types contribute to TPS:
- `text` — Assistant output text
- `reasoning` — Assistant reasoning stream

All other part types are ignored to avoid counting tool output, snapshots, patches, or file contents as model tokens.

### Ring Buffer

The tracker uses a fixed-size ring buffer (max 100 entries) with automatic pruning:
- Removes entries older than the rolling window
- Enforces maximum size with FIFO eviction
- Efficient for high-frequency token streams

---

## Build System

This project uses **Bun** for building dual-format outputs:

```bash
# Install dependencies
bun install

# Run tests
bun test

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

**Note:** The CJS build requires a manual export fix for OpenCode compatibility:
```typescript
// Replaces: module.exports = __toCommonJS(exports_src);
// With:
// module.exports = exports_src.default;
// module.exports.default = exports_src.default;
// Object.defineProperty(module.exports, "__esModule", { value: true });
```

---

## Troubleshooting

### Plugin Not Displaying

- ✅ Verify `TPS_METER_ENABLED` is not set to `false`
- ✅ **v1:** for persistent TUI display, install with `opencode plug install opencode-tps-meter@latest` or add the package to OpenCode's TUI config (`~/.config/opencode/tui.json` or `tui.jsonc`)
- ✅ **v2:** use the `"plugins"` key, not `"plugin"` — and note `tui.json`/`tui.jsonc` are no longer read at all, having been replaced by a single global `cli.json`
- ✅ **v2:** if the bare package name does not load, register the explicit entries `opencode-tps-meter/v2` and `opencode-tps-meter/v2/tui`
- ✅ **v2:** confirm the host supplies `@opentui/solid` and `solid-js`; a nested copy inside the plugin gives the meter its own reactive graph, so it renders once and then freezes
- ✅ Verify your installed package exposes `opencode-tps-meter/tui` for TUI plugin loading
- ✅ If you still see a `TPS Meter` popup, you are seeing the old server plugin toast path; remove the package from normal OpenCode plugin config or set `toastFallback: false` / `TPS_METER_TOAST_FALLBACK=false`
- ✅ For intentional toast fallback, set `toastFallback: true` and check that OpenCode client has `tui.showToast`, `tui.publish`, or `toast.info` methods
- ✅ Ensure you're viewing **assistant role** messages (user/system are filtered)
- ✅ Check that `minVisibleTPS` threshold is not set too high

### High TPS on First Message (Fixed)

If you see extremely high TPS values (e.g., `TPS: 13590.0`) on the first message of a session, this is now fixed. The plugin now:
- Filters out **user prompts** (which would count as instant tokens)
- Only tracks **assistant responses** (actual AI output)
- Excludes **file parts** from token counting
- Applies a configurable **10ms startup delay** before showing TPS; set `initialDisplayDelayMs` to `0` for the lowest latency if you accept a jumpier first reading

If you still see issues, ensure you're on the latest version with role filtering enabled.

### Incorrect Token Counts

- For general text: Use `fallbackTokenHeuristic: 'chars_div_4'` (default)
- For prose: Use `fallbackTokenHeuristic: 'words_div_0_75'`
- For code: Use `fallbackTokenHeuristic: 'chars_div_3'`
- Remember: Tool outputs, patches, snapshots, and file parts are always excluded from counting
- This plugin uses fast heuristics, not exact tokenizers like gpt-tokenizer

### High CPU Usage

- Increase `updateIntervalMs` (try 100ms or 200ms)
- Increase `initialDisplayDelayMs` if the first live reading is too jumpy
- Increase `rollingWindowMs` if using short windows
- Disable `showElapsed` if not needed
- Check buffer size with `tracker.getBufferSize()`

### Import Errors

**Main Plugin (ESM & CommonJS):**
```typescript
import TpsMeterPlugin from 'opencode-tps-meter';
// or
const TpsMeterPlugin = require('opencode-tps-meter');
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
