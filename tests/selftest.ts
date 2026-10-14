/**
 * Phase 1 self-test (PLAN.md 1.5). Run: node tests/selftest.ts
 *
 * Simulates the pi event sequence against a Tracker instance in temp
 * directories (git and no-git), checks the single-entry-point invariant and
 * compares patches with git semantics. No real pi runtime involved — the
 * ExtensionAPI is stubbed with an in-memory appendEntry.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Tracker } from "../src/tracker.ts";
import { collectTurnDiffs, CUSTOM_TYPE, appendTurnDiff } from "../src/store.ts";
import { countPatch } from "../src/diff-engine.ts";

const exec = promisify(execFile);
let failures = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(err);
  }
}

function makeTracker() {
  const entries: { customType: string; data?: unknown }[] = [];
  const pi = {
    appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
  };
  return { tracker: new Tracker(pi as never), entries };
}

async function git(cwd: string, ...args: string[]) {
  await exec("git", args, { cwd });
}

// ---------------------------------------------------------------- git scenario
await test("git: edit/write/bash changes land in one turn diff (3 files)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-test-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await writeFile("a.txt", "line1\nline2\nline3\n");
    await writeFile("b.txt", "keep\n");
    await writeFile("dirty.txt", "old dirty\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");
    await writeFile("dirty.txt", "user's uncommitted change\n"); // pre-turn dirty
    await writeFile("untracked.txt", "untracked old\n"); // pre-turn untracked

    const { tracker } = makeTracker();
    await tracker.onTurnStart();

    // Simulate edit tool on a.txt (tool_call pre-execution, then the edit runs).
    await tracker.recordFileChange("a.txt", { fromToolEvent: true });
    await writeFile("a.txt", "line1\nCHANGED\nline3\nline4\n");
    // Simulate write tool creating new.txt.
    await tracker.recordFileChange("new.txt", { fromToolEvent: true });
    await writeFile("new.txt", "brand new\n");
    // Simulate bash: sed b.txt (bash-detected, b.txt was clean at turn start).
    await tracker.onBashStart("call-1");
    await exec("sed", ["-i", "", "s/keep/KEPT/", "b.txt"]);
    await tracker.onBashEnd("call-1");

    await tracker.finalizeTurn();
    const turns = tracker.turns();
    assert.equal(turns.length, 1);
    const files = turns[0]!.patches.map((p) => p.file).sort();
    // Exactly the three touched files; pre-dirty dirty.txt / untracked.txt excluded.
    assert.deepEqual(files, ["a.txt", "b.txt", "new.txt"]);

    const a = turns[0]!.patches.find((p) => p.file === "a.txt")!;
    assert.equal(a.status, "modified");
    assert.deepEqual({ additions: a.additions, deletions: a.deletions }, { additions: 2, deletions: 1 });
    // Old side must be the turn-start content, not the post-edit disk state.
    assert.ok(a.patch.includes("-line2"), "patch removes the old line");
    assert.ok(a.patch.includes("+CHANGED"), "patch adds the new line");

    const b = turns[0]!.patches.find((p) => p.file === "b.txt")!;
    assert.equal(b.status, "modified");
    assert.equal(b.baselineUnknown, undefined, "git bash changes recover the old side");
    assert.ok(b.patch.includes("-keep"));
    assert.ok(b.patch.includes("+KEPT"));

    const n = turns[0]!.patches.find((p) => p.file === "new.txt")!;
    assert.equal(n.status, "added");

    // Cross-check a.txt + b.txt against git (index vs worktree).
    const gd = await exec("git", ["diff", "--", "a.txt", "b.txt"], { cwd: dir });
    assert.deepEqual(
      countPatch(gd.stdout),
      { additions: a.additions + b.additions, deletions: a.deletions + b.deletions },
      "counts match git diff",
    );
  } finally {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

await test("git: bash staging (git add) mid-turn keeps the correct old side", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-test-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await writeFile("c.txt", "v1\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");

    const { tracker } = makeTracker();
    await tracker.onTurnStart();
    await tracker.onBashStart("call-1");
    // bash: modify AND stage the file
    await writeFile("c.txt", "v1\nv2-staged\n");
    await git(dir, "add", "c.txt");
    await tracker.onBashEnd("call-1");
    await tracker.finalizeTurn();

    const [fp] = tracker.turns()[0]!.patches;
    assert.equal(fp.file, "c.txt");
    // Old side must be the turn-start (HEAD) content, not the staged content.
    assert.ok(fp.patch.includes("+v2-staged"), "bash change is visible");
    assert.equal(fp.additions, 1);
    assert.equal(fp.deletions, 0);
  } finally {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

await test("git: bash-modified pre-dirty file uses the turn-start snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-test-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await writeFile("d.txt", "committed\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");
    await writeFile("d.txt", "user dirty\n"); // pre-turn uncommitted change

    const { tracker } = makeTracker();
    await tracker.onTurnStart();
    await tracker.onBashStart("call-1");
    await exec("sed", ["-i", "", "s/user dirty/agent edit/", "d.txt"]);
    await tracker.onBashEnd("call-1");
    await tracker.finalizeTurn();

    const [fp] = tracker.turns()[0]!.patches;
    // Old side = "user dirty" (turn start), not "committed" (HEAD).
    assert.ok(fp.patch.includes("-user dirty"), "old side is the turn-start snapshot");
    assert.ok(fp.patch.includes("+agent edit"));
  } finally {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

await test("git: session cumulative across two turns (first old → last new)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-test-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await writeFile("s.txt", "one\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");

    const { tracker } = makeTracker();
    await tracker.onTurnStart();
    await tracker.recordFileChange("s.txt", { fromToolEvent: true });
    await writeFile("s.txt", "one\ntwo\n");
    await tracker.finalizeTurn();

    await tracker.onTurnStart();
    await tracker.recordFileChange("s.txt", { fromToolEvent: true });
    await writeFile("s.txt", "two\nthree\n");
    await tracker.finalizeTurn();

    const session = await tracker.sessionPatches();
    assert.equal(session.length, 1);
    const [fp] = session;
    assert.equal(fp.file, "s.txt");
    assert.ok(fp.patch.includes("-one"), "session diff starts from turn-1 old side");
    assert.ok(fp.patch.includes("+three"), "session diff ends at the latest content");
    assert.deepEqual({ additions: fp.additions, deletions: fp.deletions }, { additions: 2, deletions: 1 });
  } finally {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

await test("git: file created then reverted in-session is dropped from session view", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-test-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await writeFile("base.txt", "x\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "init");

    const { tracker } = makeTracker();
    await tracker.onTurnStart();
    await tracker.recordFileChange("temp.txt", { fromToolEvent: true });
    await writeFile("temp.txt", "temp\n");
    await tracker.finalizeTurn();

    await tracker.onTurnStart();
    await tracker.recordFileChange("temp.txt", { fromToolEvent: true });
    await exec("rm", ["temp.txt"]);
    await tracker.finalizeTurn();

    const session = await tracker.sessionPatches();
    assert.equal(session.length, 0, "net-zero file disappears from the session view");
    // Turn 2 had a real change (the deletion), so both turns are persisted.
    assert.equal(tracker.turns().length, 2);
  } finally {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- no-git scenario
await test("no-git: edit known old side; bash change is baselineUnknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-nogit-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await writeFile("x.txt", "orig\n");
    const { tracker } = makeTracker();
    await tracker.onTurnStart();
    // edit tool
    await tracker.recordFileChange("x.txt", { fromToolEvent: true });
    await writeFile("x.txt", "orig\nnew\n");
    // bash creates + modifies files
    await tracker.onBashStart("call-1");
    await writeFile("bashmade.txt", "from bash\n");
    await exec("sed", ["-i", "", "s/orig/EDIT/", "x.txt"]); // bash also touches x.txt (already registered)
    await tracker.onBashEnd("call-1");
    await tracker.finalizeTurn();

    const files = tracker.turns()[0]!.patches.map((p) => p.file).sort();
    assert.deepEqual(files, ["bashmade.txt", "x.txt"]);
    const x = tracker.turns()[0]!.patches.find((p) => p.file === "x.txt")!;
    assert.equal(x.baselineUnknown, undefined, "tool-event files keep their old side");
    assert.ok(x.patch.includes("-orig"));
    const made = tracker.turns()[0]!.patches.find((p) => p.file === "bashmade.txt")!;
    assert.equal(made.baselineUnknown, true, "bash-created file has an unknown baseline");
    assert.equal(made.status, "added");
  } finally {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- restore
await test("store: appendEntry shape + collectTurnDiffs round-trip", async () => {
  const entries: { type: string; customType: string; data?: unknown }[] = [];
  const data = {
    turn: 3,
    endedAt: new Date().toISOString(),
    fileCount: 1,
    patches: [
      { file: "a.txt", status: "modified", patch: "x", additions: 1, deletions: 0 },
    ],
  };
  appendTurnDiff((customType, d) => entries.push({ type: "custom", customType, data: d }), data);
  assert.equal(entries[0]!.customType, CUSTOM_TYPE);
  const restored = collectTurnDiffs(entries as never);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.turn, 3);
  // Corrupted entries are skipped, not fatal.
  const bad = collectTurnDiffs([
    { type: "custom", customType: CUSTOM_TYPE, data: { turn: "bogus" } },
    { type: "custom", customType: "other", data: {} },
  ] as never);
  assert.equal(bad.length, 0);
});

console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
