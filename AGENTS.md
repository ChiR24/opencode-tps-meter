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
│   ├── index.ts          # dual-host module: { id, server (v1), setup (v2) }
│   ├── tui.tsx           # dual-host TUI module: { id, tui (v1), setup (v2) }
│   ├── types.ts          # v1 TypeScript interfaces
│   ├── tracker.ts        # TPS calculation logic (ring buffer) - shared v1/v2
│   ├── tokenCounter.ts   # Heuristic token counting - shared v1/v2
│   ├── config.ts         # Config loading (env + JSON + v2 inline options) - shared
│   ├── constants.ts      # Shared constants
│   ├── format.ts         # Shared meter text formatting (v1 + v2 render identically)
│   ├── ui.ts             # v1 toast/throttling manager (no v2 equivalent)
│   ├── v2/
│   │   ├── types.ts      # Structural v2 API types (events, contexts, slots, storage)
│   │   ├── dispatch.ts   # routes v2 setup() to TUI or server by context shape
│   │   ├── meter.ts      # v2 session tracking core - drives both v2 entries
│   │   ├── metrics.ts    # calibration + turn decomposition (TTFT, tool time)
│   │   ├── ledger.ts     # durable per-model rollup via ctx.storage.store
│   │   ├── server.ts     # v2 server entry (no UI; wire-level TTFB hooks)
│   │   └── tui.tsx       # v2 TUI entry: footer meter, sidebar panel, dashboard
│   └── __tests__/        # Integration + E2E + v2 tests
├── build.ts              # Bun build script (dual format, 4 entrypoints)
├── package.json          # ESM/CJS dual exports + /v2 subpaths
└── tsconfig.json         # Strict TypeScript config
```

**v2 loader constraints (verified against `opencode2` beta 17639 — do not regress):**
1. The default export MUST be an object. v2 validates it against an Effect schema and rejects a
   callable with `SchemaError(Expected object at ["default"])`. The old v1 bare-function style
   cannot load on v2. v1 accepts both a bare function and `{ id, server }`, so the object form is
   the only shape that works on both.
2. Entries in v2's `plugins` array are npm package names or local paths — NOT subpaths.
   `"opencode-tps-meter/v2"` is attempted as a package install and fails. The `/v2` exports are
   for programmatic `import` only.
3. **v2 DOES implement the TUI plugin API** — verified in the shipped `opencode2` beta binary, not
   from the repo. Its own built-in TUI plugins use exactly this package's target API:
   `Plugin.define({ id, setup })`, `ctx.ui.slot({ append: "app", render })`, `ctx.data.on(type, fn)`,
   and a returned cleanup function (see `opencode.notifications`, `diff-viewer`).
   CAUTION when researching this: the GitHub `dev` branch has DIVERGED from the shipped beta.
   On `dev`, `packages/cli/src/tui.ts` passes a stub `pluginHost: { async start(){}, async dispose(){} }`
   and `SlotClaim` has zero usages — which would suggest TUI plugins are unimplemented. That is a
   refactor-in-progress, NOT what ships. `dev`'s `packages/cli` declares only a handful of commands
   while the shipped binary has many more. Always verify against the installed binary.
4. Loader entrypoint rule (`packages/opencode/specs/tui-plugins.md`): if a package has an
   `exports` map, the loader resolves `./tui` or `./server` and **never** falls back to
   `exports["."]`; `main` is server-only. Hence this package publishes both `./server` and `./tui`.
   Modules are target-exclusive — a TUI module exporting `server` is rejected, and vice versa.
5. The root export must NOT statically import `@opentui/solid`. Loading it inside the service
   process dies with `Environment variable "OPENTUI_FORCE_WCWIDTH" is already registered`, which
   fails the plugin load. `src/v2/dispatch.ts` therefore lazy-loads the TUI module behind a
   runtime import and dispatches on context shape.

**Dual-host rule:** v1 files must keep working unchanged against `opencode`. v2 lives under `src/v2/`
and shares only runtime-agnostic modules (tracker, tokenCounter, config, constants, format).
Never import `src/ui.ts` or `src/types.ts` event types from v2 code — those are v1-shaped.

---

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| v1 plugin initialization | `src/index.ts:150` | `.server` member of the default export |
| v1 event handling | `src/index.ts:971` | message.part.updated, message.updated, session.idle |
| v1 TUI meter | `src/tui.tsx` | `session_prompt_right` slot, `api.event.on` |
| v2 tracking core | `src/v2/meter.ts:82` | Drives both v2 entries; v2 event vocabulary |
| v2 TUI meter | `src/v2/tui.tsx:103` | `prompt.footer.status` slot, `ctx.data.on` |
| v2 server entry | `src/v2/server.ts:44` | `ctx.event.subscribe()` async iterable; no UI surface |
| v2 API types | `src/v2/types.ts` | Hand-written structural types for the beta v2 API |
| TPS calculation | `src/tracker.ts:20` | Rolling window, ring buffer (shared v1/v2) |
| Meter text formatting | `src/format.ts:41` | Shared so v1 and v2 render identically |
| UI display (v1 only) | `src/ui.ts:19` | Throttled toast updates; no v2 equivalent |
| Token counting | `src/tokenCounter.ts:129` | Heuristic: chars/4, words/0.75, or chars/3 |
| Configuration | `src/config.ts:319` | Priority: project → global → env → v2 options |
| Type definitions | `src/types.ts` | v1 interfaces; v2 types live in `src/v2/types.ts` |
| Build output | `dist/` | ESM (.mjs) + CJS (.js) + types (.d.ts) + `dist/v2/` |

---

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `TpsMeterPlugin` | Function | `index.ts:150` | v1 handler factory, exported as the module's `.server` |
| `createMeter` | Factory | `v2/meter.ts:82` | v2 session tracking core |
| `setupTui` | Function | `v2/tui.tsx:103` | v2 TUI setup; returns cleanup |
| `setupServer` | Function | `v2/server.ts:44` | v2 server setup; returns cleanup |
| `createTracker` | Factory | `tracker.ts:20` | TPS tracker with ring buffer (shared) |
| `createUIManager` | Factory | `ui.ts:19` | v1 toast display manager with throttling |
| `createTokenizer` | Factory | `tokenCounter.ts:129` | Heuristic token counter (shared) |
| `formatMeterText` | Function | `format.ts:41` | Shared meter line rendering |
| `loadConfigSync` | Function | `config.ts:319` | Config loader (sync), optional overrides |
| `Config` | Interface | `types.ts:13` | Plugin configuration shape |
| `TPSTracker` | Interface | `types.ts:363` | Tracker public API |
| `MessageEvent` | Interface | `types.ts:242` | v1 OpenCode event structure |
| `V2MeterEvent` | Type | `v2/types.ts` | v2 event union the meter consumes |

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

### Event Flow (v1)
1. `message.part.updated` → Count delta tokens → Update tracker → Throttled UI update
2. `message.updated` (completed) → Show final stats
3. `session.idle` → Keep latest visible stats after startup delay → cleanup tracker

### Event Flow (v2)
v2 deleted the whole `message.*` family. Mapping:

| v1 | v2 |
|----|----|
| `message.part.delta` (field `text`) | `session.text.delta` |
| `message.part.updated` (reasoning) | `session.reasoning.delta` |
| `message.updated` (completed) | `session.step.ended` (same finish reasons) |
| `message.updated` (`info.tokens`) | `session.usage.updated` |
| `session.idle` | `session.idle` (unchanged) |

Also changed: event envelope `properties` → `data`; slot `session_prompt_right` →
`prompt.footer.status`; slot prop `session_id` (required) → `sessionID` (optional);
theme `current.textMuted` → `text.subdued` and `current.error` → `text.feedback.error.default`;
`api.event.on` → `ctx.data.on` (TUI) or `ctx.event.subscribe()` async-iterable (server);
`api.lifecycle.onDispose` → return a cleanup fn from `setup`.

No role filtering is needed on v2 — text/reasoning deltas are assistant output by construction.

**Clock discipline.** The TUI flushes events in ~10ms batches, so `Date.now()` inside a handler
is FLUSH time and every event in a batch shares it. Use each event's host-stamped `created`
(`eventTime()` in meter.ts). Note `src/tracker.ts` measures elapsed with its own `Date.now()`,
so v2 derives elapsed from `firstTokenAt`/`lastTokenAt` instead — never mix the two clocks.

**Cumulative vs per-step.** `session.step.ended.tokens` is a PER-STEP DELTA;
`session.usage.updated.tokens` is a CUMULATIVE SESSION TOTAL that also includes auto-title and
compaction. Never substitute one for the other. Their residual is the hidden-overhead metric,
and it is tracked at SESSION scope (`sessionUsage`) because per-turn state is destroyed on every
step end and idle.

**Validate at the v2 event boundary.** Event payloads cross a process boundary from the host,
so `asMeterEvent` rejects anything without a non-empty string `sessionID`, and `toTokenCount`
coerces provider token fields before arithmetic — a non-numeric `tokens.output` would otherwise
turn `output + reasoning` into string concatenation (`"100" + "50"` → `"10050"`) and render a
bogus total. `sweepStaleSessions` drops sessions that go quiet without a terminal event (crash,
cancel, dropped connection produce neither `session.step.ended` nor `session.idle`), reusing the
v1 `MAX_MESSAGE_AGE_MS` / `CLEANUP_INTERVAL_MS` thresholds.

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
4. Inline overrides — v2 plugin `options` from `opencode.json`, passed as `loadConfigSync(overrides)`

Note v2 dropped `tui.json`/`tui.jsonc` entirely (replaced by one global `cli.json`) and renamed
the plugin config key from `plugin` to `plugins`. The plugin's own `tps-meter.json` files are
unaffected.

### Environment Variables
- `TPS_METER_ENABLED` (boolean)
- `TPS_METER_UPDATE_INTERVAL_MS` (number, default: 50)
- `TPS_METER_INITIAL_DISPLAY_DELAY_MS` (number, default: 10)
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
- `@opentui/solid` / `solid-js`: **optional peer** dependencies, not bundled. The TUI host supplies
  the renderer and reactive runtime; a nested copy would give the plugin its own reactive graph and
  the meter would render once and then freeze. v2 pins `@opentui/*` to a dated snapshot
  (`0.0.0-20260808-*`), which is why the peer range is `*` rather than a semver range.
- v2 API types are hand-written in `src/v2/types.ts` rather than imported from
  `@opencode-ai/plugin@next`: v1 and v2 types ship under the same package name so both cannot be
  installed at once, and the v2 API is beta and still changing.
- `gpt-tokenizer`: Optional (listed but not actively used - heuristic fallback)
- `zod`: Listed but not actively used in current implementation
