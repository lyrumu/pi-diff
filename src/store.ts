import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FilePatch } from "./diff-engine.ts";

/** Persisted shape of one turn's diff, stored as custom entry `pi-diff.turn`. */
export interface TurnDiffEntryData {
  /** 1-based turn number on the current branch. */
  turn: number;
  /** ISO timestamp of turn end. */
  endedAt: string;
  /** Total changed files in this turn. */
  fileCount: number;
  /** Self-contained patches; the TUI renders from these alone. */
  patches: FilePatch[];
}

export const CUSTOM_TYPE = "pi-diff.turn" as const;

/**
 * Append a turn diff to the session JSONL via pi.appendEntry (custom entry).
 * Entries participate in branching: navigating a branch replays only the
 * entries on that branch, so per-turn and session totals are branch-correct.
 */
export function appendTurnDiff(
  appendEntry: (customType: string, data?: unknown) => void,
  data: TurnDiffEntryData,
): void {
  appendEntry(CUSTOM_TYPE, data);
}

function isTurnDiffData(value: unknown): value is TurnDiffEntryData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.turn === "number" &&
    typeof v.endedAt === "string" &&
    typeof v.fileCount === "number" &&
    Array.isArray(v.patches) &&
    v.patches.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Record<string, unknown>).file === "string" &&
        typeof (p as Record<string, unknown>).patch === "string",
    )
  );
}

/**
 * Rebuild Tracker state from `pi-diff.turn` custom entries on the active
 * branch (session reload / resume / branch switch). Corrupted entries from
 * older versions are skipped instead of crashing.
 */
export function collectTurnDiffs(entries: readonly SessionEntry[]): TurnDiffEntryData[] {
  const result: TurnDiffEntryData[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    if (!isTurnDiffData(entry.data)) continue;
    result.push(entry.data);
  }
  return result;
}
