/**
 * Multi-session aggregation for the footer meter.
 *
 * Pure logic with no JSX and no host dependencies, so it is unit-testable without a
 * renderer and shared by both hosts: the v2 TUI supplies `ctx.data.session`, the v1 TUI
 * supplies `api.state.session` — this module just selects, labels, orders and formats.
 *
 * @module v2/family
 */

import type { V2Snapshot } from "./meter.js";

/**
 * Minimal reading shape the aggregation needs.
 *
 * Structural on purpose: both hosts feed their own snapshot types in (v2's V2Snapshot,
 * v1's TuiSnapshot), so the footer renders identically on `opencode` and `opencode2`.
 */
export interface FamilyReading {
  readonly instantTps: number;
  readonly avgTps: number;
  readonly active: boolean;
  readonly lastActivityAt: number;
  /**
   * When this session first produced tokens (session-scoped, survives per-turn resets).
   * Children render in this order so concurrent streams never swap positions.
   */
  readonly startedAt: number;
}

/**
 * How long a finished subagent stays visible in the aggregate line before dropping off.
 *
 * Subagents finish between tool calls all the time; dropping them the instant they settle
 * makes the line flicker. ~4s keeps completed entries readable while honouring the 3-5s
 * disappearance window.
 */
export const SUBAGENT_LINGER_MS = 4000;

/** Maximum agent entries rendered before the remainder collapses into `+N`. */
export const MAX_METER_ENTRIES = 4;

/** One agent's contribution to the aggregate footer line. */
export interface AgentMeterEntry {
  readonly sessionID: string;
  /** "main" for the root session; otherwise the agent name or a short session id. */
  readonly label: string;
  readonly isRoot: boolean;
  /** Live rate while generating; the frozen average once finished. */
  readonly tps: number;
  /** Instantaneous rate regardless of activity — the component of Σ. */
  readonly instantTps: number;
  readonly active: boolean;
}

/** Short fallback identifier when no agent name is available. Same convention as the sidebar. */
export function shortSessionLabel(sessionID: string): string {
  return sessionID.slice(-6);
}

/**
 * Selects and orders the family sessions worth showing.
 *
 * The root always qualifies if it has a reading — its frozen summary persisting after the
 * turn ends IS the single-agent behaviour the meter has always had. Children qualify only
 * while generating or within SUBAGENT_LINGER_MS of their last token.
 *
 * Ordering: root first, then children in SPAWN order. Recency-based ordering was tried and
 * rejected: as subagents trade the "most recent token" crown their columns swap places,
 * which reads as flicker. Spawn order is stable for the whole fan-out; a session that
 * finishes and is re-dispatched counts as a new spawn (its per-turn state was reset, so it
 * stamps a fresh startedAt) and rejoins at the end.
 */
export function collectMeterEntries(options: {
  rootID: string;
  memberIDs: readonly string[];
  snapshots: ReadonlyMap<string, FamilyReading>;
  /** Resolves an agent display name, e.g. from `ctx.data.session.get(id)?.agent`. */
  agentOf?: (sessionID: string) => string | undefined;
  now: number;
}): AgentMeterEntry[] {
  const { rootID, memberIDs, snapshots, agentOf, now } = options;
  const entries: AgentMeterEntry[] = [];

  for (const sessionID of memberIDs) {
    const snapshot = snapshots.get(sessionID);
    if (!snapshot) {
      continue;
    }
    const isRoot = sessionID === rootID;
    if (!isRoot && !snapshot.active && now - snapshot.lastActivityAt > SUBAGENT_LINGER_MS) {
      continue;
    }
    entries.push({
      sessionID,
      isRoot,
      label: isRoot ? "main" : (agentOf?.(sessionID) ?? shortSessionLabel(sessionID)),
      tps: snapshot.active ? snapshot.instantTps : snapshot.avgTps,
      instantTps: snapshot.instantTps,
      active: snapshot.active,
    });
  }

  return entries.sort((a, b) => {
    if (a.isRoot !== b.isRoot) {
      return a.isRoot ? -1 : 1;
    }
    // Spawn order, with the session id as a deterministic tie-break: two subagents
    // dispatched in the same millisecond must not swap columns.
    const aStart = snapshots.get(a.sessionID)?.startedAt ?? 0;
    const bStart = snapshots.get(b.sessionID)?.startedAt ?? 0;
    if (aStart !== bStart) {
      return aStart - bStart;
    }
    return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0;
  });
}

/** True once work has fanned out — i.e. at least one non-root entry qualifies. */
export function hasSubagentEntries(entries: readonly AgentMeterEntry[]): boolean {
  return entries.some((entry) => !entry.isRoot);
}

/**
 * Renders the aggregate line:
 *
 *   TPS Σ 318 | main 63 | explore 91 | general 86 | reviewer 78 | +2
 *
 * Σ covers only currently generating SUBAGENT sessions. The root is excluded on purpose:
 * while children run, the root is by definition waiting on them — and on v1 its reading
 * stays flagged active across that wait, so counting it would report a frozen rate as
 * live throughput. The root's own rate still shows in its column. Finished entries
 * contribute nothing to Σ.
 */
export function formatAggregateLine(entries: readonly AgentMeterEntry[]): string {
  let sum = 0;
  for (const entry of entries) {
    if (entry.active && !entry.isRoot) {
      sum += entry.instantTps;
    }
  }
  const shown = entries.slice(0, MAX_METER_ENTRIES);
  const parts = shown.map((entry) => `${entry.label} ${Math.round(entry.tps)}`);
  const overflow = entries.length - shown.length;
  if (overflow > 0) {
    parts.push(`+${overflow}`);
  }
  return `TPS \u03A3 ${Math.round(sum)} | ${parts.join(" | ")}`;
}
