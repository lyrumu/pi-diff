import { formatPatch, structuredPatch } from "diff";

/**
 * Patch primitives — ported from opencode `packages/core/src/vcs/patch.ts`
 * (MIT, see NOTICE.md). Kept line-for-line where possible; TypeScript guards
 * and the hunk-aware countPatch correction are documented in PLAN.md.
 * The `diff` package provides structuredPatch/formatPatch, exactly as upstream.
 */

// Effectively "full file" context; adapters use it when no context is requested.
export const PATCH_CONTEXT_LINES = 2_147_483_647;
export const MAX_PATCH_BYTES = 10_000_000;
export const MAX_TOTAL_PATCH_BYTES = 10_000_000;

export interface Patch {
  readonly text: string;
  readonly truncated: boolean;
}

export const emptyPatch = (file: string) =>
  formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }));

export const addPatch = (file: string, content: string) =>
  formatPatch(structuredPatch(file, file, "", content, "", "", { context: 0 }));

export const deletePatch = (file: string, content: string) =>
  formatPatch(structuredPatch(file, file, content, "", "", "", { context: 0 }));

/** Count changed lines in a unified diff, ignoring `+++`/`---` file headers. */
export const countPatch = (patch: string) => {
  let additions = 0;
  let deletions = 0;
  let remaining = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.startsWith("@@ ") ? /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line) : null;
    if (hunk) remaining = Number(hunk[1] ?? 1) + Number(hunk[2] ?? 1);
    else if (remaining > 0) {
      if (line.startsWith("+")) { additions++; remaining--; }
      else if (line.startsWith("-")) { deletions++; remaining--; }
      else if (line.startsWith(" ")) remaining -= 2;
    }
  }
  return { additions, deletions };
};

const parseQuotedPath = (value: string) => {
  let out = "";
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]!;
    if (char === '"') return { value: out, end: idx + 1 };
    if (char !== "\\") {
      out += char;
      continue;
    }

    const next = value[++idx];
    if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === '"' || next === "\\") out += next;
    else out = next ?? "";
  }
  return undefined;
};

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0] ?? value;
  return parseQuotedPath(value)?.value ?? value;
};

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return undefined;
  const file = parsePathToken(value);
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2);
  return file;
};

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header);
    const second = first ? header.slice(first.end).trimStart() : undefined;
    if (!second) return undefined;
    if (!second.startsWith('"')) return fileFromDiffPath(second);
    const parsed = parseQuotedPath(second);
    return fileFromDiffPath(parsed?.value);
  }

  const separator = header.indexOf(" b/");
  if (separator === -1) return undefined;
  return fileFromDiffPath(header.slice(separator + 1));
};

export const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1];
  const before = /^--- (.+)$/m.exec(chunk)?.[1];
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before);
  if (file) return file;

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1];
  return fileFromGitHeader(header ?? "");
};

/** Split `git diff`-format output into per-file chunks, dropping a trailing partial chunk when truncated. */
export const splitGitPatch = (patch: Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  );
  const chunks = starts.map((start, index) =>
    patch.text.slice(start, starts[index + 1] ?? patch.text.length),
  );
  if (!patch.truncated) return chunks;
  return chunks.slice(0, -1);
};

/** Map per-file chunks by the file they touch, concatenating chunks for the same file. */
export const chunksByFile = (patch: Patch, fallback: (index: number) => string | undefined) =>
  splitGitPatch(patch).reduce((acc, chunk, index) => {
    const file = fileFromPatchChunk(chunk) ?? fallback(index);
    if (!file) return acc;
    acc.set(file, (acc.get(file) ?? "") + chunk);
    return acc;
  }, new Map<string, string>());

// ---------------------------------------------------------------------------
// Session-diff view layer (pi-diff specific; opencode computes this via its
// git snapshot trees — see PLAN.md deviations D3/D4).
// ---------------------------------------------------------------------------

/** Status of a changed file, mirroring opencode `FileStatus["status"]`. */
export type FileStatus = "added" | "modified" | "deleted";

/**
 * A single changed-file patch for one scope (turn / session / git). The
 * unified `patch` text is the core primitive (opencode-aligned); hashes are
 * content-addressed cache hints for the session-cumulative recompute.
 */
export interface FilePatch {
  /** Project-relative posix path. */
  file: string;
  status: FileStatus;
  /** Unified diff text; empty for binary / capped files. */
  patch: string;
  additions: number;
  deletions: number;
  /** Old side is unknown (no-git bash-detected change). */
  baselineUnknown?: boolean;
  /** Content is binary; UI shows "binary file changed". */
  binary?: boolean;
  /** Patch exceeded the byte cap and was emptied. */
  tooLarge?: boolean;
  /** A file side could not be read or captured; never treat it as absent. */
  unavailable?: boolean;
  /** Only the latest turn patch is available for a cumulative view. */
  cumulativeFallback?: boolean;
  /** sha256 of old-side bytes; null = file did not exist on the old side. */
  oldHash?: string | null;
  /** sha256 of new-side bytes; null = file does not exist on the new side. */
  newHash?: string | null;
}

/** Detect binary content the way git does: a NUL byte anywhere in the buffer. */
export function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

/**
 * Build a full-file-context FilePatch from old/new content buffers.
 * Applies opencode's degradation rules: binary → empty patch + `binary`;
 * patch larger than MAX_PATCH_BYTES → emptyPatch + `tooLarge`.
 */
export function makeFilePatch(
  file: string,
  oldContent: Buffer | null,
  newContent: Buffer | null,
  opts: { oldHash?: string | null; newHash?: string | null; baselineUnknown?: boolean } = {},
): FilePatch {
  const status: FileStatus =
    oldContent === null ? "added" : newContent === null ? "deleted" : "modified";
  const base: FilePatch = {
    file,
    status,
    patch: "",
    additions: 0,
    deletions: 0,
    oldHash: opts.oldHash ?? null,
    newHash: opts.newHash ?? null,
  };
  if (opts.baselineUnknown) base.baselineUnknown = true;

  const binary = (oldContent !== null && isBinary(oldContent)) || (newContent !== null && isBinary(newContent));
  if (binary) {
    base.binary = true;
    return base;
  }

  // Skip patch computation for oversized inputs; the patch could not fit the cap anyway.
  const oldLen = oldContent?.byteLength ?? 0;
  const newLen = newContent?.byteLength ?? 0;
  if (Math.max(oldLen, newLen) > MAX_PATCH_BYTES) {
    base.tooLarge = true;
    return base;
  }

  const oldStr = oldContent?.toString("utf8") ?? "";
  const newStr = newContent?.toString("utf8") ?? "";
  const text = formatPatch(structuredPatch(file, file, oldStr, newStr, "", "", {
    context: PATCH_CONTEXT_LINES,
  }));
  if (Buffer.byteLength(text, "utf8") > MAX_PATCH_BYTES) {
    base.tooLarge = true;
    return base;
  }
  base.patch = text;
  const counts = countPatch(text);
  base.additions = counts.additions;
  base.deletions = counts.deletions;
  return base;
}
