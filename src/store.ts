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
    typeof v.turn === "number" && Number.isSafeInteger(v.turn) && v.turn > 0 &&
    typeof v.endedAt === "string" && Number.isFinite(Date.parse(v.endedAt)) &&
    typeof v.fileCount === "number" && Number.isSafeInteger(v.fileCount) && v.fileCount >= 0 &&
    Array.isArray(v.patches) &&
    v.fileCount === v.patches.length && v.patches.every(isFilePatch)
  );
}

function isFilePatch(value: unknown): value is FilePatch {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.file === "string" && p.file.length > 0 && !p.file.includes("\0") &&
    typeof p.patch === "string" &&
    (p.status === "added" || p.status === "modified" || p.status === "deleted") &&
    typeof p.additions === "number" && Number.isSafeInteger(p.additions) && p.additions >= 0 &&
    typeof p.deletions === "number" && Number.isSafeInteger(p.deletions) && p.deletions >= 0 &&
    [p.oldHash, p.newHash].every((hash) => hash === undefined || hash === null || (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) &&
    [p.binary, p.tooLarge, p.baselineUnknown, p.unavailable, p.cumulativeFallback].every((flag) => flag === undefined || typeof flag === "boolean");
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

/** Recognize unusable old records without treating them as successful empty turns. */
export function hasUnavailableTurnDiffs(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) => {
    if (entry.type !== "custom") return false;
    const type: unknown = entry.customType;
    if (typeof type === "object" && type !== null && "customType" in type && type.customType === CUSTOM_TYPE) return true;
    return type === CUSTOM_TYPE && !isTurnDiffData(entry.data);
  });
}
