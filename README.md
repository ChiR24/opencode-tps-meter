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

## Installation

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

---

## Quick Start

The plugin will automatically hook into OpenCode events and start tracking TPS after installation.

On OpenCode versions that support TUI plugins, the package also exposes `opencode-tps-meter/tui`. OpenCode's installer detects that entrypoint; manual installs need the package listed in TUI config for persistent rendering in the session prompt area.

If you intentionally want the old toast UI for an older OpenCode surface, add the package to normal OpenCode plugin config too and set `toastFallback: true` or `TPS_METER_TOAST_FALLBACK=true`.

### Package Exports

When using the plugin with OpenCode, you only need the default package export. OpenCode TUI plugin loading uses the `opencode-tps-meter/tui` subpath automatically when installed through OpenCode's plugin installer or when listed in TUI config.

```typescript
import TpsMeterPlugin from 'opencode-tps-meter';
import TpsMeterTuiPlugin from 'opencode-tps-meter/tui';
```

Internal tracker/tokenizer/UI helper modules are not public package exports. For experiments or forks, clone the repository and import helpers from local source paths instead of from the published package.

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
```

- `opencode-tps-meter` is the legacy server/toast fallback plugin entrypoint. It does not emit toasts unless `toastFallback` is enabled.
- `opencode-tps-meter/tui` is the persistent OpenCode TUI entrypoint.

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

### Event Handling

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

**Note:** The CJS build requires a manual export fix for OpenCode compatibility:
```typescript
// Replaces: module.exports = __toCommonJS(exports_src);
// With: module.exports = exports_src.default;
```

---

## Troubleshooting

### Plugin Not Displaying

- ✅ Verify `TPS_METER_ENABLED` is not set to `false`
- ✅ For persistent TUI display, install with `opencode plug install opencode-tps-meter@latest` or add the package to OpenCode's TUI config (`~/.config/opencode/tui.json` or `tui.jsonc`)
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
