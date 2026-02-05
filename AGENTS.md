# OpenCode TPS Meter - Project Knowledge Base

**Generated:** 2026-02-03
**Type:** TypeScript/Bun Plugin
**Purpose:** Live tokens-per-second meter for OpenCode AI sessions

---

## OVERVIEW

OpenCode plugin that tracks AI token throughput in real-time. Displays TPS statistics with a rolling 2-second window using toast notifications or TUI status bar.

**Stack:** TypeScript 5.x, Bun runtime, dual-format builds (ESM + CJS)

---

## STRUCTURE

```
./
├── src/
│   ├── index.ts          # Plugin entry point - event handlers
│   ├── types.ts          # All TypeScript interfaces
│   ├── tracker.ts        # TPS calculation logic (ring buffer)
│   ├── ui.ts             # Display/throttling manager
│   ├── tokenCounter.ts   # Heuristic token counting
│   ├── config.ts         # Config loading (env + JSON files)
│   └── __tests__/        # Integration + E2E tests
├── build.ts              # Bun build script (dual format)
├── package.json          # ESM/CJS dual exports
└── tsconfig.json         # Strict TypeScript config
```

---

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Plugin initialization | `src/index.ts:121` | Main export, event handler registration |
| Event handling | `src/index.ts:359` | message.part.updated, message.updated, session.idle |
| TPS calculation | `src/tracker.ts:24` | 2-second rolling window, ring buffer |
| UI display | `src/ui.ts:18` | Throttled updates, toast/TUI dual mode |
| Token counting | `src/tokenCounter.ts:22` | Heuristic: chars/4, words/0.75, or chars/3 |
| Configuration | `src/config.ts:231` | Priority: project → global → env |
| Type definitions | `src/types.ts` | All interfaces exported |
| Build output | `dist/` | ESM (.mjs) + CJS (.js) + types (.d.ts) |

---

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `TpsMeterPlugin` | Function | `index.ts:121` | Main plugin export, initializes tracking |
| `createTracker` | Factory | `tracker.ts:24` | TPS tracker with ring buffer |
| `createUIManager` | Factory | `ui.ts:18` | Display manager with throttling |
| `createTokenizer` | Factory | `tokenCounter.ts:93` | Heuristic token counter |
| `loadConfigSync` | Function | `config.ts:231` | Config loader (sync) |
| `Config` | Interface | `types.ts:13` | Plugin configuration shape |
| `TPSTracker` | Interface | `types.ts:316` | Tracker public API |
| `MessageEvent` | Interface | `types.ts:212` | OpenCode event structure |

---

## CONVENTIONS

- **ESM-first**: Source uses `.js` extensions for imports
- **Dual exports**: `dist/index.mjs` (ESM) + `dist/index.js` (CJS)
- **Strict TypeScript**: `strict: true`, `forceConsistentCasingInFileNames`
- **Bun-native**: Uses `bun:test`, `Bun.build()`, `Bun.spawn()`
- **No console logging**: All logging through OpenCode's logger interface
- **Sync config loading**: `loadConfigSync()` - no async config

---

## ANTI-PATTERNS (CRITICAL)

| Pattern | Why Forbidden | Location |
|---------|---------------|----------|
| **`console.*` calls** | TUI log leak during resize. SDK spawns TUI with `stdio: "inherit"` causing console output to bypass TUI redraw | `index.ts:125-134`, `config.ts:128-137` |
| **Throwing config errors** | Silently ignore invalid configs to prevent TUI corruption | `config.ts:128-137` |
| **Direct module.exports** | CJS requires special handling for OpenCode compatibility | `build.ts:46-60` |

---

## UNIQUE STYLES

### Dual-Format Build (build.ts)
- ESM build: `format: "esm"`, outputs `.mjs`
- CJS build: `format: "cjs"`, outputs `.js`
- **CRITICAL FIX**: CJS export manually patched to unwrap plugin function:
  ```typescript
  cjsContent.replace(
    /module\.exports = __toCommonJS\(exports_src\);/,
    `module.exports = exports_src.default();`
  );
  ```

### Token Counting Heuristics
- `chars_div_4`: Default, ~75% accuracy for English
- `chars_div_3`: Code-optimized
- `words_div_0_75`: Prose-optimized

### Event Flow
1. `message.part.updated` → Count delta tokens → Update tracker → Throttled UI update
2. `message.updated` (completed) → Show final stats
3. `session.idle` → Cleanup tracker

---

## COMMANDS

```bash
# Development
bun install                    # Install dependencies
bun test                       # Run integration + E2E tests
bun run build                  # Build dual-format output

# Build output
# - dist/index.mjs (ESM)
# - dist/index.js (CJS - OpenCode compatible)
# - dist/index.d.ts (TypeScript declarations)
```

---

## NOTES

### Config Loading Priority
1. `.opencode/tps-meter.json` (project-level)
2. `~/.config/opencode/tps-meter.json` (global)
3. Environment variables (`TPS_METER_*`)

### Environment Variables
- `TPS_METER_ENABLED` (boolean)
- `TPS_METER_UPDATE_INTERVAL_MS` (number, default: 50)
- `TPS_METER_ROLLING_WINDOW_MS` (number, default: 1000)
- `TPS_METER_FORMAT` (compact|verbose|minimal)
- `TPS_METER_FALLBACK_HEURISTIC` (chars_div_4|chars_div_3|words_div_0_75)

### Testing
- Uses `bun:test` (not Jest/Vitest)
- Integration tests simulate full OpenCode event flow
- E2E tests verify module exports and config loading
- Mock OpenCode context required for testing

### Dependencies
- `@opencode-ai/plugin`: Peer dependency (external in build)
- `gpt-tokenizer`: Optional (listed but not actively used - heuristic fallback)
- `zod`: Listed but not actively used in current implementation
