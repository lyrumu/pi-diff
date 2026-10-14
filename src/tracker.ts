import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Git } from "./git.ts";
import { SnapshotStore } from "./snapshot.ts";
import {
  MAX_TOTAL_PATCH_BYTES,
  emptyPatch,
  makeFilePatch,
  type FilePatch,
} from "./diff-engine.ts";
import { appendTurnDiff, collectTurnDiffs, type TurnDiffEntryData } from "./store.ts";

const IGNORED_DIRS = new Set([".git", "node_modules", ".cache", "dist", "build"]);

/** A file registered for the current turn. */
interface RegisteredFile {
  /** sha256 of turn-start content; null = file did not exist at turn start. */
  oldHash: string | null;
  /** True when the old side could not be recovered (no-git bash change). */
  baselineUnknown: boolean;
}

/**
 * Tracks file changes per turn. Ported from opencode's snapshot/diff stack
 * (packages/core/src/{snapshot,session/diff}.ts), adapted to pi's event model
 * (PLAN.md deviations D2–D4).
 *
 * INVARIANT — single entry point: every file that enters a turn's diff goes
 * through `recordFileChange()`, no matter how it was discovered:
 *   1. tool_call of edit/write (known target file, pre-execution)
 *   2. bash before/after workspace scan (bashMarkers)
 *   3. turn-start baseline catch-up scan at finalizeTurn
 * There is exactly one writer of `turnFiles`; nothing can be "changed by bash
 * but missing from the turn diff".
 *
 * INVARIANT — single scan: `scanWorkspace(marker)` has one implementation;
 * the turn-start baseline and the bash boundaries only pass different markers
 * (git: porcelain string; no-git: mtime marker temp file).
 *
 * Old-side recovery (git): files already dirty at turn start are snapshotted
 * into `turnBaseline` (their turn-start content). Files clean at turn start
 * are recovered from the *pinned turn-start HEAD* (`git show <rev>:path`),
 * which stays correct even when bash runs `git add`/`git commit` mid-turn —
 * using `:path` (live index) or a live `HEAD` would race those commands.
 */
export class Tracker {
  readonly snapshotStore = new SnapshotStore();
  private readonly cwd = process.cwd();
  private git: boolean | null = null;

  private turnNumber = 0;
  private turnFiles = new Map<string, RegisteredFile>();
  /** Pre-dirty files at turn start: path -> content hash (git only). */
  private turnBaseline = new Map<string, string>();
  /** HEAD commit id pinned at turn start (git only; null = unborn). */
  private turnStartHead: string | null = null;
  /** Turn-level marker for the finalize catch-up scan. */
  private turnMarker: string | null = null;
  /** Bash-start markers keyed by toolCallId (parallel bash calls are safe). */
  private bashMarkers = new Map<string, string>();
  /** Restored / accumulated turn diffs on the current branch. */
  private turnDiffs: TurnDiffEntryData[] = [];

  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  // ---------------------------------------------------------------- scanning

  /**
   * THE shared workspace scan. One implementation, callers only differ in the
   * marker they pass:
   * - git repo: marker is a workspace signature (porcelain entries + sha256
   *   of each dirty file's content); returns files whose signature is new or
   *   changed versus that marker. Plain porcelain codes alone cannot see a
   *   dirty file changing again (" M" stays " M"), hence the content hashes.
   * - no git: marker is an mtime marker file path; returns files (under cwd,
   *   excluding IGNORED_DIRS) modified after the marker's mtime.
   * Returns project-relative posix paths.
   */
  async scanWorkspace(marker: string): Promise<string[]> {
    if (await this.isGit()) {
      const before = Git.parseWorkspaceSignature(marker);
      const current = Git.parseWorkspaceSignature(await this.gitWorkspaceSignature());
      const changed: string[] = [];
      for (const [file, sig] of current) {
        if (before.get(file) !== sig) changed.push(file);
      }
      return changed;
    }
    // No-git backend: walk the tree, compare mtimes against the marker file.
    let markerMtime: number;
    try {
      markerMtime = (await stat(marker)).mtimeMs;
    } catch {
      return [];
    }
    const changed: string[] = [];
    await this.walk(this.cwd, markerMtime, changed);
    return changed;
  }

  private async walk(dir: string, markerMtime: number, out: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await this.walk(full, markerMtime, out);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          if (s.mtimeMs > markerMtime) out.push(relative(this.cwd, full).split("\\").join("/"));
        } catch {
          // vanished between readdir and stat — ignore
        }
      }
    }
  }

  /** Make an mtime marker for the no-git backend of scanWorkspace(). */
  async makeMarker(): Promise<string> {
    const file = join(tmpdir(), `pi-diff-marker-${Date.now()}-${randomBytes(4).toString("hex")}`);
    await writeFile(file, "");
    return file;
  }

  private async releaseMarker(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => {});
  }

  // ------------------------------------------------------ change recording

  /** Normalize to a project-relative posix path, or null when outside cwd. */
  private normalize(path: string): string | null {
    const rel = relative(this.cwd, resolve(this.cwd, path)).split("\\").join("/");
    if (!rel || rel.startsWith("../") || rel === ".." || rel === ".") return null;
    return rel;
  }

  /**
   * Single change-recording entry point. First registration wins: a file
   * already registered this turn is a no-op (a bash scan may run after the
   * edit tool already registered the file, and vice versa).
   */
  async recordFileChange(path: string, opts: { fromToolEvent?: boolean } = {}): Promise<void> {
    const file = this.normalize(path);
    if (file === null || this.turnFiles.has(file)) return;

    if (await this.isGit()) {
      // Pre-dirty at turn start: the turn-start snapshot is the old side.
      const baselineHash = this.turnBaseline.get(file);
      if (baselineHash !== undefined) {
        this.turnFiles.set(file, { oldHash: baselineHash, baselineUnknown: false });
        return;
      }
      // Clean at turn start (worktree == index == HEAD then): recover the old
      // side from the pinned turn-start HEAD. Missing there = created during
      // the turn (old side null).
      if (this.turnStartHead !== null) {
        const content = await Git.showRevision(this.cwd, this.turnStartHead, file);
        const oldHash = content !== null ? await this.snapshotStore.put(content) : null;
        this.turnFiles.set(file, { oldHash, baselineUnknown: false });
      } else {
        // Unborn repository (no commits): everything starts from nothing.
        this.turnFiles.set(file, { oldHash: null, baselineUnknown: false });
      }
      return;
    }

    // No git: only tool events (edit/write, pre-execution) can capture the old
    // side from disk. Bash-detected changes have an unrecoverable old side.
    if (opts.fromToolEvent) {
      const content = await this.readFileOrNull(file);
      const oldHash = content !== null ? await this.snapshotStore.put(content) : null;
      this.turnFiles.set(file, { oldHash, baselineUnknown: false });
    } else {
      this.turnFiles.set(file, { oldHash: null, baselineUnknown: true });
    }
  }

  private async readFileOrNull(file: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.cwd, file));
    } catch {
      return null;
    }
  }

  /**
   * Git workspace signature: porcelain entries with a sha256 of each dirty
   * file's disk content ("missing" when deleted). Two signatures differ for
   * any file whose status code or content changed between captures.
   */
  private async gitWorkspaceSignature(): Promise<string> {
    const porcelain = await Git.statusPorcelain(this.cwd);
    const signature: [string, string, string][] = [];
    for (const item of Git.parseStatus(porcelain)) {
      const content = await this.readFileOrNull(item.file);
      const hash = content !== null ? SnapshotStore.hash(content) : "missing";
      signature.push([item.file, item.code, hash]);
    }
    return JSON.stringify(signature);
  }

  // ------------------------------------------------------------------ hooks

  /**
   * Called from before_agent_start: bump turn counter and take the turn
   * baseline — git: workspace signature + content snapshot of already-dirty
   * files + pinned HEAD; no-git: an mtime marker file.
   */
  async onTurnStart(): Promise<void> {
    this.turnNumber += 1;
    this.turnFiles.clear();
    this.turnBaseline.clear();
    this.bashMarkers.clear();
    this.turnMarker = null;

    if (await this.isGit()) {
      this.turnStartHead = await Git.headCommit(this.cwd);
      const porcelain = await Git.statusPorcelain(this.cwd);
      const signature: [string, string, string][] = [];
      for (const item of Git.parseStatus(porcelain)) {
        // Snapshot the turn-start content of dirty files so bash-modified
        // pre-dirty files keep a correct old side. Files already deleted on
        // disk have no turn-start content (a later recreation is "added").
        const content = await this.readFileOrNull(item.file);
        const hash = content !== null ? SnapshotStore.hash(content) : "missing";
        signature.push([item.file, item.code, hash]);
        if (content !== null) {
          this.turnBaseline.set(item.file, await this.snapshotStore.put(content));
        }
      }
      this.turnMarker = JSON.stringify(signature);
    } else {
      this.turnMarker = await this.makeMarker();
    }
  }

  /** Called before every shell tool execution (tool_call of bash/powershell). */
  async onBashStart(toolCallId: string): Promise<void> {
    if (await this.isGit()) {
      this.bashMarkers.set(toolCallId, await this.gitWorkspaceSignature());
    } else {
      this.bashMarkers.set(toolCallId, await this.makeMarker());
    }
  }

  /**
   * Called after every shell tool execution (tool_result): scan vs the bash
   * marker and register newly changed files through the single entry point.
   */
  async onBashEnd(toolCallId: string): Promise<void> {
    const marker = this.bashMarkers.get(toolCallId);
    this.bashMarkers.delete(toolCallId);
    if (marker === undefined) return;
    const changed = await this.scanWorkspace(marker);
    if (!(await this.isGit())) await this.releaseMarker(marker);
    for (const file of changed) await this.recordFileChange(file);
  }

  /**
   * Called from agent_settled: finalize the turn. A turn-level catch-up scan
   * first picks up anything the tool events and bash scans missed (e.g. files
   * written by non-builtin tools); then per-file patches are computed and
   * persisted as one self-contained `pi-diff.turn` custom entry.
   */
  async finalizeTurn(): Promise<void> {
    if (this.turnMarker !== null) {
      const missed = await this.scanWorkspace(this.turnMarker);
      if (!(await this.isGit())) await this.releaseMarker(this.turnMarker);
      for (const file of missed) await this.recordFileChange(file);
      this.turnMarker = null;
    }
    // Orphaned bash markers (aborted bash calls) are dropped with the turn.
    if (this.bashMarkers.size > 0) {
      if (!(await this.isGit())) {
        for (const marker of this.bashMarkers.values()) await this.releaseMarker(marker);
      }
      this.bashMarkers.clear();
    }

    const patches: FilePatch[] = [];
    let capped = false;
    let total = 0;
    for (const file of [...this.turnFiles.keys()].sort()) {
      const registered = this.turnFiles.get(file)!;
      const newContent = await this.readFileOrNull(file);
      const newHash = newContent !== null ? SnapshotStore.hash(newContent) : null;
      // No-op registration (failed edit, touch without change): drop.
      if (registered.oldHash !== null && registered.oldHash === newHash) continue;

      let patch: FilePatch;
      if (capped) {
        // Once the total cap is hit, remaining files degrade (opencode totalPatch).
        patch = {
          file,
          status: "modified",
          patch: emptyPatch(file),
          additions: 0,
          deletions: 0,
          tooLarge: true,
          oldHash: registered.oldHash,
          newHash,
        };
      } else {
        const oldContent =
          registered.oldHash !== null ? await this.snapshotStore.get(registered.oldHash) : null;
        patch = makeFilePatch(file, oldContent, newContent, {
          oldHash: registered.oldHash,
          newHash,
          baselineUnknown: registered.baselineUnknown,
        });
        // Cache the new side for the session-cumulative recompute.
        if (newContent !== null && !patch.binary && !patch.tooLarge) {
          await this.snapshotStore.put(newContent);
        }
      }

      const bytes = Buffer.byteLength(patch.patch, "utf8");
      if (total + bytes > MAX_TOTAL_PATCH_BYTES) {
        capped = true;
        patch = { ...patch, patch: emptyPatch(file), additions: 0, deletions: 0, tooLarge: true };
      } else {
        total += bytes;
      }
      patches.push(patch);
    }

    this.turnFiles.clear();
    this.turnBaseline.clear();

    // Turns with no net changes are not persisted (avoids JSONL noise); turn
    // numbers in later entries stay correct because they are stored per entry.
    if (patches.length === 0) return;

    const data: TurnDiffEntryData = {
      turn: this.turnNumber,
      endedAt: new Date().toISOString(),
      fileCount: patches.length,
      patches,
    };
    this.turnDiffs.push(data);
    appendTurnDiff(this.pi.appendEntry.bind(this.pi), data);
  }

  // -------------------------------------------------------------- accessors

  /** All persisted turn diffs on the current branch, in order. */
  turns(): readonly TurnDiffEntryData[] {
    return this.turnDiffs;
  }

  /**
   * Session-cumulative patches per file: first appearance old side → latest
   * new side (opencode session-diff semantics). Recomputed from cached blobs
   * via makeFilePatch when both sides are available; otherwise degrades to the
   * file's last per-turn patch.
   */
  async sessionPatches(): Promise<FilePatch[]> {
    const first = new Map<string, FilePatch>();
    const last = new Map<string, FilePatch>();
    for (const turn of this.turnDiffs) {
      for (const fp of turn.patches) {
        if (!first.has(fp.file)) first.set(fp.file, fp);
        last.set(fp.file, fp);
      }
    }
    const result: FilePatch[] = [];
    for (const file of [...first.keys()].sort()) {
      const f = first.get(file)!;
      const l = last.get(file)!;
      const oldHash = f.oldHash;
      const newHash = l.newHash;
      const canRecompute =
        l.status !== "deleted" &&
        !f.binary &&
        !l.binary &&
        !f.tooLarge &&
        !l.tooLarge &&
        typeof oldHash === "string" &&
        typeof newHash === "string" &&
        (l.status !== "added" || oldHash !== null);
      if (!canRecompute) {
        // Created and deleted within the session: absent on both ends — drop
        // (opencode session diff would not list the file either).
        if (f.oldHash === null && l.newHash === null) continue;
        result.push(l);
        continue;
      }
      const oldContent =
        oldHash !== null ? await this.snapshotStore.get(oldHash) : null;
      const newContent = await this.snapshotStore.get(newHash);
      if (oldContent === null || (newHash !== null && newContent === null)) {
        // Cache miss (evicted / old session): degrade to the last turn patch.
        result.push(l);
        continue;
      }
      const recomputed = makeFilePatch(file, oldContent, newContent, {
        oldHash,
        newHash,
        baselineUnknown: f.baselineUnknown,
      });
      if (recomputed.oldHash === recomputed.newHash && recomputed.status === "modified") {
        // Net-zero across the session: file added and reverted, etc.
        continue;
      }
      result.push(recomputed);
    }
    return result;
  }

  /**
   * Rebuild Tracker state from `pi-diff.turn` custom entries on the active
   * branch (session reload / resume / branch switch).
   */
  restoreFromSession(sessionManager: { getBranch(): SessionEntry[] }): void {
    this.turnDiffs = collectTurnDiffs(sessionManager.getBranch());
    this.turnNumber = this.turnDiffs.reduce((max, t) => Math.max(max, t.turn), 0);
    this.turnFiles.clear();
    this.turnBaseline.clear();
    this.bashMarkers.clear();
    this.turnMarker = null;
  }

  async cleanupCaches(): Promise<void> {
    await this.snapshotStore.cleanup();
  }

  private async isGit(): Promise<boolean> {
    this.git ??= await Git.isAvailable(this.cwd);
    return this.git;
  }
}
