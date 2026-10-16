# OpenCode TPS Meter - Project Knowledge Base

**Last synced with code:** 2026-10-16 (v0.4.1)
**Type:** TypeScript/Bun Plugin
**Purpose:** Live tokens-per-second meter for OpenCode AI sessions

---

## OVERVIEW

OpenCode plugin that tracks AI token throughput in real-time. The primary surface is a persistent TUI meter (v1: `session_prompt_right` slot; v2: footer next to `prompt.footer.status`) showing a rolling-window rate (default 1s), session averages, prompt cache hit rate, and a multi-session aggregate while subagents run. v1 additionally has an opt-in toast fallback (`toastFallback`); v2 adds a sidebar panel, a dashboard and `/tps` commands.

**Stack:** TypeScript 5.x, Bun runtime, dual-format builds (ESM + CJS)

---

## STRUCTURE

```
./
├── src/
│   ├── index.ts          # dual-host module: { id, server (v1), setup (v2) }
│   ├── tui.tsx           # dual-host TUI module: { id, tui (v1), setup (v2) }
│   ├── types.ts          # v1 TypeScript interfaces
│   ├── tracker.ts        # interval-based rate tracking + correctedAverage - shared v1/v2
│   ├── tokenCounter.ts   # Heuristic + incremental token counting - shared v1/v2
│   ├── config.ts         # Config loading (env + JSON + v2 inline options) - shared
│   ├── constants.ts      # Shared constants
│   ├── format.ts         # Shared meter text formatting (v1 + v2 render identically)
│   ├── agentName.ts      # v1 message-payload agent name extraction (server + TUI share it)
│   ├── ui.ts             # v1 toast/throttling manager (no v2 equivalent)
│   ├── bun-test.d.ts     # ambient `bun:test` typings so tests typecheck
│   ├── v2/
│   │   ├── types.ts      # Structural v2 API types (events, contexts, slots, storage)
│   │   ├── dispatch.ts   # routes v2 setup() to TUI or server by context shape
│   │   ├── meter.ts      # v2 session tracking core - drives both v2 entries
│   │   ├── metrics.ts    # calibration + turn decomposition (TTFT, tool time)
│   │   ├── family.ts     # pure multi-session footer aggregation (select/label/format Σ line)
│   │   ├── ledger.ts     # durable per-model rollup via ctx.storage.store
│   │   ├── server.ts     # v2 server entry (no UI; wire-level TTFB hooks)
│   │   └── tui.tsx       # v2 TUI entry: footer meter, sidebar panel, dashboard, /tps commands
│   └── __tests__/        # bun:test suites (see Testing)
├── bench/                # latency/throughput benchmarks + their own tsconfig (not shipped)
├── .github/workflows/    # publish.yml (npm publish on GitHub Release), publish-manual.yml
├── build.ts              # Bun build script (dual format, 4 entrypoints)
├── package.json          # ESM/CJS dual exports + /v2 subpaths
├── tsconfig.json         # Strict TypeScript config
├── README.md             # user-facing docs
├── RELEASE_NOTES.md      # per-release changelog, newest first
└── AGENTS.md             # this file
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
6. NEVER put a `tui: true` boolean on the server plugin definition. Commit `53ad497` did that to
   declare the TUI entrypoint and it broke the plugin outright. The v1-style loader validates a
   module's default export with `readV1Plugin` (`packages/opencode/src/plugin/shared.ts`), which
   treats any `tui` key as a legacy handler and, on a non-function, throws
   `Plugin <spec> has invalid tui export` — aborting the whole load with only an ERROR line in
   `~/.local/share/opencode/log/opencode.log` (`message="failed to load plugin"`) and no meter.
   For registry (npm) packages, TUI discovery is driven by `exports["./tui"]` in `package.json`;
   the boolean is never read. (For local `file://` directories, see 7 below — the loader ignores
   `exports` entirely and resolves by file path.)
   Same reason `./server` must resolve to the dual-host `dist/index.mjs` (`{ id, server, setup }`)
   and NOT the v2-only `dist/v2/server.mjs` (`{ id, setup }`): the loader calls `readV1Plugin(...,
   "server")`, which requires a `server()` function on whatever `./server` points at. The `/v2`
   exports are for programmatic `import` only. Locked in by the "resolves ./server and ./tui to
   modules valid on both plugin loaders" test in `src/__tests__/v2.test.ts`.
7. **Register local builds at `<repo>/dist`, not the repo root.** The installed v2 resolves a
   LOCAL plugin directory by file path — it tries `<dir>/server` then `<dir>/index` for the server
   and `<dir>/tui` for the TUI (adding `.ts/.tsx/.js/.jsx/.mts/.mjs/.cts/.cjs`). It only consults
   `package.json#exports` when the target is an npm package (`target.name` set), so the repo root
   (which has no root `index.*`, only `exports`) is **silently skipped** — no error, no meter.
   `dist/` is the correct target because it contains `index.mjs` (server) and `tui.mjs` (TUI).
   Verified: `opencode.json` `plugin` → `file:///<repo>/opencode-tps-meter/dist` yields
   `"features":{"server":true,"tui":true},"state":{"status":"active"}` from `/api/plugin`.
   `cli.json` `plugins` and `tui.json` `plugin` should use the same `dist` path. (An older README
   told users to point at `dist/tui.mjs` instead; that guidance was wrong and has been removed.)

**Dual-host rule:** v1 files must keep working unchanged against `opencode`. v2 lives under `src/v2/`
and shares only runtime-agnostic modules (tracker, tokenCounter, config, constants, format).
Never import `src/ui.ts` or `src/types.ts` event types from v2 code — those are v1-shaped.
(Deliberate exception: `src/v2/family.ts` is host-neutral by design — it takes a structural
`FamilyReading` — and the v1 TUI imports it, along with `setupTui` from `src/v2/tui.tsx` for the
dual-host `setup` key.)

---

## WHERE TO LOOK

Line numbers drift; if one is off, grep for the symbol.

| Task | Location | Notes |
|------|----------|-------|
| v1 plugin initialization | `src/index.ts:151` | `TpsMeterPlugin`, the `.server` member of the default export |
| v1 event handling | `src/index.ts:949` | message.part.updated/delta, message.updated, session.idle |
| v1 dual-host default export | `src/index.ts:998` | `{ id, server, setup }`; `setup` = `setupAuto` from `v2/dispatch.ts` |
| v1 TUI meter | `src/tui.tsx:130` (`MeterView`), `:220` (`tui`) | `session_prompt_right` slot, `api.event.on`, family resolution |
| v2 tracking core | `src/v2/meter.ts:284` | `createMeter`; drives both v2 entries; v2 event vocabulary |
| v2 TUI meter | `src/v2/tui.tsx:225` (`MeterView`), `:605` (`setupTui`) | footer slot placed `after: "prompt.footer.status"`, `ctx.data.on` |
| v2 theme handling | `src/v2/tui.tsx:110` | `normalizeTheme`: current token names first, older names as fallback, read lazily |
| v2 sidebar / dashboard / commands | `src/v2/tui.tsx:370` / `:447` / `:517` | `SidebarPanel`, `DashboardPage`, `CommandLayer` (`/tps`) |
| v2 server entry | `src/v2/server.ts:74` | `ctx.event.subscribe()` async iterable; no UI surface |
| v2 context dispatch | `src/v2/dispatch.ts:48` | `setupAuto`: TUI context → lazy import, server context → `setupServer` |
| v2 calibration / TTFT / tool time | `src/v2/metrics.ts:93` | `createMetrics` |
| v2 durable ledger | `src/v2/ledger.ts:99` | `createLedger`, store key `ledger.v2` |
| v2 API types | `src/v2/types.ts` | Hand-written structural types for the beta v2 API |
| Multi-session footer logic | `src/v2/family.ts` | Pure; used by BOTH hosts' footers |
| TPS calculation | `src/tracker.ts:49` | Chunks rated over their generation interval (shared v1/v2) |
| Meter text formatting | `src/format.ts:95` | Shared so v1 and v2 render identically |
| UI display (v1 only) | `src/ui.ts:31` | Throttled toast updates; no v2 equivalent |
| Token counting | `src/tokenCounter.ts:129` (batch), `:242` (incremental) | Heuristic: chars/4, words/0.75, or chars/3 |
| Configuration | `src/config.ts:328` | Priority: project → global → env → v2 options |
| Type definitions | `src/types.ts` | v1 interfaces; v2 types live in `src/v2/types.ts` |
| Build output | `dist/` | ESM (.mjs) + CJS (.js) + types (.d.ts) + `dist/v2/` |

---

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `TpsMeterPlugin` | Function | `index.ts:151` | v1 handler factory, exported as the module's `.server` |
| `createMeter` | Factory | `v2/meter.ts:284` | v2 session tracking core |
| `createMetrics` | Factory | `v2/metrics.ts:93` | Per-model calibration, TTFT, tool time |
| `createLedger` | Factory | `v2/ledger.ts:99` | Durable per-model rollup + saved calibration |
| `setupAuto` | Function | `v2/dispatch.ts:48` | Routes v2 `setup()` to the TUI or server half by context shape |
| `collectMeterEntries` | Function | `v2/family.ts:123` | Selects/orders family sessions for the footer Σ line |
| `formatAggregateLine` | Function | `v2/family.ts:234` | Renders `TPS Σ… \| main … \| agent … \| +N` |
| `aggregateReading` | Function | `v2/family.ts:204` | Colour source for the aggregate line (mean per-stream rate) |
| `isGenerating` | Function | `v2/family.ts:82` | `active` + token within the rolling window; decides Σ membership |
| `agentNameFromMessage` | Function | `agentName.ts:28` | v1 payload agent name; shared by server plugin and TUI |
| `setupTui` | Function | `v2/tui.tsx:605` | v2 TUI setup; returns cleanup |
| `setupServer` | Function | `v2/server.ts:74` | v2 server setup; returns cleanup |
| `createTracker` | Factory | `tracker.ts:49` | Interval-based rate tracker (shared) |
| `correctedAverage` | Function | `tracker.ts:35` | Settled average scaled by provider/streamed inside a ratio band |
| `createUIManager` | Factory | `ui.ts:31` | v1 toast display manager with throttling |
| `createTokenizer` | Factory | `tokenCounter.ts:129` | Heuristic token counter (shared) |
| `createIncrementalCounter` | Factory | `tokenCounter.ts:242` | Per-stream counter that never re-reads text |
| `formatMeterText` | Function | `format.ts:95` | Shared meter line rendering |
| `loadConfigSync` | Function | `config.ts:328` | Config loader (sync), optional overrides |
| `Config` | Interface | `types.ts:13` | Plugin configuration shape |
| `TPSTracker` | Interface | `types.ts:386` | Tracker public API |
| `MessageEvent` | Interface | `types.ts:245` | v1 OpenCode event structure |
| `V2MeterEvent` | Type | `v2/types.ts:106` | v2 event union the meter consumes (`V2AnyMeterEvent`, `:397`, adds the extended events) |

---

## CONVENTIONS

- **ESM-first**: Source uses `.js` extensions for imports
- **Dual exports**: `dist/index.mjs` (ESM) + `dist/index.js` (CJS)
- **Strict TypeScript**: `strict: true`, `forceConsistentCasingInFileNames`
- **Bun-native**: Uses `bun:test`, `Bun.build()`, `Bun.spawn()`
- **No console logging**: All logging through OpenCode's logger interface (`build.ts` is the only file that prints, and it is not shipped)
- **Sync config loading**: `loadConfigSync()` - no async config
- **Docs travel with behaviour**: see "Keeping docs in sync" below

---

## ANTI-PATTERNS (CRITICAL)

| Pattern | Why Forbidden | Location |
|---------|---------------|----------|
| **`console.*` calls** | TUI log leak during resize. SDK spawns TUI with `stdio: "inherit"` causing console output to bypass TUI redraw | `index.ts:154-164` (no-op logger fallback), `config.ts:190-200` |
| **Throwing config errors** | Silently ignore invalid configs to prevent TUI corruption | `config.ts:190-200` |
| **Direct module.exports** | CJS requires special handling for OpenCode compatibility | `build.ts:72-91` |

---

## UNIQUE STYLES

### Dual-Format Build (build.ts)
- ESM build: `format: "esm"`, outputs `.mjs`
- CJS build: `format: "cjs"`, outputs `.js`
- **CRITICAL FIX**: after bundling, `dist/index.js` is patched so `require()` returns the plugin
  object directly: the generated `module.exports = __toCommonJS(exports_src);` line is deleted and
  this is appended:
  ```typescript
  module.exports = exports_src.default;
  module.exports.default = exports_src.default;
  Object.defineProperty(module.exports, "__esModule", { value: true });
  ```
  `exports_src.default` is the dual-host OBJECT `{ id, server, setup }`, not a function — do not
  call it. (An older version of this file documented `exports_src.default()`; that would throw.)
- `dist/package.json` is written as `{ "type": "commonjs" }` so the `.js` artifacts load as CJS under
  the root package's `"type": "module"`.
- Declarations come from `tsc --emitDeclarationOnly` (`dist/**/*.d.ts`, including `dist/v2/`).

### Token Counting Heuristics
- `chars_div_4`: Default, ~75% accuracy for English
- `chars_div_3`: Code-optimized
- `words_div_0_75`: Prose-optimized

Streaming uses `createIncrementalCounter` (each chunk scanned once; counts equal the batch counter,
words split across chunk boundaries stay one word). Re-counting accumulated text per delta is
O(n²) — do not reintroduce it. v1 still keeps accumulated text under the part-type keys because
the full-`message.part.updated` path diffs against it; only the `:live` key is incremental.

### Event Flow (v1)
Server plugin (`src/index.ts`, toast fallback) handles four events:
1. `message.part.delta` / `message.part.updated` → role-filter (assistant only) → count delta tokens →
   update tracker → throttled toast update
2. `message.updated` → record role + agent name; on completion with a valid finish reason, show
   final stats (toast)
3. `session.idle` → drop that session's trackers and caches; clean up the UI when none remain

TUI meter (`src/tui.tsx`) handles the same four plus `session.created`/`session.updated`
(parent links for the family footer):
1. `message.part.*` → count tokens → tracker → throttled snapshot publish
2. `message.updated` (completed) → fold cache usage into the session rollup, then settle and freeze
   the reading (including a `tool-calls` step); `unknown` finish discards it
3. `session.idle` → freeze the last reading as inactive (if a rate was measurable) and free the session

### Event Flow (v2)
v2 deleted the whole `message.*` family. Mapping:

| v1 | v2 |
|----|----|
| `message.part.delta` (field `text`) | `session.text.delta` |
| `message.part.updated` (reasoning) | `session.reasoning.delta` |
| `message.updated` (completed) | `session.step.ended` (same finish reasons) |
| `message.updated` (`info.tokens`) | `session.usage.updated` |
| `session.idle` | `session.idle` (unchanged) |

The v2 meter handles 16 event types in total (`HANDLED_EVENT_TYPES` in `v2/meter.ts`, mirrored by
`SUBSCRIBED_EVENTS` in `v2/tui.tsx`). Beyond the five above: `session.step.started` (model, agent,
`started`), `session.step.failed`, `session.tool.input.delta`/`.ended`, `session.tool.called`/
`.success`/`.failed`, and `session.execution.started`/`.succeeded`/`.failed`/`.interrupted`.
A `session.step.failed` freezes the reading where it was and still folds in any usage reported.

Also changed: event envelope `properties` → `data`; slot `session_prompt_right` →
`prompt.footer.status`; slot prop `session_id` (required) → `sessionID` (optional);
theme `current.textMuted` → `text.muted` (early v2 builds: `text.subdued`) and `current.error` →
`text.feedback.error.base` (early builds: `.default`) — `normalizeTheme` resolves the current names
first, falls back to the older ones, and reads the host theme lazily so a theme switch recolors the
meter; `api.event.on` → `ctx.data.on` (TUI) or `ctx.event.subscribe()` async-iterable (server);
`api.lifecycle.onDispose` → return a cleanup fn from `setup`.

No role filtering is needed on v2 — text/reasoning deltas are assistant output by construction.

### v2 TUI surfaces (`src/v2/tui.tsx`)
- **Footer meter** — `ctx.ui.slot({ after: "prompt.footer.status" })`. It MUST be `after`, not
  `append`: appending places the meter inside the host's greedy `flexGrow:1` status box, where it
  collapses to zero width whenever a turn is running. As a sibling it survives, and `MeterView`'s
  `flexShrink={0}` holds its width. This is the one surface that must exist; it is claimed outside
  the `optional()` guard.
- **Sidebar panel** — `append: "sidebar.content"`, only when `ctx.data.session` exists and the
  family has more than one member.
- **Dashboard** — `ctx.ui.router.register({ name: "tps" })`; live sessions plus the per-model ledger.
- **Commands** — `tps.toggle` via `ctx.keymap.layer`, mounted from a null-rendering component in
  the `app` slot (a layer needs a reactive owner). `/tps` → dashboard; `detail`/`details` → toast;
  `reset` → clear the ledger (calibration is kept); `compact`/`detailed`/`hidden` → set the footer
  mode; anything else cycles modes.
- Every optional surface registers through `optional()`: beta API drift costs a surface, never the meter.

**Clock discipline.** The TUI flushes events in ~10ms batches, so `Date.now()` inside a handler
is FLUSH time and every event in a batch shares it. Use each event's host-stamped `created`
(`eventTime()` in meter.ts). `src/tracker.ts` does all its maths on the timestamps it is given
(host time on v2, local time on v1), so one tracker never mixes clocks; on v1, a fallback that
needs server time uses `info.time.created` → `completed`, both server stamps.
The one deliberate exception is snapshot `lastActivityAt`: consumers age it against their OWN
`Date.now()`, so it is stamped on the local wall clock (`lastTokenWallAt`) on both hosts — never
from event `created` or v1's `info.time.completed`, which a remote service can skew by seconds.
Throttling is likewise decided on the wall clock (the clock timers fire on), not on host time.

**Rate measurement (do not regress — each rule fixed a live spike).**
1. The host batches output: v2 flushes text/reasoning every ~100ms (live: chunks ~200-300ms
   apart), and tool-call arguments arrive whole in `session.tool.input.ended`. A chunk's tokens
   were generated over the interval since the previous chunk, and `tracker.recordTokens` rates
   them over exactly that. NEVER rate tool input from `session.tool.input.started`: with
   providers that deliver a call whole, started and ended land ~100ms apart (live: 850 tokens
   read as 8,763 TPS).
2. The opening chunk of a stream is total-only, never rated: it was generated over an interval the
   meter never saw. Dividing it by the ~10ms before the first publish produced 15,900 TPS.
3. Nothing publishes until `tracker.isRateReady()` (>= `MIN_RATE_SPAN_MS` of generation).
4. Never divide provider token counts by the streamed window. The settled average is the streamed
   average, scaled by provider/streamed only inside `[MIN_PROVIDER_RATIO, MAX_PROVIDER_RATIO]`
   (`correctedAverage`). Provider reasoning counts only if reasoning deltas actually streamed
   (`sawReasoning`); hidden reasoning otherwise inflates the rate. If reasoning streamed but the
   provider reports `reasoning: 0`, the count is ambiguous (folded into output, or omitted):
   skip both correction and calibration for that step (live: rates scaled down 40%).
5. A step too short to time falls back to tokens over the whole step, from `step.started`'s
   `started` field (the event itself is published late, with the first output). On v1 the
   fallback is `info.time.created` → `completed`.
6. Calibration is a size-weighted ratio of sums (`CALIBRATION_MEMORY_TOKENS`), persisted per
   model in the ledger: tiny tool steps read ~2x (provider counts call framing) and must not
   swing it. Samples outside `[0.25, 4]` are rejected.
7. Tool execution runs between steps, never inside a step's window, so it is never subtracted
   from a rate (`generationTps` equals the step average; `toolMs` is reported on its own).
8. The ledger (`ledger.v2` store key) gets `generationMs` implied by the displayed rate, so its
   per-model means agree with the footer. `ledger` (v1 key) held spike-polluted figures.
9. A live stream that goes quiet for `STALL_REPUBLISH_MS` (250ms) is republished with the rate as
   of now, repeating until the rate reaches zero or output resumes — otherwise a stalled stream
   keeps showing its last speed. Both hosts; the timer is cleared on every chunk, step end and idle.

**Cumulative vs per-step.** `session.step.ended.tokens` is a PER-STEP DELTA;
`session.usage.updated.tokens` is a CUMULATIVE SESSION TOTAL that also includes auto-title and
compaction. Never substitute one for the other. Their residual is the hidden-overhead metric,
and it is tracked at SESSION scope (`sessionUsage`) because per-turn state is destroyed on every
step end and idle.

**Prompt cache hit rate.** OpenCode's `tokens.input` EXCLUDES cache reads and writes, so the prompt
side is `input + cache.read + cache.write` and the rate is `cache.read` over that (`cacheHitRatio`
in `format.ts`). The meter shows the last step (`cache N%`) and a session rollup (`session cache N%`).
Cache accounting is folded in for EVERY reported step, including tool-call-only steps that streamed
nothing and (v2) failed steps. v1 accounts each completed message once and adds only the increment
on re-updates (`accountMessageCache`), since a completed message can be updated again when structured
output is attached. A swept/pruned session re-seeds its session totals from its retained reading so
they carry on instead of restarting at zero. Nothing is shown until a step has reported usage.

**Multi-session footer.** The footer aggregates the selected session's whole family; selection,
labeling and formatting live in the pure module `src/v2/family.ts` (unit-tested without a
renderer, shared by BOTH hosts via the structural `FamilyReading` type). Root always renders as
`main` when it has a reading — its frozen reading persists exactly as the single-agent meter
always behaved; a root with no reading yet (first step was a pure tool call) simply has no
column, and its streaming children still render.

*Generating* is decided by `isGenerating()`: `active` AND a token within the rolling window
(`config.rollingWindowMs`). Never trust `active` alone — v1 keeps a session active straight
through its own tool calls and the root's wait on its children, a crashed/cancelled session
never leaves it, and `instantTps` is frozen at the last publish. `Σ` sums `instantTps` of every
generating entry, root included: a waiting root drops out on its own, and a root summarising
its children's results counts. Non-generating columns show their frozen average.

Children appear while generating, within `SUBAGENT_LINGER_MS` (4s) of `lastActivityAt`, or
while the host reports them running (v2 `data.session.status(id) === "running"`, v1
`api.state.session.status(id)` busy/retry) — so a subagent inside a long tool call keeps its
column on both hosts. Order: root first, then SPAWN order (`snapshot.startedAt` = first token of
the current RUN; recency ordering was tried and rejected because columns swap as activity
trades, which reads as flicker). The spawn stamp survives tool-call breaks and is cleared on
`session.idle` (and by v2's stale sweep), so a re-dispatched session rejoins at the end.
Same-millisecond spawns tie-break on session id. Capped at `MAX_METER_ENTRIES` (4) with `+N`
overflow. Labels: the agent name, or the last 6 characters of the session id when unnamed;
same-named columns get a stable suffix from the last 4 characters of the session id, e.g.
`explore(9B5c)` (a position number would shift as entries drop off). The line is coloured by
`aggregateReading()` — live while anything generates, at the MEAN per-stream rate, because the
slow/fast thresholds are per-stream figures. Line format:
`TPS Σ 318 | main 63 | explore 91 | …` (note the space after Σ).

Reactivity: family resolution is memoised on the set of sessions that have a reading
(`sameIDs`) — never inside the snapshot-dependent memo, which re-runs up to ~125/s. Nothing
publishes once every stream goes quiet, so a 500ms heartbeat (`AGGREGATE_TICK_INTERVAL_MS`)
re-runs the recency filter; it is owned by the footer component (`createEffect`/`onCleanup`)
and runs only while the aggregate line is on screen. Every host-API access is wrapped, and a
family is committed only once fully resolved — drift degrades to the single-session meter,
never to a broken plugin or a half-resolved line.

Attribution per host:
- **v2**: `ctx.data.session.root/family/get(id)?.agent` — exact, synced.
- **v1**: no family API in events, but the real tree IS available: `session.created`/
  `session.updated` carry `info.parentID`, and `api.state.session.get()` serves the same
  `Session` shape synchronously (`src/tui.tsx: parentOf/walkToRoot/resolveFamily`; one
  resolution memoises roots so shared ancestors are walked once). Agent names ride on message
  payloads only; `src/agentName.ts` extracts them for BOTH the v1 server plugin and the v1 TUI
  so one session never gets two labels — precedence `agent` string, AgentIdentity
  `type`/`name`/`id`, legacy `agentType`, assistant `mode`; parts never carry them. Parent links,
  agent names and spawn stamps are bounded LRUs (`MAX_REMEMBERED_SESSIONS`), since
  `session.updated` fires for every session in the project. Unrelated sessions are excluded
  because their root chain lands elsewhere; with no links at all the meter stays single-session.

**Validate at the v2 event boundary.** Event payloads cross a process boundary from the host,
so `asMeterEvent` rejects anything without a non-empty string `sessionID`, and `toTokenCount`
coerces provider token fields before arithmetic — a non-numeric `tokens.output` would otherwise
turn `output + reasoning` into string concatenation (`"100" + "50"` → `"10050"`) and render a
bogus total. `sweepStaleSessions` handles sessions that go quiet without a terminal event (crash,
cancel, dropped connection produce neither `session.step.ended` nor `session.idle`), reusing the
v1 `MAX_MESSAGE_AGE_MS` (5 min) / `CLEANUP_INTERVAL_MS` (30s) thresholds. It frees the HEAVY state
(tracker, stream counters, metrics, usage, spawn stamp) but deliberately keeps the last READING
on screen — v1 never forgot its final numbers, and erasing them read as the meter forgetting. Retained
readings are capped at `MAX_RETAINED_SNAPSHOTS` (64), oldest evicted first.

---

## COMMANDS

```bash
# Development
bun install                    # Install dependencies
bun test                       # Run all suites (unit + integration + E2E + build invariants)
bun run typecheck              # tsc --noEmit
bun run build                  # Build dual-format output

# Benchmarks (not shipped; own tsconfig)
bun run bench                  # hotpath, publish, profile, memory, v1path
bun bench/latency.ts           # time-to-accurate-reading; NOT part of `bench`
bun run typecheck:bench        # type-check bench/

# Build output
# - dist/index.mjs (ESM)            - dist/tui.mjs (v1/v2 TUI)
# - dist/index.js (CJS - OpenCode compatible)
# - dist/v2/server.mjs, dist/v2/tui.mjs
# - dist/**/*.d.ts (TypeScript declarations), dist/package.json ({"type":"commonjs"})
```

---

## NOTES

### Config Loading Priority
1. `.opencode/tps-meter.json` (project-level)
2. `~/.config/opencode/tps-meter.json` (global)
3. Environment variables (`TPS_METER_*`)
4. Inline overrides — v2 plugin `options` from `opencode.json`, passed as `loadConfigSync(overrides)`

Later sources win, so global overrides project. `mergeConfig` then validates every field: numbers
are clamped (`updateIntervalMs` 10–5000, `initialDisplayDelayMs` 0–1000, `rollingWindowMs`
100–30000, `minVisibleTPS`/thresholds 0–10000; negative/non-numeric fall back to the default),
enums fall back on unknown values, and a `slowTpsThreshold` not strictly below `fastTpsThreshold`
resets BOTH to their defaults. Nothing throws.

Note v2 dropped `tui.json`/`tui.jsonc` entirely (replaced by one global `cli.json`) and renamed
the plugin config key from `plugin` to `plugins`. The plugin's own `tps-meter.json` files are
unaffected.

### Environment Variables
All parsed in `loadEnvConfig()`. Booleans are `=== "true"` only; invalid numbers/enums are ignored.
- `TPS_METER_ENABLED` (boolean)
- `TPS_METER_TOAST_FALLBACK` (boolean, v1 only, default: false)
- `TPS_METER_UPDATE_INTERVAL_MS` (number, default: 50; v2 resolves the default 50 to 8 — `V2_UPDATE_INTERVAL_MS`)
- `TPS_METER_INITIAL_DISPLAY_DELAY_MS` (number, default: 10)
- `TPS_METER_ROLLING_WINDOW_MS` (number, default: 1000)
- `TPS_METER_FORMAT` (compact|verbose|minimal — see Known quirks)
- `TPS_METER_MIN_VISIBLE_TPS` (number, default: 0)
- `TPS_METER_SHOW_AVERAGE` / `_SHOW_INSTANT` / `_SHOW_TOTAL_TOKENS` / `_SHOW_ELAPSED` / `_SHOW_CACHE_HIT`
  (booleans; defaults true / true / true / false / true)
- `TPS_METER_FALLBACK_HEURISTIC` (chars_div_4|chars_div_3|words_div_0_75)
- `TPS_METER_ENABLE_COLOR_CODING` (boolean, default: false)
- `TPS_METER_SLOW_TPS_THRESHOLD` (number, default: 10) / `TPS_METER_FAST_TPS_THRESHOLD` (number, default: 50)

### Known quirks (documented, not bugs in the docs)
- **`format` (`compact|verbose|minimal`) has no effect.** It is validated and stored, but neither
  `formatMeterText` (v1 TUI + v2) nor `ui.ts` (v1 toast) reads it. The README says so; if rendering
  is ever implemented, update README "Display Formats" and the config table at the same time.
- **The v1 final-stats toast reads `TPS: 0.0 (avg …)`** — `showFinalStats` passes `instantTps: 0`
  through the same line formatter as live updates. The average and totals are the content.
- **v2 `updateIntervalMs: 50` is treated as unset** (it equals `DEFAULT_UPDATE_INTERVAL_MS`, the
  sentinel `createMeter` compares against), so an explicit 50 still resolves to 8ms on v2.
- **`package.json` `files` lists `LICENSE`, but no `LICENSE` file exists in the repository**
  (a test in `v2.test.ts` pins the `files` array, so change both together).
- **Wire-level TTFB cannot reach the on-screen meter**: server and TUI are separate processes.
  `getWireTimings()` exists for embedders only.

### Testing
- Uses `bun:test` (not Jest/Vitest); `src/bun-test.d.ts` supplies ambient typings
- Mock OpenCode context required for testing
- `e2e.test.ts` — module exports, plugin loading, config loading and validation edge cases
- `integration.test.ts` — v1 server plugin: full event flow, UI throttling, colour coding, cleanup,
  part-text extraction, smoothing
- `multi-agent.test.ts` — v1 toast: per-agent rows, primary-line rules, display modes
- `tui.test.ts` — v1 TUI plugin: slot rendering, no double counting of deltas, cache accounting
  (repeated completed messages, tool-call-only steps, stale-accounting prunes)
- `v1-family.test.ts` — v1 multi-session footer (parent resolution, labels) and `agentNameFromMessage`
- `v2-family.test.ts` — `family.ts` units, footer integration with the live meter, v2 footer slot rendered
  through a test renderer
- `v2.test.ts` — v2 meter, plugin entries, theme normalization, metrics, ledger, optional surfaces,
  wire timings, incremental counting, tracker rates, publish latency, resilience, accurate rates,
  stalls/calibration, and **build invariants** (the dual-host export shapes; builds the bundle on demand)

### Dependencies
- No runtime `dependencies`. `package.json` carries only devDependencies (`@opencode-ai/plugin`
  `^1.15.13`, `@opentui/core`, `@opentui/solid` `^0.3.0`, `solid-js` 1.9.12, `typescript`,
  `@types/node`) and optional peers.
- `@opencode-ai/plugin`: optional peer (`>=1.15.13`), external in the build
- `@opentui/solid` / `solid-js`: **optional peer** dependencies, not bundled. The TUI host supplies
  the renderer and reactive runtime; a nested copy would give the plugin its own reactive graph and
  the meter would render once and then freeze. The v2 host pins `@opentui/*` to dated snapshots
  (observed `0.0.0-20260808-*` when v2 support was written), which is why the peer range is `*`
  rather than a semver range. This repo's own devDependencies use the released `^0.3.0` for
  typechecking and tests.
- v2 API types are hand-written in `src/v2/types.ts` rather than imported from
  `@opencode-ai/plugin@next`: v1 and v2 types ship under the same package name so both cannot be
  installed at once, and the v2 API is beta and still changing.
- Tokenization is heuristic only. `gpt-tokenizer` and `zod` are NOT dependencies (an older version
  of this file said they were "listed but unused"); `zod` appears only in `build.ts`'s external list.

### Release process
- Versions live in `package.json`; `RELEASE_NOTES.md` carries one section per release, newest first.
- `.github/workflows/publish.yml` runs tests + build on pushes to `main` and `v*` tags, but PUBLISHES
  only on a GitHub `release: published` event (one publish step, to avoid a duplicate-publish 403).
  A version containing `-` (a prerelease such as `0.4.0-beta.1`) is published under the `beta`
  dist-tag so a plain `npm install` never receives it; otherwise `latest`. Provenance is enabled.
- `publish-manual.yml` (`workflow_dispatch`) rewrites the version in `package.json` with `sed`, then
  tests, builds and publishes.

### Keeping docs in sync
When behaviour changes, update the docs in the same change. Quick checklist:
- New/changed config option → `src/config.ts` defaults + validation + env parsing, README env-var
  block, JSON example and options table, and the env list above.
- New/changed rendered text → README "Display Formats" (render it with a throwaway script rather
  than writing it from memory) and the sample at the top of the README.
- New v2 event, surface or `/tps` command → README "v2-only capabilities"/"Event Handling" and the
  "v2 TUI surfaces" section above.
- New measurement rule → "Rate measurement" above (append, keep numbering sequential) and README
  "How the Rate Is Measured".
- Moved code → refresh the line numbers in WHERE TO LOOK, CODE MAP and ANTI-PATTERNS.
- Release → new `RELEASE_NOTES.md` section; do not rewrite older sections except to mark a claim as
  superseded.
