/** Persisted shape of one turn's diff, stored as custom entry `pi-diff.turn`. */
export interface TurnDiffEntryData {
  /** 1-based turn number on the current branch. */
  turn: number;
  /** ISO timestamp of turn end. */
  endedAt: string;
  /** Total changed files in this turn. */
  fileCount: number;
  /** Self-contained patches; the TUI renders from these alone. */
  patches: import("./diff-engine.ts").FilePatch[];
}

export const CUSTOM_TYPE = "pi-diff.turn" as const;

/**
 * Append a turn diff to the session JSONL via pi.appendEntry (custom entry).
 * Entries participate in branching: navigating a branch replays only the
 * entries on that branch, so per-turn and session totals are branch-correct.
 */
export async function appendTurnDiff(
  appendEntry: (data: { customType: string; data: unknown }) => void,
  data: TurnDiffEntryData,
): Promise<void> {
  await appendEntry({ customType: CUSTOM_TYPE, data });
}

/**
 * Rebuild Tracker state from `pi-diff.turn` custom entries on the active
 * branch. Called on session_start (reload/resume/branch switch).
 */
export async function collectTurnDiffs(
  getBranch: () => Promise<unknown[]>,
): Promise<TurnDiffEntryData[]> {
  // TODO: walk ctx.sessionManager.getBranch(), filter custom entries by
  // customType, return TurnDiffEntryData[] in order.
  void getBranch;
  return [];
}
