import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Read-only git CLI wrapper. Never writes to the repository.
 *
 * Phase 1 scope: repository detection, porcelain status (turn/bash markers),
 * HEAD pinning and blob retrieval (`git show <rev>:<path>`) for old-side
 * recovery. The branch/committed/working diff scopes (opencode
 * `plugin/vcs/git.ts` ports) are added in phase 2 — see PLAN.md.
 *
 * Global flags mirror opencode's `cfg` list where read semantics matter
 * (`--no-optional-locks`, `core.quotepath=false`); the rest are irrelevant
 * for read-only commands.
 */

const BASE_ARGS = ["--no-optional-locks", "-c", "core.quotepath=false"] as const;

export interface StatusItem {
  /** Project-relative posix path. */
  file: string;
  /** Two-letter porcelain code, e.g. " M", "??", "M ". */
  code: string;
}

export const Git = {
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
      if (!Array.isArray(parsed)) return new Map();
      entries = parsed as [string, string, string][];
    } catch {
      return new Map();
    }
    const map = new Map<string, string>();
    for (const [file, code, hash] of entries) {
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
