import type { TurnDiffEntryData } from "../store.ts";

export type DiffScope =
  | { kind: "turn"; turn: number | undefined }
  | { kind: "session" }
  | { kind: "git"; mode: "unstaged" | "working" | "branch" };

export const GIT_SCOPES = [
  { mode: "unstaged", label: "Unstaged" },
  { mode: "working", label: "Uncommitted" },
  { mode: "branch", label: "All branch changes" },
] as const;

/** Cycle the five visible scopes; Git scopes are absent outside a repository. */
export function cycleScope(scope: DiffScope, direction: 1 | -1, turns: readonly TurnDiffEntryData[], gitAvailable: boolean): DiffScope {
  const scopes: DiffScope[] = [{ kind: "turn", turn: turns.at(-1)?.turn }, { kind: "session" },
    ...(gitAvailable ? GIT_SCOPES.map(({ mode }): DiffScope => ({ kind: "git", mode })) : [])];
  const index = scopes.findIndex((item) => item.kind === scope.kind && (item.kind !== "git" || (scope.kind === "git" && item.mode === scope.mode)));
  return scopes[(index + direction + scopes.length) % scopes.length]!;
}
