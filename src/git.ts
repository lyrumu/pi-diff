import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Read-only git CLI wrapper. Never writes to the repository. */
export namespace Git {
  export function isAvailable(cwd: string): Promise<boolean> {
    // `git rev-parse --is-inside-work-tree`
    return exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd })
      .then((r) => r.stdout.trim() === "true")
      .catch(() => false);
  }

  /**
   * List changed files vs the given baseline kind.
   * - "worktree": uncommitted + untracked (vs HEAD)
   * - "unstaged": vs index
   * - "branch":   merge-base of current branch vs main/master
   * Returned paths are relative to cwd, posix-normalized.
   */
  export async function changedFiles(
    cwd: string,
    kind: "worktree" | "unstaged" | "branch",
  ): Promise<string[]> {
    // TODO: implement with `git status --porcelain` / `git diff --name-status`
    // / `git merge-base`. Keep all parsing here so callers never shell out.
    void cwd;
    void kind;
    return [];
  }

  /**
   * File content at a baseline, used to recover the "old" side of a file that
   * was already modified before we snapshotted it (bash-detected changes).
   * Returns null when the file did not exist at that baseline.
   */
  export async function baselineContent(
    cwd: string,
    path: string,
    baseline: "index" | "head",
  ): Promise<string | null> {
    // TODO: `git show :path` (index) or `git show HEAD:path` (head).
    void cwd;
    void path;
    void baseline;
    return null;
  }

  /**
   * Unified patch for a git scope. Returns raw `git diff` output; the TUI
   * layer parses it with the same diff-engine used for session patches.
   */
  export async function patch(
    cwd: string,
    kind: "worktree" | "unstaged" | "branch",
    contextLines = 3,
  ): Promise<string> {
    // TODO: `git diff` with the right refspec and `-U<contextLines>`.
    void cwd;
    void kind;
    void contextLines;
    return "";
  }
}
