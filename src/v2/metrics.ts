/**
 * Tier-2 metrics for OpenCode v2: tokenizer calibration and turn decomposition.
 *
 * All of this is impossible on v1, for two structural reasons:
 *
 * - v1 events carry no timestamps at all, so tool execution could not be separated from
 *   model generation and time-to-first-token could not be measured.
 * - v1's StepStartPart carries neither the model nor the agent, so throughput could not be
 *   attributed. v2's session.step.started carries both.
 *
 * @module v2/metrics
 */

import type { V2ModelRef } from "./types.js";

/** Calibration is only trusted inside this band; outside it the sample is noise. */
const MIN_FACTOR = 0.25;
const MAX_FACTOR = 4;
/** EWMA weight for a new calibration sample. */
const CALIBRATION_ALPHA = 0.3;
/** A step must stream at least this many heuristic tokens before it can calibrate. */
const MIN_CALIBRATION_TOKENS = 8;

export interface TurnMetrics {
  /** Milliseconds from turn start to the first streamed token. 0 when unknown. */
  ttftMs: number;
  /** Milliseconds spent inside tool execution during this turn. */
  toolMs: number;
  /** True when the turn was aborted; its numbers should not be trusted. */
  interrupted: boolean;
}

export interface ModelAttribution {
  /** `providerID/modelID[#variant]`, or "default" before any step.started is seen. */
  key: string;
  model?: V2ModelRef;
  agent?: string;
}

interface Calibration {
  factor: number;
  samples: number;
}

interface SessionMetrics {
  turnStartedAt: number | null;
  firstTokenAt: number | null;
  toolMs: number;
  interrupted: boolean;
  /** Tool callID -> host timestamp when execution began. */
  runningTools: Map<string, number>;
  /** Heuristic tokens counted for the current step, for calibration. */
  stepHeuristicTokens: number;
  /** Fractional remainder so scaling never silently drops sub-token amounts. */
  carry: number;
  attribution: ModelAttribution;
}

export interface V2Metrics {
  onExecutionStarted(sessionID: string, at: number): void;
  onExecutionSettled(sessionID: string, interrupted: boolean): void;
  onStepStarted(sessionID: string, model: V2ModelRef | undefined, agent: string | undefined): void;
  onToolCalled(sessionID: string, callID: string, at: number): void;
  onToolSettled(sessionID: string, callID: string, at: number): void;
  onFirstToken(sessionID: string, at: number): void;
  /** Applies the learned factor to a raw heuristic count, carrying the remainder. */
  scale(sessionID: string, rawTokens: number): number;
  /** Folds one step's ground truth into the calibration for its model. */
  calibrate(sessionID: string, realTokens: number): void;
  turnOf(sessionID: string): TurnMetrics;
  attributionOf(sessionID: string): ModelAttribution;
  /** Samples recorded for this session's current model. */
  samplesOf(sessionID: string): number;
  resetTurn(sessionID: string): void;
  forget(sessionID: string): void;
  dispose(): void;
}

export function createMetrics(): V2Metrics {
  const sessions = new Map<string, SessionMetrics>();
  /** Learned per model, so it survives session churn and benefits every later session. */
  const calibration = new Map<string, Calibration>();

  function get(sessionID: string): SessionMetrics {
    let state = sessions.get(sessionID);
    if (!state) {
      state = {
        turnStartedAt: null,
        firstTokenAt: null,
        toolMs: 0,
        interrupted: false,
        runningTools: new Map(),
        stepHeuristicTokens: 0,
        carry: 0,
        attribution: { key: "default" },
      };
      sessions.set(sessionID, state);
    }
    return state;
  }

  function factorFor(key: string): number {
    return calibration.get(key)?.factor ?? 1;
  }

  function attributionFor(sessionID: string): ModelAttribution {
    return sessions.get(sessionID)?.attribution ?? { key: "default" };
  }

  return {
    onExecutionStarted(sessionID, at) {
      const state = get(sessionID);
      state.turnStartedAt = at;
      state.firstTokenAt = null;
      state.toolMs = 0;
      state.interrupted = false;
      state.runningTools.clear();
    },

    onExecutionSettled(sessionID, interrupted) {
      get(sessionID).interrupted = interrupted;
    },

    onStepStarted(sessionID, model, agent) {
      const state = get(sessionID);
      // A new step resets the calibration accumulator; each step is one closed sample.
      state.stepHeuristicTokens = 0;
      state.attribution = {
        key: model
          ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
          : state.attribution.key,
        model: model ?? state.attribution.model,
        agent: agent ?? state.attribution.agent,
      };
    },

    onToolCalled(sessionID, callID, at) {
      get(sessionID).runningTools.set(callID, at);
    },

    onToolSettled(sessionID, callID, at) {
      const state = get(sessionID);
      const startedAt = state.runningTools.get(callID);
      if (startedAt === undefined) {
        return;
      }
      state.runningTools.delete(callID);
      if (at > startedAt) {
        state.toolMs += at - startedAt;
      }
    },

    onFirstToken(sessionID, at) {
      const state = get(sessionID);
      if (state.firstTokenAt === null) {
        state.firstTokenAt = at;
      }
    },

    scale(sessionID, rawTokens) {
      if (rawTokens <= 0) {
        return 0;
      }
      const state = get(sessionID);
      state.stepHeuristicTokens += rawTokens;

      const factor = factorFor(state.attribution.key);
      if (factor === 1) {
        return rawTokens;
      }
      const scaled = rawTokens * factor + state.carry;
      const whole = Math.floor(scaled);
      state.carry = scaled - whole;
      return whole;
    },

    calibrate(sessionID, realTokens) {
      const state = get(sessionID);
      const heuristic = state.stepHeuristicTokens;
      state.stepHeuristicTokens = 0;
      state.carry = 0;

      if (realTokens <= 0 || heuristic < MIN_CALIBRATION_TOKENS) {
        return;
      }
      const sample = realTokens / heuristic;
      if (!Number.isFinite(sample) || sample < MIN_FACTOR || sample > MAX_FACTOR) {
        return;
      }

      const key = state.attribution.key;
      const existing = calibration.get(key);
      if (!existing) {
        calibration.set(key, { factor: sample, samples: 1 });
        return;
      }
      calibration.set(key, {
        factor: existing.factor * (1 - CALIBRATION_ALPHA) + sample * CALIBRATION_ALPHA,
        samples: existing.samples + 1,
      });
    },

    turnOf(sessionID) {
      const state = sessions.get(sessionID);
      if (!state) {
        return { ttftMs: 0, toolMs: 0, interrupted: false };
      }
      const ttftMs =
        state.turnStartedAt !== null && state.firstTokenAt !== null
          ? Math.max(0, state.firstTokenAt - state.turnStartedAt)
          : 0;
      return { ttftMs, toolMs: state.toolMs, interrupted: state.interrupted };
    },

    attributionOf: attributionFor,

    // Deliberately closes over `attributionFor` rather than using `this`, so the method
    // keeps working if a caller destructures it off the object.
    samplesOf(sessionID) {
      return calibration.get(attributionFor(sessionID).key)?.samples ?? 0;
    },

    resetTurn(sessionID) {
      const state = sessions.get(sessionID);
      if (!state) {
        return;
      }
      state.stepHeuristicTokens = 0;
      state.carry = 0;
      state.runningTools.clear();
    },

    forget(sessionID) {
      sessions.delete(sessionID);
    },

    dispose() {
      sessions.clear();
      calibration.clear();
    },
  };
}
