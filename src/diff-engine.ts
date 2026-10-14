import { diffLines } from "diff";

/** A single changed-file patch for one scope (turn / session / git). */
export interface FilePatch {
  path: string;
  status: "added" | "modified" | "deleted" | "binary" | "tooLarge";
  /** Unified diff hunks with `contextLines` of context. Null for binary/tooLarge. */
  hunks: Hunk[] | null;
  additions: number;
  deletions: number;
  /** True when the old side is unknown (no-git bash-detected change). */
  baselineUnknown: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: { type: "add" | "del" | "context"; text: string; oldNo?: number; newNo?: number }[];
}

export const PATCH_CONTEXT_LINES = 3; // matches opencode vcs/patch.ts
export const MAX_FILE_BYTES = 1024 * 1024; // 1MB: larger files degrade to "tooLarge"

/** Compute a full-file patch from old/new content (never shell out). */
export function computePatch(
  path: string,
  oldContent: string | null,
  newContent: string | null,
  opts: { baselineUnknown?: boolean; isBinary?: boolean } = {},
): FilePatch {
  // TODO: implement using `diff` package structured output + context trimming
  // to PATCH_CONTEXT_LINES; detect binary (NUL byte) and size overflow.
  void diffLines;
  return {
    path,
    status: oldContent === null ? "added" : newContent === null ? "deleted" : "modified",
    hunks: null,
    additions: 0,
    deletions: 0,
    baselineUnknown: opts.baselineUnknown ?? false,
  };
}
