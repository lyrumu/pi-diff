import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chunksByFile,
  emptyPatch,
  MAX_PATCH_BYTES,
  MAX_TOTAL_PATCH_BYTES,
  type FilePatch,
  type FileStatus,
  type Patch,
} from "./diff-engine.ts";

const exec = promisify(execFile);

/**
 * Read-only git CLI wrapper. Never writes to the repository.
 *
 * Ports opencode's branch/committed/working pipeline with the Effect runtime
 * replaced by async functions. Untracked files use its read-only per-file
 * fallback instead of the temporary-index optimization (see PLAN.md).
 */

const BASE_ARGS = [
  "--no-optional-locks",
  "-c", "core.autocrlf=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.longpaths=true",
  "-c", "core.symlinks=true",
  "-c", "core.quotepath=false",
] as const;

export const VCS_DIFF_CONTEXT_LINES = 12;
export type GitDiffMode = "branch" | "committed" | "working" | "unstaged";
export interface GitDiffOptions {
  readonly context?: number;
  readonly base?: string;
}

interface Item extends StatusItem {
  readonly status: FileStatus;
}

interface Stat {
  readonly file: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

/** Drain capped output without retaining more than the byte budget. */
function run(cwd: string, args: readonly string[], maxOutputBytes = 64 * 1024 * 1024) {
  return new Promise<{ text: string; truncated: boolean; exitCode: number }>((resolve) => {
    const child = spawn("git", [...BASE_ARGS, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const available = Math.max(0, maxOutputBytes - size);
      if (chunk.length > available) truncated = true;
      if (available > 0) {
        const kept = chunk.subarray(0, available);
        chunks.push(kept);
        size += kept.length;
      }
    });
    child.stderr.resume();
    child.on("error", () => resolve({ text: "", truncated: false, exitCode: 1 }));
    child.on("close", (code) => resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated, exitCode: code ?? 1 }));
  });
}

const kind = (code: string): FileStatus => {
  if (code === "??") return "added";
  if (code.includes("U")) return "modified";
  if (code.includes("A") && !code.includes("D")) return "added";
  if (code.includes("D") && !code.includes("A")) return "deleted";
  return "modified";
};

const nuls = (text: string) => text.split("\0").filter(Boolean);

const numstat = (text: string): Stat[] =>
  nuls(text).flatMap((item) => {
    const a = item.indexOf("\t");
    const b = item.indexOf("\t", a + 1);
    if (a === -1 || b === -1) return [];
    const file = item.slice(b + 1);
    if (!file) return [];
    const adds = item.slice(0, a);
    const dels = item.slice(a + 1, b);
    const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10);
    const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10);
    return [{
      file,
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      binary: adds === "-" || dels === "-",
    }];
  });

async function lines(cwd: string, args: string[]) {
  return (await run(cwd, args)).text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function defaultBranch(cwd: string): Promise<{ name: string; ref: string } | undefined> {
  const remotes = await lines(cwd, ["remote"]);
  const remote = remotes.includes("origin") ? "origin"
    : remotes.length === 1 ? remotes[0]
    : remotes.includes("upstream") ? "upstream" : remotes[0];
  if (remote) {
    const head = await run(cwd, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
    if (head.exitCode === 0) {
      const ref = head.text.trim().replace(/^refs\/remotes\//, "");
      const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : "";
      if (name) return { name, ref };
    }
  }
  const list = await lines(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const configured = (await run(cwd, ["config", "init.defaultBranch"])).text.trim();
  if (configured && list.includes(configured)) return { name: configured, ref: configured };
  if (list.includes("main")) return { name: "main", ref: "main" };
  if (list.includes("master")) return { name: "master", ref: "master" };
  return undefined;
}

async function mergeBase(cwd: string, base: string) {
  const resolved = await run(cwd, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  if (resolved.exitCode !== 0) return undefined;
  const result = await run(cwd, ["merge-base", resolved.text.trim(), "HEAD"]);
  return result.exitCode === 0 ? result.text.trim() || undefined : undefined;
}

async function nativePatch(root: string, ref: string | undefined, item: Item, context: number, target?: "HEAD"): Promise<Patch> {
  const result = await run(root, [
    "--literal-pathspecs", "diff",
    ...(item.code === "??" || ref === undefined ? ["--no-index"] : []),
    "--patch", "--no-ext-diff", "--no-renames", `--unified=${context}`,
    ...(item.code === "??" || ref === undefined ? ["--", "/dev/null", item.file] : [...(ref ? [ref] : []), ...(target ? [target] : []), "--", item.file]),
  ], MAX_PATCH_BYTES);
  // --no-index reports differences with exit code 1, not a command failure.
  if (result.exitCode !== 0 && !(result.exitCode === 1 && (item.code === "??" || ref === undefined))) {
    throw new Error(`Unable to read Git patch for ${item.file}`);
  }
  return { text: result.truncated ? "" : result.text, truncated: result.truncated };
}

async function statUntracked(root: string, file: string): Promise<Stat | undefined> {
  const result = await run(root, ["diff", "--no-index", "--numstat", "--", "/dev/null", file], 4096);
  if (result.truncated) return undefined;
  return numstat(result.text)[0];
}

async function files(
  root: string,
  ref: string | undefined,
  list: Item[],
  stats: Map<string, Stat>,
  batch: { patches: Map<string, string>; capped: boolean },
  context: number,
  target?: "HEAD",
): Promise<FilePatch[]> {
  const next: FilePatch[] = [];
  let total = 0;
  let capped = false;
  for (const item of list.sort((a, b) => a.file.localeCompare(b.file))) {
    const stat = stats.get(item.file) ?? (!target && item.status === "added" ? await statUntracked(root, item.file) : undefined);
    let patch = emptyPatch(item.file);
    let tooLarge = capped;
    if (!capped) {
      const batched = batch.patches.get(item.file);
      if (batched !== undefined) patch = batched;
      else if (item.code !== "??" && batch.capped) tooLarge = true;
      else {
        const result = await nativePatch(root, ref, item, context, target);
        tooLarge = result.truncated;
        if (!result.truncated && result.text) patch = result.text;
      }
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) tooLarge = true;
      if (tooLarge) patch = emptyPatch(item.file);
      if (total + Buffer.byteLength(patch) > MAX_TOTAL_PATCH_BYTES) {
        capped = true;
        tooLarge = true;
        patch = emptyPatch(item.file);
      }
      if (!capped) {
        total += Buffer.byteLength(patch);
        capped = total >= MAX_TOTAL_PATCH_BYTES;
      }
    }
    const binary = stat?.binary || /^Binary files .+ differ$/m.test(patch);
    next.push({
      file: item.file,
      status: item.status,
      patch: binary ? "" : patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      ...(binary ? { binary: true } : {}),
      ...(tooLarge ? { tooLarge: true } : {}),
    });
  }
  return next;
}

export interface StatusItem {
  /** Project-relative posix path. */
  file: string;
  /** Two-letter porcelain code, e.g. " M", "??", "M ". */
  code: string;
}

export const Git = {
  /** working: HEAD → disk; committed: merge base → HEAD; branch: merge base → disk. */
  async diff(cwd: string, mode: GitDiffMode, options: GitDiffOptions = {}): Promise<FilePatch[]> {
    const context = options.context ?? VCS_DIFF_CONTEXT_LINES;
    if (!Number.isSafeInteger(context) || context < 0) throw new Error("Invalid Git diff context");
    if (!await Git.isAvailable(cwd)) return [];
    const rootResult = await run(cwd, ["rev-parse", "--show-toplevel"]);
    if (rootResult.exitCode !== 0) throw new Error("Unable to find Git worktree");
    const root = rootResult.text.replace(/\r?\n$/, "");
    const hasHead = await Git.headCommit(cwd) !== null;
    if (!hasHead && mode === "committed") return [];
    // Empty ref compares disk against the index; undefined means an unborn baseline.
    let ref: string | undefined = mode === "unstaged" ? "" : hasHead ? "HEAD" : undefined;
    const target = mode === "committed" ? "HEAD" : undefined;
    if (hasHead && mode !== "working" && mode !== "unstaged") {
      const base = options.base ?? (await defaultBranch(cwd))?.ref;
      ref = base ? await mergeBase(cwd, base) : undefined;
      if (!ref) throw new Error(base ? `No merge base available for ${base}` : "No review base available");
    }
    const extraResult = target ? { text: "", exitCode: 0, truncated: false }
      : await run(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."]);
    if (extraResult.exitCode !== 0 || extraResult.truncated) throw new Error("Unable to list Git changes");
    const extra: Item[] = Git.parseStatus(extraResult.text).map((item) => ({ ...item, status: kind(item.code) }));
    if (ref === undefined) return files(root, ref, extra, new Map(), { patches: new Map(), capped: false }, context);
    const args = ["diff", "--no-ext-diff", "--no-renames"];
    const revisions = [...(ref ? [ref] : []), ...(target ? [target] : []), "--", "."];
    const [names, counts] = await Promise.all([
      run(cwd, [...args, "--name-status", "-z", ...revisions]),
      run(cwd, [...args, "--numstat", "-z", ...revisions]),
    ]);
    if (names.exitCode !== 0 || names.truncated || counts.exitCode !== 0 || counts.truncated) {
      throw new Error("Unable to list Git changes");
    }
    const tokens = nuls(names.text);
    const list: Item[] = tokens.flatMap((code, idx) => {
      const file = tokens[idx + 1];
      return idx % 2 === 0 && file ? [{ file, code, status: kind(code) }] : [];
    });
    const result = list.length === 0 ? { text: "", truncated: false, exitCode: 0 }
      : await run(cwd, [...args, "--patch", `--unified=${context}`, ...revisions], MAX_TOTAL_PATCH_BYTES);
    if (result.exitCode !== 0) throw new Error("Unable to read Git changes");
    const merged = new Map(list.map((item) => [item.file, item]));
    for (const item of extra) if (item.code === "??" && !merged.has(item.file)) merged.set(item.file, item);
    return files(root, ref, [...merged.values()], new Map(numstat(counts.text).map((stat) => [stat.file, stat])), {
      patches: chunksByFile(result, (index) => list[index]?.file),
      capped: result.truncated,
    }, context, target);
  },

  async isAvailable(cwd: string): Promise<boolean> {
    // `git rev-parse --is-inside-work-tree`
    return exec("git", [...BASE_ARGS, "rev-parse", "--is-inside-work-tree"], { cwd })
      .then((r) => r.stdout.trim() === "true")
      .catch(() => false);
  },

  /** Current HEAD commit id, or null (e.g. unborn branch). */
  async headCommit(cwd: string): Promise<string | null> {
    try {
      const r = await exec("git", [...BASE_ARGS, "rev-parse", "HEAD"], { cwd });
      return r.stdout.trim() || null;
    } catch {
      return null;
    }
  },

  /** Root-relative directory prefix for porcelain and revision paths. */
  async prefix(cwd: string): Promise<string> {
    const result = await run(cwd, ["rev-parse", "--show-prefix"]);
    if (result.exitCode !== 0) throw new Error("Unable to resolve Git directory prefix");
    return result.text.replace(/\r?\n$/, "");
  },

  /** Changed tracked paths when a shell command also moves HEAD. */
  async changedCommitFiles(cwd: string, from: string | null, to: string | null): Promise<string[]> {
    if (from === to || (!from && !to)) return [];
    if ([from, to].some((ref) => ref !== null && !/^[a-f0-9]{40,64}$/.test(ref))) return [];
    const args = from && to
      ? ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", from, to, "--", "."]
      : ["ls-tree", "-r", "--name-only", "-z", (to ?? from)!, "--", "."];
    const result = await run(cwd, args);
    if (result.exitCode !== 0 || result.truncated) throw new Error("Unable to list committed file changes");
    return nuls(result.text);
  },

  /**
   * Raw `git status --porcelain=v1 -z` output, used as an opaque workspace
   * marker by Tracker.scanWorkspace (two markers are compared via
   * parseStatus). Arguments align with opencode `VcsGit.statusNames`.
   */
  async statusPorcelain(cwd: string): Promise<string> {
    try {
      const r = await exec(
        "git",
        [
          ...BASE_ARGS,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--no-renames",
          "-z",
          "--",
          ".",
        ],
        { cwd, maxBuffer: 64 * 1024 * 1024 },
      );
      return r.stdout;
    } catch {
      return "";
    }
  },

  /**
   * Parse porcelain `-z` output into items. With --no-renames every NUL-
   * separated token is "XY <path>" (port of opencode's nuls().flatMap).
   */
  parseStatus(raw: string): StatusItem[] {
    return raw
      .split("\0")
      .flatMap((item) => {
        const file = item.slice(3);
        if (!file) return [];
        const code = item.slice(0, 2);
        return [{ file, code }];
      });
  },

  /**
   * Parse a workspace signature into file -> "code:hash" entries. Returns an
   * empty map for markers that are not valid signatures.
   */
  parseWorkspaceSignature(marker: string): Map<string, string> {
    let entries: [string, string, string][];
    try {
      const parsed: unknown = JSON.parse(marker);
      const files = typeof parsed === "object" && parsed !== null && "files" in parsed ? parsed.files : parsed;
      if (!Array.isArray(files)) return new Map();
      entries = files as [string, string, string][];
    } catch {
      return new Map();
    }
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const [file, code, hash] = entry;
      if (typeof file !== "string" || typeof code !== "string" || typeof hash !== "string") continue;
      map.set(file, `${code}:${hash}`);
    }
    return map;
  },

  /**
   * File content (raw bytes) at a revision, e.g. "HEAD" or a pinned commit.
   * Returns null when the path did not exist at that revision or git failed.
   */
  async showRevision(cwd: string, rev: string, path: string): Promise<Buffer | null> {
    try {
      const r = await exec("git", [...BASE_ARGS, "show", `${rev}:${path}`], {
        cwd,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      }) as unknown as { stdout: Buffer };
      return r.stdout;
    } catch {
      return null;
    }
  },
} as const;
