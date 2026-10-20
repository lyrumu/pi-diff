/** Stage 4 adversarial checks; all filesystem fixtures live in temporary directories. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { Type } from "typebox";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { executeCodemode } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js";
import { collectTurnDiffs, CUSTOM_TYPE } from "../src/store.ts";
import { SnapshotStore } from "../src/snapshot.ts";
import { Tracker } from "../src/tracker.ts";
import { Git } from "../src/git.ts";
import { MAX_PATCH_BYTES, MAX_TOTAL_PATCH_BYTES } from "../src/diff-engine.ts";
import { loadViewPreference, saveViewPreference, loadLanguagePreference, saveLanguagePreference } from "../src/preferences.ts";

const exec = promisify(execFile);

async function workspace(fn: (dir: string, git: (...args: string[]) => Promise<void>) => Promise<void>, repo = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-reliability-"));
  const dir = join(root, "workspace");
  await mkdir(dir);
  const previous = process.cwd();
  process.chdir(dir);
  const git = async (...args: string[]) => { await exec("git", args, { cwd: dir }); };
  try {
    if (repo) {
      await git("init", "-q", "-b", "main");
      await git("config", "user.email", "test@example.invalid");
      await git("config", "user.name", "test");
      await writeFile("x", "base\n");
      await git("add", "-A");
      await git("commit", "-qm", "base");
    }
    await fn(dir, git);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
}

const tracker = (dir: string, appendEntry: (type: string, data: unknown) => void = () => {}) =>
  new Tracker({ appendEntry } as never, new SnapshotStore(join(dir, "..", "snapshots")));

async function edit(t: Tracker, file: string, content: string | null) {
  await t.onTurnStart();
  await t.recordFileChange(file, { fromToolEvent: true });
  if (content === null) await rm(file);
  else await writeFile(file, content);
  await t.finalizeTurn();
}

test("cumulative patches cover create/edit/delete/recreate and preserve the first old side", async () => {
  await workspace(async (dir) => {
    const added = tracker(dir);
    await edit(added, "added", "one\n");
    await edit(added, "added", "one\ntwo\n");
    const [creation] = await added.sessionPatches();
    assert.equal(creation!.status, "added");
    assert.equal(creation!.additions, 2);
    assert.match(creation!.patch, /\+one\n\+two/);
    await edit(added, "added", null);
    assert.deepEqual(await added.sessionPatches(), []);

    await writeFile("original", "initial\n");
    const deleted = tracker(dir);
    await edit(deleted, "original", "initial\nagent-added\n");
    await edit(deleted, "original", null);
    const [deletion] = await deleted.sessionPatches();
    assert.equal(deletion!.status, "deleted");
    assert.equal(deletion!.deletions, 1);
    assert.match(deletion!.patch, /-initial/);
    assert.ok(!deletion!.patch.includes("agent-added"));
    await edit(deleted, "original", "replacement\n");
    const [replacement] = await deleted.sessionPatches();
    assert.equal(replacement!.status, "modified");
    assert.match(replacement!.patch, /-initial\n\+replacement/);

    await writeFile("reverted", "old\n");
    const reverted = tracker(dir);
    await edit(reverted, "reverted", "other\n");
    await edit(reverted, "reverted", "old\n");
    assert.deepEqual(await reverted.sessionPatches(), []);
  });
});

test("no-git shell deletions, net-zero failed writes and literal backslash paths are honest", async () => {
  await workspace(async (dir) => {
    await writeFile("deleted", "old\n");
    const deleted = tracker(dir);
    await deleted.onTurnStart();
    await deleted.onBashStart("bash");
    await rm("deleted");
    await deleted.onBashEnd("bash");
    await deleted.finalizeTurn();
    const [patch] = deleted.turns()[0]!.patches;
    assert.equal(patch!.status, "deleted");
    assert.equal(patch!.baselineUnknown, true);
    assert.equal((await deleted.sessionPatches()).length, 1, "unknown old side must not be dropped as net-zero");

    const failed = tracker(dir);
    await failed.onTurnStart();
    await failed.recordFileChange("never-created", { fromToolEvent: true });
    await failed.finalizeTurn();
    assert.equal(failed.turns().length, 1);
    assert.deepEqual(failed.turns()[0]!.patches, []);

    const copied = tracker(dir);
    await copied.onTurnStart();
    await writeFile("copied-with-old-mtime", "copy\n");
    const oldTime = new Date(0);
    await utimes("copied-with-old-mtime", oldTime, oldTime);
    await copied.finalizeTurn();
    assert.match(copied.turns()[0]!.patches[0]!.patch, /\+copy/);

    if (process.platform !== "win32") {
      const literal = tracker(dir);
      await edit(literal, "back\\slash", "content\n");
      assert.equal(literal.turns()[0]!.patches[0]!.file, "back\\slash");
      assert.match(literal.turns()[0]!.patches[0]!.patch, /\+content/);
    }
  });
});

test("Git scans detect a dirty path becoming clean and changes committed inside bash", async () => {
  await workspace(async (dir, git) => {
    await writeFile("x", "user dirty\n");
    const restored = tracker(dir);
    await restored.onTurnStart();
    await restored.onBashStart("restore");
    await writeFile("x", "base\n");
    await restored.onBashEnd("restore");
    await restored.finalizeTurn();
    assert.match(restored.turns()[0]!.patches[0]!.patch, /-user dirty\n\+base/);

    const committed = tracker(dir);
    await committed.onTurnStart();
    await committed.onBashStart("commit");
    await writeFile("x", "committed during bash\n");
    await git("add", "-A");
    await git("commit", "-qm", "during bash");
    await committed.onBashEnd("commit");
    await committed.finalizeTurn();
    assert.match(committed.turns()[0]!.patches.find((p) => p.file === "x")!.patch, /-base\n\+committed during bash/);
    assert.deepEqual(await Git.changedCommitFiles(dir, "--help", null), []);

    await rm("x");
    const recreated = tracker(dir);
    await edit(recreated, "x", "recreated\n");
    const creation = recreated.turns()[0]!.patches[0]!;
    assert.equal(creation.status, "added", "a pre-deleted path starts from known absence");
    assert.equal(creation.oldHash, null);
    assert.match(creation.patch, /\+recreated/);
    assert.ok(!creation.patch.includes("committed during bash"));
  }, true);
});

test("parallel file registrations cannot overwrite the first captured baseline", async () => {
  await workspace(async (dir) => {
    await writeFile("x", "before\n");
    const t = tracker(dir);
    await t.onTurnStart();
    const put = t.snapshotStore.put.bind(t.snapshotStore);
    let firstReady!: () => void;
    let secondReady!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const readyFirst = new Promise<void>((resolve) => { firstReady = resolve; });
    const readySecond = new Promise<void>((resolve) => { secondReady = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    t.snapshotStore.put = async (content) => {
      if (content.toString() === "before\n") { firstReady(); await firstGate; }
      if (content.toString() === "middle\n") { secondReady(); await secondGate; }
      return put(content);
    };
    const first = t.recordFileChange("x", { fromToolEvent: true });
    await readyFirst;
    await writeFile("x", "middle\n");
    const second = t.recordFileChange("x", { fromToolEvent: true });
    await readySecond;
    releaseFirst();
    await first;
    releaseSecond();
    await second;
    await writeFile("x", "after\n");
    await t.finalizeTurn();
    assert.equal(t.turns()[0]!.patches.length, 1);
    assert.match(t.turns()[0]!.patches[0]!.patch, /-before\n\+after/);
  });
});

test("explicit tools capture ignored Git files before execution without changing the index", async () => {
  await workspace(async (dir, git) => {
    await writeFile(".gitignore", "ignored*\n");
    await git("add", ".gitignore");
    await git("commit", "-qm", "ignore fixture");
    await writeFile("ignored.txt", "existing\n");
    const index = await readFile(".git/index");
    const t = tracker(dir);
    await edit(t, "ignored.txt", "updated\n");
    const patch = t.turns()[0]!.patches[0]!;
    assert.equal(patch.status, "modified");
    assert.equal(patch.baselineUnknown, undefined);
    assert.match(patch.patch, /-existing\n\+updated/);
    await edit(t, "ignored.txt", "updated\n");
    assert.deepEqual(t.turns()[1]!.patches, [], "failed/no-op tools must not invent an addition");
    await edit(t, "ignored-new.txt", "created\n");
    assert.equal(t.turns()[2]!.patches[0]!.status, "added");
    assert.deepEqual(await readFile(".git/index"), index);
    assert.deepEqual(await Git.diff(dir, "working"), [], "Git scopes still honor ignore rules");
  }, true);
  await workspace(async (dir, git) => {
    await git("init", "-q", "-b", "main");
    await writeFile(".gitignore", "ignored.txt\n");
    await writeFile("ignored.txt", "before first commit\n");
    const t = tracker(dir);
    await edit(t, "ignored.txt", "updated\n");
    assert.equal(t.turns()[0]!.patches[0]!.status, "modified");
    assert.match(t.turns()[0]!.patches[0]!.patch, /-before first commit\n\+updated/);
  });
});

test("no-Git scans detect same-size rewrites and replacements with preserved mtimes", async () => {
  await workspace(async (dir) => {
    for (const replace of [false, true]) {
      await writeFile("x", "before\n");
      await utimes("x", new Date(0), new Date(0));
      const t = tracker(dir);
      await t.onTurnStart();
      await t.onBashStart("preserve-time");
      if (replace) await rm("x");
      await writeFile("x", "after!\n");
      await utimes("x", new Date(0), new Date(0));
      await t.onBashEnd("preserve-time");
      await t.finalizeTurn();
      assert.deepEqual(t.turns()[0]!.patches.map((p) => p.file), ["x"]);
      assert.equal(t.turns()[0]!.patches[0]!.baselineUnknown, true);
      assert.match(t.turns()[0]!.patches[0]!.patch, /\+after!/);
    }
  });
});

test("failed scans release shell, turn and aborted-call temporary markers", async () => {
  await workspace(async (dir) => {
    const t = tracker(dir);
    const markers: string[] = [];
    const makeMarker = t.makeMarker.bind(t);
    t.makeMarker = async () => {
      const marker = await makeMarker();
      markers.push(marker);
      return marker;
    };
    await t.onTurnStart();
    await t.onBashStart("failed");
    await t.onBashStart("aborted");
    t.scanWorkspace = async () => { throw new Error("scan failed"); };
    await assert.rejects(t.onBashEnd("failed"), /scan failed/);
    await assert.rejects(readFile(markers[1]!), { code: "ENOENT" });
    await assert.rejects(t.finalizeTurn(), /scan failed/);
    for (const marker of markers) await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
});

test("read/capture failures never masquerade as deletions or empty successful changes", async () => {
  await workspace(async (dir) => {
    await writeFile("x", "before\n");
    const t = tracker(dir);
    await t.onTurnStart();
    await t.recordFileChange("x", { fromToolEvent: true });
    await rm("x");
    await mkdir("x"); // EISDIR is a deterministic unreadable new side on every platform.
    await t.finalizeTurn();
    const [unreadable] = t.turns()[0]!.patches;
    assert.equal(unreadable!.status, "modified");
    assert.equal(unreadable!.unavailable, true);
    assert.equal(unreadable!.newHash, undefined);
    await rm("x", { recursive: true });
    await writeFile("x", "before\n");

    const captureFailure = tracker(dir);
    captureFailure.snapshotStore.put = async () => { throw new Error("cache is read-only"); };
    await edit(captureFailure, "x", "after\n");
    assert.equal(captureFailure.turns()[0]!.patches[0]!.unavailable, true);

    const directory = tracker(dir);
    await mkdir("directory");
    await directory.onTurnStart();
    await directory.recordFileChange("directory", { fromToolEvent: true });
    await directory.finalizeTurn();
    assert.equal(directory.turns().length, 1);
    assert.deepEqual(directory.turns()[0]!.patches, []);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const permissions = tracker(dir);
      await permissions.onTurnStart();
      await permissions.recordFileChange("x", { fromToolEvent: true });
      await chmod("x", 0);
      try {
        await permissions.finalizeTurn();
        assert.equal(permissions.turns()[0]!.patches[0]!.unavailable, true);
      } finally { await chmod("x", 0o600); }
    }
  });
});

test("starting pi in a Git subdirectory preserves dirty and committed old sides", async () => {
  await workspace(async (dir, git) => {
    await mkdir("sub");
    await writeFile("sub/x", "committed\n");
    await writeFile("sub/y", "clean\n");
    await git("add", "-A");
    await git("commit", "-qm", "subdirectory");
    process.chdir(join(dir, "sub"));
    await writeFile("x", "user dirty\n");
    const t = tracker(dir);
    await t.onTurnStart();
    await t.recordFileChange("x", { fromToolEvent: true });
    await writeFile("x", "agent\n");
    await t.onBashStart("bash");
    await writeFile("y", "changed\n");
    await t.onBashEnd("bash");
    await t.finalizeTurn();
    const files = t.turns()[0]!.patches;
    assert.deepEqual(files.map((patch) => patch.file), ["x", "y"]);
    assert.match(files[0]!.patch, /-user dirty\n\+agent/);
    assert.match(files[1]!.patch, /-clean\n\+changed/);
  }, true);
});

test("cache misses retain per-turn history and explicitly label incomplete cumulative patches", async () => {
  await workspace(async (dir) => {
    const t = tracker(dir);
    await writeFile("x", "before\n");
    await edit(t, "x", "middle\n");
    await edit(t, "x", "after\n");
    await rm(join(dir, "..", "snapshots"), { recursive: true });
    const restored = tracker(dir);
    restored.restoreFromSession({ getBranch: () => t.turns().map((data) => ({ type: "custom", customType: CUSTOM_TYPE, data })) } as never);
    assert.equal(restored.turns().length, 2);
    const [fallback] = await restored.sessionPatches();
    assert.equal(fallback!.cumulativeFallback, true);
    assert.match(fallback!.patch, /-middle\n\+after/);
  });
});

test("corrupt entries and invalid hash hints are rejected at their trust boundaries", async () => {
  await workspace(async (dir) => {
    const valid = { turn: 1, endedAt: "2026-10-14T00:00:00Z", fileCount: 1, patches: [{ file: "x", patch: "", status: "modified", additions: 0, deletions: 0 }] };
    const wrap = (data: unknown) => ({ type: "custom", customType: CUSTOM_TYPE, data });
    const invalid = [
      { ...valid, turn: NaN }, { ...valid, turn: -1 }, { ...valid, endedAt: "broken" },
      { ...valid, fileCount: 99 },
      ...[{ status: "invalid" }, { additions: Infinity }, { deletions: -1 }, { oldHash: "../../outside" }, { tooLarge: "true" }].map((change) => ({ ...valid, patches: [{ ...valid.patches[0], ...change }] })),
    ];
    assert.equal(collectTurnDiffs([wrap(valid), ...invalid.map(wrap)] as never).length, 1);
    const cache = new SnapshotStore(join(dir, "cache"));
    assert.equal(await cache.get("../../outside"), null);
    assert.equal(await cache.get("z".repeat(64)), null);
  });
});

test("snapshot writes are atomic, verify contents and only prune genuinely stale objects", async () => {
  await workspace(async (dir) => {
    const root = join(dir, "cache");
    const cache = new SnapshotStore(root);
    const content = Buffer.from("concurrent snapshot\n");
    const hashes = await Promise.all(Array.from({ length: 8 }, () => cache.put(content)));
    assert.ok(hashes.every((hash) => hash === hashes[0]));
    assert.deepEqual(await cache.get(hashes[0]!), content);
    const file = join(root, "objects", hashes[0]!.slice(0, 2), hashes[0]!.slice(2));
    await writeFile(file, "corrupt");
    assert.equal(await cache.get(hashes[0]!), null);
    const old = new Date(Date.now() - 31 * 86400000);
    await utimes(file, old, old);
    const fresh = await cache.put(Buffer.from("fresh\n"));
    await cache.cleanup();
    assert.equal(await cache.get(hashes[0]!), null);
    assert.deepEqual(await cache.get(fresh), Buffer.from("fresh\n"));
    const shards = await readdir(join(root, "objects"));
    for (const shard of shards) assert.ok((await readdir(join(root, "objects", shard))).every((name) => !name.endsWith(".tmp")));
  });
});

test("layout preference survives reopen, invalid data defaults safely and failed replacement preserves it", async () => {
  await workspace(async (dir) => {
    const file = join(dir, "prefs", "view.json");
    assert.equal(await loadViewPreference(file), undefined);
    await saveViewPreference(file, "unified");
    assert.equal(await loadViewPreference(file), "unified");
    await saveViewPreference(file, "split");
    assert.equal(await loadViewPreference(file), "split");
    await writeFile(file, '{"view":"broken"}');
    assert.equal(await loadViewPreference(file), undefined);
    await saveViewPreference(file, "unified");
    const previous = await readFile(file, "utf8");
    await mkdir(join(dir, "target-directory"));
    await assert.rejects(saveViewPreference(join(dir, "target-directory"), "split"));
    assert.equal(await readFile(file, "utf8"), previous);
    assert.ok((await readdir(dir)).every((name) => !name.endsWith(".tmp")));
  });
});

test("language preference defaults to English and persists atomically without changing layout", async () => {
  await workspace(async (dir) => {
    const file = join(dir, "prefs", "language.json");
    const view = join(dir, "prefs", "view.json");
    assert.equal(await loadLanguagePreference(file), "en");
    await saveViewPreference(view, "split");
    await saveLanguagePreference(file, "zh-CN");
    assert.equal(await loadLanguagePreference(file), "zh-CN");
    assert.equal(await loadViewPreference(view), "split");
    await saveLanguagePreference(file, "en");
    assert.equal(await loadLanguagePreference(file), "en");
    for (const invalid of ['{', 'null', '[]', '{}', '"zh-CN"', '{"language":"zh"}', '{"language":123}']) {
      await writeFile(file, invalid);
      assert.equal(await loadLanguagePreference(file), "en");
    }
    await saveLanguagePreference(file, "zh-CN");
    const previous = await readFile(file, "utf8");
    await mkdir(join(dir, "prefs", "target-directory"));
    await assert.rejects(saveLanguagePreference(join(dir, "prefs", "target-directory"), "en"));
    assert.equal(await readFile(file, "utf8"), previous);
    assert.equal(await loadViewPreference(view), "split");
    assert.ok((await readdir(join(dir, "prefs"))).every((name) => !name.endsWith(".tmp")));
  });
});

test("real session JSONL restart and tree branch replay retain patches and next turn numbers", async () => {
  await workspace(async (dir) => {
    const manager = SessionManager.create(dir, join(dir, ".cache", "sessions"));
    manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
    const root = manager.getLeafId()!;
    const t = tracker(dir, (type, data) => { manager.appendCustomEntry(type, data); });
    await edit(t, "first", "A\n");
    const branchA = manager.getLeafId()!;
    const resumedManager = SessionManager.open(manager.getSessionFile()!);
    const resumed = tracker(dir, (type, data) => { resumedManager.appendCustomEntry(type, data); });
    resumed.restoreFromSession(resumedManager);
    assert.deepEqual(resumed.turns(), t.turns());
    resumedManager.branch(root);
    resumed.restoreFromSession(resumedManager);
    assert.deepEqual(resumed.turns(), []);
    await edit(resumed, "second", "B\n");
    assert.equal(resumed.turns()[0]!.turn, 1);
    assert.deepEqual(resumed.turns()[0]!.patches.map((p) => p.file), ["second"]);
    resumedManager.branch(branchA);
    resumed.restoreFromSession(resumedManager);
    assert.deepEqual(resumed.turns()[0]!.patches.map((p) => p.file), ["first"]);
    await edit(resumed, "first", "A2\n");
    assert.equal(resumed.turns()[1]!.turn, 2);
    const again = SessionManager.open(resumedManager.getSessionFile()!);
    assert.deepEqual(collectTurnDiffs(again.getBranch()).map((turn) => turn.turn), [1, 2]);
    await resumed.onTurnStart();
    await resumed.finalizeTurn();
    assert.equal(resumed.turns().at(-1)!.turn, 3);
    assert.deepEqual(resumed.turns().at(-1)!.patches, []);
    const afterEmpty = tracker(dir);
    afterEmpty.restoreFromSession(SessionManager.open(resumedManager.getSessionFile()!));
    await afterEmpty.onTurnStart();
    await afterEmpty.finalizeTurn();
    assert.equal(afterEmpty.turns().at(-1)!.turn, 4, "empty turns survive reload without reused numbers");
  });
});

test("real codemode delegates to a child writer; the turn scan catches both Git and no-Git changes", async () => {
  for (const repo of [false, true]) await workspace(async (dir) => {
    const t = tracker(dir);
    await t.onTurnStart();
    const writer = { name: "spawn", label: "Spawn local writer", description: "Write a fixture in a child process", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) };
    const result = await executeCodemode("codemode-1", { code: "text(await tools.spawn({}));" }, undefined, undefined, {
      tools: [writer], sessionManager: { getBranch: () => [] },
      executeTool: async () => {
        await exec(process.execPath, ["-e", "require('node:fs').writeFileSync('child.txt', 'child write\\n')"], { cwd: dir });
        return { toolCall: { id: "codemode-1/1", name: "spawn", arguments: {} }, result: { content: [{ type: "text", text: "written" }], details: {} }, isError: false };
      },
    } as never);
    assert.equal(result.isError, undefined);
    await t.finalizeTurn();
    const child = t.turns()[0]!.patches.find((patch) => patch.file === "child.txt")!;
    assert.match(child.patch, /\+child write/);
    assert.equal(child.baselineUnknown, repo ? undefined : true);
    assert.equal(result.details.calls[0]!.name, "spawn");
  }, repo);
});

test("aggregate session and per-turn binary/large budgets degrade without losing statuses", async () => {
  await workspace(async (dir) => {
    const t = tracker(dir);
    await edit(t, "binary", "a\0b");
    assert.equal(t.turns()[0]!.patches[0]!.binary, true);
    await edit(t, "oversized", "x".repeat(MAX_PATCH_BYTES + 1));
    assert.equal(t.turns()[1]!.patches[0]!.tooLarge, true);
    const line = "x".repeat(998) + "\n";
    const capped = tracker(dir);
    await edit(capped, "a", line.repeat(6000));
    await edit(capped, "b", line.repeat(6000));
    const session = await capped.sessionPatches();
    assert.equal(session[0]!.status, "added");
    assert.equal(session[1]!.tooLarge, true);
    assert.equal(session[1]!.status, "added");
    assert.ok(session.filter((patch) => !patch.tooLarge).reduce((bytes, patch) => bytes + Buffer.byteLength(patch.patch), 0) <= MAX_TOTAL_PATCH_BYTES);
  });
});
