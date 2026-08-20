/**
 * Durable throughput ledger, keyed by model.
 *
 * v1 could not do this at all: its TUI KV is documented as
 * `@deprecated Persistent TUI KV storage is not supported in V2`, so a v1 TUI plugin loses
 * every reading when the TUI exits. v2's `ctx.storage.store` persists to disk under a
 * cross-process lock and live-syncs to every running TUI window, so a rollup written by one
 * window is immediately visible in another.
 *
 * Degrades to an in-memory rollup when the host exposes no storage, so the dashboard still
 * works on a host that predates the API.
 *
 * @module v2/ledger
 */

import type { V2StoreHandle, V2Storage } from "./types.js";

export interface LedgerEntry {
  /** Settled steps folded into this entry. */
  samples: number;
  /** Provider-reported tokens, summed. */
  tokens: number;
  /** Generation milliseconds (tool execution already subtracted), summed. */
  generationMs: number;
  /** Provider-reported cost, summed. */
  cost: number;
  /** Best single-step tokens/sec seen. */
  bestTps: number;
  /** Most recent step's tokens/sec. */
  lastTps: number;
  /** Mean time-to-first-token across samples with a measurement. */
  meanTtftMs: number;
  ttftSamples: number;
}

export interface LedgerData {
  version: number;
  models: Record<string, LedgerEntry>;
}

export interface StepMeasurement {
  modelKey: string;
  tokens: number;
  generationMs: number;
  cost: number;
  ttftMs: number;
}

export interface V2Ledger {
  /** Folds one settled step into the rollup. Interrupted turns must not be passed here. */
  record(measurement: StepMeasurement): void;
  read(): LedgerData;
  /** Mean tokens/sec for a model, or 0 when unmeasured. */
  meanTps(modelKey: string): number;
  clear(): void;
}

const EMPTY: LedgerData = { version: 1, models: {} };

function emptyEntry(): LedgerEntry {
  return {
    samples: 0,
    tokens: 0,
    generationMs: 0,
    cost: 0,
    bestTps: 0,
    lastTps: 0,
    meanTtftMs: 0,
    ttftSamples: 0,
  };
}

export function createLedger(storage?: V2Storage): V2Ledger {
  let fallback: LedgerData = { version: 1, models: {} };

  // The host's storage API is beta and hand-typed here. If calling it throws — wrong
  // signature, or a Solid store that must be created inside a reactive owner — fall back to
  // the in-memory rollup rather than taking the whole plugin down with us.
  let handle: V2StoreHandle<LedgerData> | undefined;
  try {
    handle = storage?.store<LedgerData>("ledger", { initial: { ...EMPTY, models: {} } });
    if (handle && (!Array.isArray(handle) || typeof handle[1] !== "function")) {
      handle = undefined;
    }
  } catch {
    handle = undefined;
  }

  function read(): LedgerData {
    if (!handle) {
      return fallback;
    }
    try {
      return handle[0] ?? fallback;
    } catch {
      return fallback;
    }
  }

  function mutate(fn: (draft: LedgerData) => void): void {
    if (handle) {
      try {
        void handle[1](fn);
        return;
      } catch {
        // Drop through to the in-memory path for the rest of this session.
        handle = undefined;
      }
    }
    // Structured clone keeps the in-memory path copy-on-write like the store path.
    const draft: LedgerData = JSON.parse(JSON.stringify(fallback)) as LedgerData;
    fn(draft);
    fallback = draft;
  }

  return {
    record(measurement) {
      const { modelKey, tokens, generationMs, cost, ttftMs } = measurement;
      if (!modelKey || tokens <= 0 || generationMs <= 0) {
        return;
      }
      const tps = tokens / (generationMs / 1000);
      if (!Number.isFinite(tps) || tps <= 0) {
        return;
      }

      mutate((draft) => {
        if (!draft.models) {
          draft.models = {};
        }
        const entry = draft.models[modelKey] ?? emptyEntry();
        entry.samples += 1;
        entry.tokens += tokens;
        entry.generationMs += generationMs;
        entry.cost += cost > 0 ? cost : 0;
        entry.lastTps = tps;
        entry.bestTps = Math.max(entry.bestTps, tps);
        if (ttftMs > 0) {
          entry.meanTtftMs =
            (entry.meanTtftMs * entry.ttftSamples + ttftMs) / (entry.ttftSamples + 1);
          entry.ttftSamples += 1;
        }
        draft.models[modelKey] = entry;
      });
    },

    read,

    meanTps(modelKey) {
      const entry = read().models?.[modelKey];
      if (!entry || entry.generationMs <= 0) {
        return 0;
      }
      return entry.tokens / (entry.generationMs / 1000);
    },

    clear() {
      mutate((draft) => {
        draft.models = {};
      });
    },
  };
}
