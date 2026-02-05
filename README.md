<div align="center">

# OpenCode TPS Meter

**Real-time AI token throughput visualization for OpenCode**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-Runtime-000?logo=bun&logoColor=white)](https://bun.sh)
[![OpenCode](https://img.shields.io/badge/OpenCode-Plugin-7C3AED?logo=code&logoColor=white)](https://opencode.ai)
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
- **Noise Suppression** — TPS display starts after 250ms of assistant output to avoid spikes
- **Multi-Session Support** — Isolated tracking per session with automatic cleanup
- **Throttled UI Updates** — Configurable update intervals to prevent UI flooding
- **Optional Time Display** — Elapsed time display (disabled by default, enable with `showElapsed: true`)
- **TPS-Based Color Coding** — Visual feedback with color-coded toasts (red/yellow/green) based on throughput speed
- **Dual Display Modes** — TUI toast notifications with fallback to client.toast
- **Zero Console Logging** — Safe for TUI environments (no console.* calls)
- **Dual Format** — ESM and CommonJS builds for maximum compatibility
- **Heuristic Token Counting** — Fast approximation without heavy dependencies

---

## Installation

This plugin is designed for local installation. Since it's not published to npm, install it from the local directory or git repository:

### From Local Directory

```bash
# Clone or download the repository
cd opencode-tps-plugin

# Install dependencies and build
bun install
bun run build

# Link for local development
bun link
```

Then in your OpenCode project:

```bash
# Link the plugin locally
bun link opencode-tps-meter
```

### From Git Repository

```bash
# Install directly from git
bun add github:ChiR24/opencode-tps-plugin

# Or with npm
npm install github:ChiR24/opencode-tps-plugin
```

### Manual Installation

Copy the `dist` folder from this repository into your project's `node_modules/opencode-tps-meter` directory.

---

## Quick Start

> **Prerequisites:** Make sure you've built the plugin first:
> ```bash
> bun install
> bun run build
> ```

### As OpenCode Plugin (Recommended)

Create a plugin file in your OpenCode project:

```typescript
// File: tps-meter-plugin.ts (or .js)
import TpsMeterPlugin from 'opencode-tps-meter';

// Export the plugin - it automatically hooks into OpenCode events
export default TpsMeterPlugin;
```

Then configure it in your OpenCode config (see Configuration section below).

### Programmatic Usage

For standalone usage (outside of OpenCode plugin context), import from the source files directly:

```typescript
// Import from source files (for development/bundler setups)
import { createTracker } from 'opencode-tps-meter/src/tracker.js';
import { createUIManager } from 'opencode-tps-meter/src/ui.js';
import { createTokenizer, countTokens } from 'opencode-tps-meter/src/tokenCounter.js';
import type { OpenCodeClient } from '@opencode-ai/plugin';

// Or from the built dist files
import { createTracker } from 'opencode-tps-meter/dist/tracker.js';
import { createUIManager } from 'opencode-tps-meter/dist/ui.js';
import { createTokenizer } from 'opencode-tps-meter/dist/tokenCounter.js';

// Initialize components
const tracker = createTracker({ 
  sessionId: 'my-session',
  rollingWindowMs: 2000  // 2-second rolling window
});

const ui = createUIManager(client, { 
  updateIntervalMs: 50,
  format: 'compact',
  showAverage: true,
  showInstant: true,
  showTotalTokens: true,
  showElapsed: false
});

const tokenizer = createTokenizer('heuristic');

// Process streaming tokens
async function processStream(stream: AsyncIterable<string>) {
  for await (const chunk of stream) {
    const tokenCount = tokenizer.count(chunk);
    tracker.recordTokens(tokenCount);
    
    ui.updateDisplay(
      tracker.getInstantTPS(),
      tracker.getAverageTPS(),
      tracker.getTotalTokens(),
      tracker.getElapsedMs()
    );
  }
  
  // Show final stats
  ui.showFinalStats(
    tracker.getTotalTokens(),
    tracker.getAverageTPS(),
    tracker.getElapsedMs()
  );
}
```

**Note:** When using the plugin with OpenCode, you only need the default export. The programmatic API is for advanced use cases where you want to use the TPS tracking components separately.

---

## Configuration

Configuration is loaded from multiple sources in priority order (highest to lowest):

1. **Environment Variables** (`TPS_METER_*`)
2. **Global Config** (`~/.config/opencode/tps-meter.json`)
3. **Project Config** (`.opencode/tps-meter.json`)
4. **Built-in Defaults**

> **Note:** Later sources override earlier ones. Environment variables have the highest priority and override all config files. Project config overrides global config.

### Environment Variables

```bash
# Core settings
TPS_METER_ENABLED=true                    # Enable/disable plugin
TPS_METER_UPDATE_INTERVAL_MS=50           # UI update throttle (ms)
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
TPS_METER_ENABLE_COLOR_CODING=false       # Enable color-coded toasts
TPS_METER_SLOW_TPS_THRESHOLD=10           # Below this = red (slow)
TPS_METER_FAST_TPS_THRESHOLD=50           # Above this = green (fast)
```

### JSON Configuration

Create `.opencode/tps-meter.json` in your project root:

```json
{
  "enabled": true,
  "updateIntervalMs": 50,
  "rollingWindowMs": 1000,
  "showAverage": true,
  "showInstant": true,
  "showTotalTokens": true,
  "showElapsed": false,
  "format": "compact",
  "minVisibleTps": 0,
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
| `updateIntervalMs` | `number` | `50` | UI update interval in milliseconds |
| `rollingWindowMs` | `number` | `1000` | Rolling window for TPS calculation |
| `showAverage` | `boolean` | `true` | Show average TPS in display |
| `showInstant` | `boolean` | `true` | Show instantaneous TPS in display |
| `showTotalTokens` | `boolean` | `true` | Show total token count |
| `showElapsed` | `boolean` | `false` | Show elapsed time |
| `format` | `string` | `"compact"` | Display format: `compact`, `verbose`, `minimal` |
| `minVisibleTps` | `number` | `0` | Minimum TPS value to trigger display |
| `fallbackTokenHeuristic` | `string` | `"chars_div_4"` | Token counting method |
| `enableColorCoding` | `boolean` | `false` | Enable TPS-based color coding |
| `slowTpsThreshold` | `number` | `10` | TPS below this shows red (slow) |
| `fastTpsThreshold` | `number` | `50` | TPS above this shows green (fast) |

---

## Color Coding

Enable visual feedback with color-coded toasts based on token throughput speed:

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

**Note:** Color coding requires TUI toast methods (`client.tui.showToast` or `client.tui.publish`). The fallback `client.toast` methods only support info/success variants.

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

## API Reference

**Prerequisite:** Build the plugin first to generate the `dist/` folder:
```bash
cd opencode-tps-meter
bun install
bun run build
```

### `createTracker(options?)`

Factory function that creates a TPS tracker with rolling window calculation using a ring buffer (max 100 entries).

```typescript
import { createTracker } from 'opencode-tps-meter/dist/tracker.js';

interface TPSTrackerOptions {
  sessionId?: string;        // Optional session identifier
  rollingWindowMs?: number;  // Window duration (default: 2000ms)
}

const tracker = createTracker({
  sessionId: 'my-session',
  rollingWindowMs: 2000
});

// Methods
tracker.recordTokens(count: number, timestamp?: number): void
tracker.getInstantTPS(): number           // TPS over rolling window
tracker.getAverageTPS(): number            // TPS over entire session
tracker.getTotalTokens(): number           // Total tokens recorded
tracker.getElapsedMs(): number              // Elapsed time in ms
tracker.getSessionId(): string | undefined  // Session identifier
tracker.getBufferSize(): number             // Current buffer entries
tracker.getMaxBufferSize(): number          // Max buffer capacity (100)
tracker.getWindowMs(): number               // Rolling window duration
tracker.reset(): void                        // Reset all tracking data
```

### `createUIManager(client, config)`

Factory function that creates a UI manager with throttled display updates and automatic fallback.

```typescript
import { createUIManager } from 'opencode-tps-meter/dist/ui.js';

const ui = createUIManager(client, {
  updateIntervalMs: 50,
  format: 'compact',
  showAverage: true,
  showInstant: true,
  showTotalTokens: true,
  showElapsed: false
});

// Methods
ui.updateDisplay(instantTps, avgTps, totalTokens, elapsedMs): void
ui.showFinalStats(totalTokens, avgTps, elapsedMs): void  // Immediate display
ui.clear(): void                                         // Cleanup resources
ui.setUpdateInterval(ms: number): void                   // Change throttle
```

**Display Priority:**
1. `client.tui.showToast()` — Primary method
2. `client.tui.publish()` — Fallback for TUI events
3. `client.toast.info/success()` — Final fallback

### `createTokenizer(type?)`

Factory function for heuristic token counters.

```typescript
import { createTokenizer } from 'opencode-tps-meter/dist/tokenCounter.js';

// Available types
const tokenizer = createTokenizer('heuristic');  // Math.ceil(chars / 4) - Default
const tokenizer = createTokenizer('word');       // Math.ceil(words / 0.75)
const tokenizer = createTokenizer('code');        // Math.ceil(chars / 3)

// Use the counter
const count = tokenizer.count('Hello, world!');  // Returns: number
```

### Helper Functions

```typescript
import { countTokens, encodeText } from 'opencode-tps-meter/dist/tokenCounter.js';

// Direct token counting with default heuristic
const tokens = countTokens('Hello, world!');

// Encode placeholder (returns empty array)
const encoded = encodeText('text');  // Returns: []
```

### Individual Counter Creators

```typescript
import { 
  createHeuristicCounter,   // char/4 based
  createWordHeuristicCounter,  // word/0.75 based
  createCodeHeuristicCounter   // char/3 based
} from 'opencode-tps-meter/dist/tokenCounter.js';

const counter = createHeuristicCounter();
const count = counter.count('Hello, world!');
```

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

The plugin subscribes to three OpenCode event types:

1. **`message.part.updated`** — Processes streaming token chunks
   - **Role Filtering**: Only tracks parts belonging to messages with `role: "assistant"`
   - **User prompts excluded**: Prevents TPS spikes from user input (which would appear as thousands of TPS since prompts arrive instantly)
   - **Counted parts**: Only `text` and `reasoning` are counted toward TPS
   - **Ignored parts**: `tool`, `patch`, `snapshot`, `file`, `subtask`, `agent`, `retry`, `compaction`
   - **Minimum elapsed time**: TPS display begins only after 250ms of assistant output
   - Calculates delta tokens between consecutive updates
   - Updates tracker and throttled UI display

2. **`message.updated`** — Handles message status changes
   - Records role information (`user`, `assistant`, `system`) for each message ID
   - Used to filter parts in `message.part.updated` events
   - Processes official token counts from API responses when available
   - Displays final stats when message completes

3. **`session.idle`** — Cleanup trigger
   - Removes tracker for the specific session
   - Clears all session-specific caches (role cache, token cache, part text cache)
   - Cleans up UI when no active sessions remain

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

**Note:** The CJS build requires a manual export fix for OpenCode compatibility:
```typescript
// Replaces: module.exports = __toCommonJS(exports_src);
// With: module.exports = exports_src.default();
```

---

## Troubleshooting

### Plugin Not Displaying

- ✅ Verify `TPS_METER_ENABLED` is not set to `false`
- ✅ Check that OpenCode client has `tui.showToast`, `tui.publish`, or `toast.info` methods
- ✅ Ensure you're viewing **assistant role** messages (user/system are filtered)
- ✅ Check that `minVisibleTps` threshold is not set too high

### High TPS on First Message (Fixed)

If you see extremely high TPS values (e.g., `TPS: 13590.0`) on the first message of a session, this is now fixed. The plugin now:
- Filters out **user prompts** (which would count as instant tokens)
- Only tracks **assistant responses** (actual AI output)
- Excludes **file parts** from token counting
- Applies a **250ms minimum elapsed time** before showing TPS

If you still see issues, ensure you're on the latest version with role filtering enabled.

### Incorrect Token Counts

- For general text: Use `fallbackTokenHeuristic: 'chars_div_4'` (default)
- For prose: Use `fallbackTokenHeuristic: 'words_div_0_75'`
- For code: Use `fallbackTokenHeuristic: 'chars_div_3'`
- Remember: Tool outputs, patches, snapshots, and file parts are always excluded from counting
- This plugin uses fast heuristics, not exact tokenizers like gpt-tokenizer

### High CPU Usage

- Increase `updateIntervalMs` (try 100ms or 200ms)
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

**Source/Dist files (for programmatic API):**
```typescript
// From built dist files
import { createTracker } from 'opencode-tps-meter/dist/tracker.js';
import { createUIManager } from 'opencode-tps-meter/dist/ui.js';
import { createTokenizer } from 'opencode-tps-meter/dist/tokenCounter.js';

// Or from source (if your bundler supports it)
import { createTracker } from 'opencode-tps-meter/src/tracker.js';
import { createUIManager } from 'opencode-tps-meter/src/ui.js';
import { createTokenizer } from 'opencode-tps-meter/src/tokenCounter.js';
```

Both formats include full TypeScript declarations.

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
  UIManagerConfig,     // UI configuration
  DisplayState,        // Display state structure
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
