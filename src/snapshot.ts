import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Content-addressed snapshot cache under ~/.pi/agent/data/pi-diff/.
 *
 * Patches are persisted self-contained in the session JSONL (see store.ts);
 * this cache only accelerates incremental patch computation. Losing it never
 * breaks `/diff`. Cleanup: 30-day atime LRU at session start.
 */
export class SnapshotStore {
  private readonly root = join(homedir(), ".pi", "agent", "data", "pi-diff");

  /** Store content; returns its content hash (sha256). Idempotent. */
  async put(content: string): Promise<string> {
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    await mkdir(this.shard(hash), { recursive: true });
    await writeFile(this.objectPath(hash), content, "utf8");
    return hash;
  }

  async get(hash: string): Promise<string | null> {
    return readFile(this.objectPath(hash), "utf8").catch(() => null);
  }

  /** Remove shards whose objects were not accessed for 30 days. */
  async cleanup(maxAgeDays = 30): Promise<void> {
    // TODO: walk root, stat atime, rm -rf old shard dirs.
    void readdir;
    void stat;
    void rm;
    void maxAgeDays;
  }

  private objectPath(hash: string): string {
    return join(this.shard(hash), hash.slice(2));
  }

  private shard(hash: string): string {
    return join(this.root, "objects", hash.slice(0, 2));
  }
}
