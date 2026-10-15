import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
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
  unavailable?: boolean;
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
 * (git: HEAD + dirty-file signatures; no-git: mtime + pathname inventory).
 *
 * Old-side recovery (git): files already dirty at turn start are snapshotted
 * into `turnBaseline` (their turn-start content). Files clean at turn start
 * are recovered from the *pinned turn-start HEAD* (`git show <rev>:path`),
 * which stays correct even when bash runs `git add`/`git commit` mid-turn —
 * using `:path` (live index) or a live `HEAD` would race those commands.
 */
export class Tracker {
  readonly snapshotStore: SnapshotStore;
  private readonly cwd = process.cwd();
  private git: boolean | null = null;
  private gitPrefix = "";

  private turnNumber = 0;
  private turnFiles = new Map<string, RegisteredFile>();
  /** Pre-dirty files at turn start: path -> content hash or known absence. */
  private turnBaseline = new Map<string, string | null>();
  private unavailableBaseline = new Set<string>();
  /** HEAD commit id pinned at turn start (git only; null = unborn). */
  private turnStartHead: string | null = null;
  /** Turn-level marker for the finalize catch-up scan. */
  private turnMarker: string | null = null;
  /** Bash-start markers keyed by toolCallId (parallel bash calls are safe). */
  private bashMarkers = new Map<string, string>();
  /** Restored / accumulated turn diffs on the current branch. */
  private turnDiffs: TurnDiffEntryData[] = [];

  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI, snapshotStore = new SnapshotStore()) {
    this.pi = pi;
    this.snapshotStore = snapshotStore;
  }

  // ---------------------------------------------------------------- scanning

  /**
   * THE shared workspace scan. One implementation, callers only differ in the
   * marker they pass:
   * - git repo: marker is a workspace signature (HEAD + porcelain entries + sha256
   *   of each dirty file's content); returns files whose signature is new or
   *   changed versus that marker, including paths that became clean. HEAD
   *   changes also include committed paths. Plain porcelain cannot see a
   *   dirty file changing again (" M" stays " M"), hence the content hashes.
   * - no git: marker is an mtime marker file path; returns files (under cwd,
   *   excluding IGNORED_DIRS) modified after the marker's mtime or deleted
   *   since the marker's pathname inventory.
   * Returns project-relative posix paths.
   */
  async scanWorkspace(marker: string): Promise<string[]> {
    if (await this.isGit()) {
      const before = Git.parseWorkspaceSignature(marker);
      const currentMarker = await this.gitWorkspaceSignature();
      const current = Git.parseWorkspaceSignature(currentMarker);
      const changed = new Set<string>();
      for (const file of new Set([...before.keys(), ...current.keys()])) {
        if (before.get(file) !== current.get(file)) changed.add(file);
      }
      let previousHead: string | null = null;
      try {
        const value = JSON.parse(marker)?.head;
        if (typeof value === "string") previousHead = value;
      } catch { /* An invalid marker has no recoverable HEAD. */ }
      const currentHead: string | null = JSON.parse(currentMarker).head;
      for (const file of await Git.changedCommitFiles(this.cwd, previousHead, currentHead)) {
        if (file.startsWith(this.gitPrefix)) changed.add(file.slice(this.gitPrefix.length));
      }
      return [...changed];
    }
    // No-git backend: walk the tree, compare mtimes against the marker file.
    let markerMtime: number;
    let previous: string[];
    try {
      markerMtime = (await stat(marker)).mtimeMs;
      const value: unknown = JSON.parse(await readFile(marker, "utf8"));
      if (!Array.isArray(value) || !value.every((file) => typeof file === "string")) return [];
      previous = value;
    } catch {
      return [];
    }
    const current = new Map<string, number>();
    await this.walk(this.cwd, current);
    const existing = new Set(previous);
    const changed = [...current].filter(([file, mtime]) => !existing.has(file) || mtime > markerMtime).map(([file]) => file);
    for (const file of previous) if (!current.has(file)) changed.push(file);
    return changed;
  }

  private async walk(dir: string, out: Map<string, number>): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await this.walk(full, out);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          out.set(relative(this.cwd, full).split(sep).join("/"), s.mtimeMs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }

  /** Make an mtime marker for the no-git backend of scanWorkspace(). */
  async makeMarker(): Promise<string> {
    const files = new Map<string, number>();
    await this.walk(this.cwd, files);
    const file = join(tmpdir(), `pi-diff-marker-${Date.now()}-${randomBytes(4).toString("hex")}`);
    await writeFile(file, JSON.stringify([...files.keys()]));
    return file;
  }

  private async releaseMarker(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => {});
  }

  // ------------------------------------------------------ change recording

  /** Normalize to a project-relative posix path, or null when outside cwd. */
  private normalize(path: string): string | null {
    if (path.includes("\0")) return null;
    const rel = relative(this.cwd, resolve(this.cwd, path)).split(sep).join("/");
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

    let registered: RegisteredFile;
    try {
      if (await this.isGit()) {
        if (this.unavailableBaseline.has(file)) {
          registered = { oldHash: null, baselineUnknown: true, unavailable: true };
        } else if (this.turnBaseline.has(file)) {
          registered = { oldHash: this.turnBaseline.get(file)!, baselineUnknown: false };
        } else if (this.turnStartHead !== null) {
          // Pin the clean old side so staging or committing mid-turn cannot replace it.
          const content = await Git.showRevision(this.cwd, this.turnStartHead, this.gitPrefix + file);
          const oldHash = content !== null ? await this.snapshotStore.put(content) : null;
          registered = { oldHash, baselineUnknown: false };
        } else {
          // Unborn repository (no commits): everything starts from nothing.
          registered = { oldHash: null, baselineUnknown: false };
        }
      } else if (opts.fromToolEvent) {
        // No git: only a pre-execution tool event can capture the old side.
        const content = await this.readFileOrNull(file);
        const oldHash = content !== null ? await this.snapshotStore.put(content) : null;
        registered = { oldHash, baselineUnknown: false };
      } else {
        registered = { oldHash: null, baselineUnknown: true };
      }
    } catch (error) {
      // A rejected directory target is not a changed file; other capture failures are explicit.
      if ((error as NodeJS.ErrnoException).code === "EISDIR") return;
      registered = { oldHash: null, baselineUnknown: true, unavailable: true };
    }
    // Parallel hooks may have registered the file while this capture awaited IO.
    if (!this.turnFiles.has(file)) this.turnFiles.set(file, registered);
  }

  private async readFileOrNull(file: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.cwd, file));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  }

  /**
   * Git workspace signature: porcelain entries with a sha256 of each dirty
   * file's disk content ("missing" when deleted). Two signatures differ for
   * any file whose status code or content changed between captures.
   */
  private async gitWorkspaceSignature(): Promise<string> {
    const signature: [string, string, string][] = [];
    for (const item of await this.workspaceStatus()) {
      let hash = "unreadable";
      try {
        const content = await this.readFileOrNull(item.file);
        hash = content !== null ? SnapshotStore.hash(content) : "missing";
      } catch { /* Keep the path in the signature even when unreadable. */ }
      signature.push([item.file, item.code, hash]);
    }
    return JSON.stringify({ head: await Git.headCommit(this.cwd), files: signature });
  }

  private async workspaceStatus() {
    return Git.parseStatus(await Git.statusPorcelain(this.cwd)).flatMap((item) =>
      item.file.startsWith(this.gitPrefix) ? [{ ...item, file: item.file.slice(this.gitPrefix.length) }] : [],
    );
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
    this.unavailableBaseline.clear();
    this.bashMarkers.clear();
    this.turnMarker = null;

    if (await this.isGit()) {
      this.turnStartHead = await Git.headCommit(this.cwd);
      const signature: [string, string, string][] = [];
      for (const item of await this.workspaceStatus()) {
        // Snapshot the turn-start content of dirty files so bash-modified
        // pre-dirty files keep a correct old side. Files already deleted on
        // disk have no turn-start content (a later recreation is "added").
        try {
          const content = await this.readFileOrNull(item.file);
          const hash = content !== null ? SnapshotStore.hash(content) : "missing";
          this.turnBaseline.set(item.file, content !== null ? await this.snapshotStore.put(content) : null);
          signature.push([item.file, item.code, hash]);
        } catch {
          signature.push([item.file, item.code, "unreadable"]);
          this.unavailableBaseline.add(item.file);
        }
      }
      this.turnMarker = JSON.stringify({ head: this.turnStartHead, files: signature });
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
    let changed: string[];
    try { changed = await this.scanWorkspace(marker); }
    finally { if (!(await this.isGit())) await this.releaseMarker(marker); }
    for (const file of changed) await this.recordFileChange(file);
  }

  /**
   * Called from agent_settled: finalize the turn. A turn-level catch-up scan
   * first picks up anything the tool events and bash scans missed (e.g. files
   * written by non-builtin tools); then per-file patches are computed and
   * persisted as one self-contained `pi-diff.turn` custom entry.
   */
  async finalizeTurn(): Promise<void> {
    const turnMarker = this.turnMarker;
    try {
      if (turnMarker !== null) {
        const missed = await this.scanWorkspace(turnMarker);
        for (const file of missed) await this.recordFileChange(file);
      }
    } finally {
      if (!(await this.isGit())) {
        if (turnMarker !== null) await this.releaseMarker(turnMarker);
        for (const marker of this.bashMarkers.values()) await this.releaseMarker(marker);
      }
      this.turnMarker = null;
      this.bashMarkers.clear();
    }

    const patches: FilePatch[] = [];
    let capped = false;
    let total = 0;
    for (const file of [...this.turnFiles.keys()].sort()) {
      const registered = this.turnFiles.get(file)!;
      let newContent: Buffer | null = null;
      let unavailable = registered.unavailable ?? false;
      try { newContent = await this.readFileOrNull(file); }
      catch { unavailable = true; }
      const newHash = newContent !== null ? SnapshotStore.hash(newContent) : null;
      // No-op registration (failed edit, touch without change): drop.
      if (!unavailable && registered.oldHash === newHash && !registered.baselineUnknown) continue;

      let patch: FilePatch;
      const status = registered.unavailable ? "modified"
        : registered.oldHash === null && !registered.baselineUnknown ? "added"
        : !unavailable && newContent === null ? "deleted" : "modified";
      if (unavailable || capped || (registered.baselineUnknown && newContent === null)) {
        // Once the total cap is hit, remaining files degrade (opencode totalPatch).
        patch = {
          file,
          status,
          patch: emptyPatch(file),
          additions: 0,
          deletions: 0,
          ...(capped ? { tooLarge: true } : {}),
          ...(unavailable ? { unavailable: true } : {}),
          ...(registered.baselineUnknown ? { baselineUnknown: true } : {}),
          oldHash: registered.oldHash,
          ...(unavailable ? {} : { newHash }),
        };
      } else {
        const oldContent =
          registered.oldHash !== null ? await this.snapshotStore.get(registered.oldHash) : null;
        patch = registered.oldHash !== null && oldContent === null ? {
          file, status, patch: emptyPatch(file), additions: 0, deletions: 0,
          unavailable: true, oldHash: registered.oldHash, newHash,
        } : makeFilePatch(file, oldContent, newContent, {
          oldHash: registered.oldHash,
          newHash,
          baselineUnknown: registered.baselineUnknown,
        });
        // Cache the new side for the session-cumulative recompute.
        if (newContent !== null && !patch.binary && !patch.tooLarge) {
          await this.snapshotStore.put(newContent).catch(() => {});
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
    this.unavailableBaseline.clear();

    // Empty turns still carry their number so reload and Last turn remain accurate.
    if (this.turnNumber === 0) return;

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
    let total = 0;
    let capped = false;
    const append = (patch: FilePatch) => {
      const bytes = Buffer.byteLength(patch.patch);
      if (capped || total + bytes > MAX_TOTAL_PATCH_BYTES) {
        capped = true;
        result.push({ ...patch, patch: emptyPatch(patch.file), tooLarge: true });
      } else {
        total += bytes;
        result.push(patch);
      }
    };
    for (const file of [...first.keys()].sort()) {
      const f = first.get(file)!;
      const l = last.get(file)!;
      const oldHash = f.oldHash;
      const newHash = l.newHash;
      if (!f.baselineUnknown && oldHash !== undefined && oldHash === newHash) continue;
      // One recorded change is already a self-contained cumulative patch.
      if (f === l) {
        append(l);
        continue;
      }
      if (f.baselineUnknown || f.binary || l.binary || f.tooLarge || l.tooLarge || f.unavailable || l.unavailable || oldHash === undefined || newHash === undefined) {
        append({ ...l, cumulativeFallback: true });
        continue;
      }
      const oldContent =
        oldHash !== null ? await this.snapshotStore.get(oldHash) : null;
      const newContent = newHash !== null ? await this.snapshotStore.get(newHash) : null;
      if ((oldHash !== null && oldContent === null) || (newHash !== null && newContent === null)) {
        // Cache miss (evicted / old session): degrade to the last turn patch.
        append({ ...l, cumulativeFallback: true });
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
      append(recomputed);
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
    this.unavailableBaseline.clear();
    this.bashMarkers.clear();
    this.turnMarker = null;
  }

  async cleanupCaches(): Promise<void> {
    await this.snapshotStore.cleanup();
  }

  private async isGit(): Promise<boolean> {
    if (this.git === null) {
      this.git = await Git.isAvailable(this.cwd);
      if (this.git) this.gitPrefix = await Git.prefix(this.cwd);
    }
    return this.git;
  }
}
