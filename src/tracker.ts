import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Git } from "./git.ts";
import { SnapshotStore } from "./snapshot.ts";
import { computePatch, type FilePatch } from "./diff-engine.ts";
import { appendTurnDiff, type TurnDiffEntryData } from "./store.ts";

const IGNORED = [".git", "node_modules", ".cache", "dist", "build"];

/**
 * Tracks file changes per turn. Ported from opencode's snapshot/diff stack
 * (packages/core/src/session/{snapshot,diff}.ts), adapted to pi's event model.
 *
 * INVARIANT — single entry point: every file that enters a turn's diff goes
 * through `recordFileChange()`, no matter how it was discovered:
 *   1. tool_call of edit/write (known target file)
 *   2. bash before/after workspace scan
 *   3. turn-start baseline scan
 * There is exactly one snapshot index and one writer; nothing can be
 * "changed by bash but missing from the snapshot index".
 */
export class Tracker {
  readonly snapshotStore = new SnapshotStore();
  private readonly cwd: string;
  private git: boolean | null = null;

  /** Files registered for the current turn: path -> old snapshot hash (or null = added). */
  private turnFiles = new Map<string, string | null>();
  private turnNumber = 0;
  /** Restored / accumulated turn diffs on the current branch. */
  private turnDiffs: TurnDiffEntryData[] = [];

  constructor(private readonly pi: ExtensionAPI) {
    this.cwd = process.cwd();
  }

  // ---------------------------------------------------------------- scanning

  /**
   * THE shared workspace scan. One implementation, two callers
   * (turn-start baseline scan and bash before/after scan) that only differ
   * in the marker they pass — never two divergent code paths.
   *
   * - git repo: `git status --porcelain` diff vs the recorded baseline
   *   status (marker is the baseline status string).
   * - no git: `find -newer <marker-file>` (marker is a temp mtime marker
   *   file), excluding IGNORED dirs.
   *
   * Returns posix-relative paths that changed since the marker.
   */
  async scanWorkspace(marker: string): Promise<string[]> {
    // TODO: implement both backends behind this single signature.
    void marker;
    return [];
  }

  /** Make an mtime marker for the no-git backend of scanWorkspace(). */
  async makeMarker(): Promise<string> {
    // TODO: touch a temp file, return its path.
    return "";
  }

  // ------------------------------------------------------ change recording

  /**
   * Single change-recording entry point. First time a path is seen in the
   * current turn, capture its "old" side:
   * - git repo: file untouched by us yet on disk? snapshot disk content;
   *   already modified (bash race)? recover old side via Git.baselineContent.
   * - no git: snapshot disk content; if the file was already modified by the
   *   bash command itself, the old side is unknown -> baselineUnknown patch.
   */
  async recordFileChange(path: string): Promise<void> {
    if (this.turnFiles.has(path)) return;
    // TODO: implement old-side capture as described above.
    this.turnFiles.set(path, null);
  }

  // ------------------------------------------------------------------ hooks

  async onTurnStart(): Promise<void> {
    // Called from before_agent_start: bump turn counter, baseline scan via
    // scanWorkspace() so nothing bypassing tool events is missed.
    this.turnNumber += 1;
    this.turnFiles.clear();
  }

  async onBashBoundary(marker: string): Promise<void> {
    // Called before and after every bash tool call; diff of scanWorkspace()
    // results feeds recordFileChange().
    const changed = await this.scanWorkspace(marker);
    for (const p of changed) await this.recordFileChange(p);
  }

  async finalizeTurn(): Promise<void> {
    // Called from turn_end: compute FilePatch[] for every registered file,
    // append a self-contained `pi-diff.turn` custom entry, keep in memory.
    const patches: FilePatch[] = [];
    for (const [path, oldHash] of this.turnFiles) {
      const oldContent = oldHash === null ? null : await this.snapshotStore.get(oldHash);
      // TODO: read current disk content, computePatch, handle missing file.
      patches.push(computePatch(path, oldContent, null));
    }
    const data: TurnDiffEntryData = {
      turn: this.turnNumber,
      endedAt: new Date().toISOString(),
      fileCount: patches.length,
      patches,
    };
    this.turnDiffs.push(data);
    await appendTurnDiff((d) => this.pi.appendEntry(d as never), data);
    this.turnFiles.clear();
  }

  // -------------------------------------------------------------- accessors

  sessionPatches(): FilePatch[] {
    // TODO: merge all turnDiffs' patches per file into a session-total view
    // (fold consecutive patches per path, like opencode's session diff).
    return this.turnDiffs.flatMap((t) => t.patches);
  }

  turns(): TurnDiffEntryData[] {
    return this.turnDiffs;
  }

  async restoreFromSession(sessionManager: {
    getBranch(): unknown[];
  }): Promise<void> {
    // TODO: collectTurnDiffs + rebuild turnNumber/turnDiffs.
    void sessionManager;
  }

  async cleanupCaches(): Promise<void> {
    await this.snapshotStore.cleanup();
  }

  async isGit(): Promise<boolean> {
    this.git ??= await Git.isAvailable(this.cwd);
    return this.git;
  }
}

export { IGNORED };
