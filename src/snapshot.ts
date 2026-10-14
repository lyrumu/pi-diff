import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Content-addressed snapshot cache under ~/.pi/agent/data/pi-diff/.
 *
 * Ported from opencode `packages/core/src/snapshot.ts` with the storage base
 * swapped (PLAN.md deviations): upstream keeps git snapshot trees in a data
 * directory; we store raw file blobs keyed by sha256. Patches are persisted
 * self-contained in the session JSONL (see store.ts); this cache only
 * accelerates incremental patch computation (turn old/new sides and the
 * session-cumulative recompute). Losing it never breaks `/diff` — consumers
 * fall back to the persisted per-turn patch texts.
 *
 * Cleanup: 30-day LRU by access time at session start. Note some filesystems
 * are mounted noatime (common on macOS); we fall back to mtime there.
 */
export class SnapshotStore {
  private readonly root = join(homedir(), ".pi", "agent", "data", "pi-diff");

  static hash(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /** Store content; returns its content hash (sha256). Idempotent. */
  async put(content: Buffer): Promise<string> {
    const hash = SnapshotStore.hash(content);
    const file = this.objectPath(hash);
    try {
      await stat(file);
      return hash; // already stored — keep the original (older) timestamps
    } catch {
      // not stored yet
    }
    await mkdir(this.shard(hash), { recursive: true });
    await writeFile(file, content);
    return hash;
  }

  /** Fetch content by hash; null when unknown or unreadable. Refreshes atime. */
  async get(hash: string): Promise<Buffer | null> {
    const file = this.objectPath(hash);
    try {
      const content = await readFile(file);
      // Best-effort atime refresh for the LRU (harmless if it fails).
      await utimes(file, new Date(), new Date()).catch(() => {});
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Remove objects not accessed for `maxAgeDays` days. Objects are stored in
   * shard dirs (objects/ab/cdef...); empty shards are removed too.
   */
  async cleanup(maxAgeDays = 30): Promise<void> {
    const objectsDir = join(this.root, "objects");
    let shards: string[];
    try {
      shards = await readdir(objectsDir);
    } catch {
      return; // nothing cached yet
    }
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const shard of shards) {
      const shardDir = join(objectsDir, shard);
      let entries: string[];
      try {
        entries = await readdir(shardDir);
      } catch {
        continue;
      }
      let remaining = 0;
      for (const entry of entries) {
        const file = join(shardDir, entry);
        try {
          const s = await stat(file);
          const lastUse = Math.max(s.atimeMs, s.mtimeMs);
          if (lastUse < cutoff) await unlink(file);
          else remaining++;
        } catch {
          continue;
        }
      }
      if (remaining === 0) await rm(shardDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private objectPath(hash: string): string {
    return join(this.shard(hash), hash.slice(2));
  }

  private shard(hash: string): string {
    return join(this.root, "objects", hash.slice(0, 2));
  }
}
