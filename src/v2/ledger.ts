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
  /** Milliseconds spent generating those tokens, summed. Tool execution is never inside. */
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

/** A model's learned heuristic-to-provider token ratio. See v2/metrics.ts. */
export interface CalibrationEntry {
  factor: number;
  samples: number;
  /** Heuristic tokens behind the factor. */
  weight?: number;
}

export interface LedgerData {
  version: number;
  models: Record<string, LedgerEntry>;
  /**
   * Per-model token calibration. Persisted so a new session's live rate is corrected from
   * its first token, instead of running uncalibrated until its first step settles.
   */
  calibration?: Record<string, CalibrationEntry>;
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
  /** Saved per-model calibration, to seed the meter at startup. */
  calibrations(): Record<string, CalibrationEntry>;
  recordCalibration(modelKey: string, entry: CalibrationEntry): void;
  /**
   * Clears the throughput rollup. Calibration is kept: it describes the model's tokenizer,
   * not its speed, and keeps refining itself step by step anyway.
   */
  clear(): void;
}

/**
 * Version 2 changed how a step's rate is measured. Version 1 rollups were fed by a formula
 * that divided a host-batched chunk by a few milliseconds, so their best/mean figures are
 * not comparable; they are left behind under the old key rather than mixed in.
 */
const LEDGER_KEY = "ledger.v2";
const EMPTY: LedgerData = { version: 2, models: {} };

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
  let fallback: LedgerData = { ...EMPTY, models: {} };

  // The host's storage API is beta and hand-typed here. If calling it throws — wrong
  // signature, or a Solid store that must be created inside a reactive owner — fall back to
  // the in-memory rollup rather than taking the whole plugin down with us.
  let handle: V2StoreHandle<LedgerData> | undefined;
  try {
    handle = storage?.store<LedgerData>(LEDGER_KEY, { initial: { ...EMPTY, models: {} } });
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

    calibrations() {
      const saved = read().calibration;
      return saved ? { ...saved } : {};
    },

    recordCalibration(modelKey, entry) {
      if (!modelKey || !Number.isFinite(entry.factor) || entry.factor <= 0) {
        return;
      }
      mutate((draft) => {
        draft.calibration = { ...(draft.calibration ?? {}), [modelKey]: { ...entry } };
      });
    },

    clear() {
      mutate((draft) => {
        draft.models = {};
      });
    },
  };
}
