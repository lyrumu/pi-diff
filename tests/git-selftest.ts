/** Phase 2 checks against real Git, isolated in disposable repositories. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { chunksByFile, countPatch, MAX_PATCH_BYTES, MAX_TOTAL_PATCH_BYTES } from "../src/diff-engine.ts";
import { Git, VCS_DIFF_CONTEXT_LINES } from "../src/git.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;

async function repository(fn: (dir: string) => Promise<void>, commit = true) {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-git-"));
  try {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "config", "user.email", "test@example.invalid");
    await git(dir, "config", "user.name", "pi-diff test");
    await git(dir, "config", "init.defaultBranch", "main");
    if (commit) {
      await writeFile(join(dir, "base.txt"), "base\n");
      await git(dir, "add", "base.txt");
      await git(dir, "commit", "-qm", "base");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("four scopes match native Git; working includes staged and untracked changes", async () => {
  await repository(async (dir) => {
    const base = (await git(dir, "rev-parse", "HEAD")).trim();
    await git(dir, "checkout", "-qb", "feature");
    await writeFile(join(dir, "base.txt"), "feature\n");
    await writeFile(join(dir, "deleted.txt"), "delete me\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feature");
    await git(dir, "checkout", "-q", "main");
    await writeFile(join(dir, "main-only.txt"), "unrelated base advance\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "advance main");
    await git(dir, "checkout", "-q", "feature");
    await writeFile(join(dir, "staged.txt"), "stage me\n");
    await git(dir, "add", "staged.txt");
    await writeFile(join(dir, "staged.txt"), "staged then edited\n");
    await writeFile(join(dir, "base.txt"), "disk\n");
    await rm(join(dir, "deleted.txt"));
    await writeFile(join(dir, "untracked.txt"), "new\n");
    const index = await readFile(join(dir, ".git/index"));
    const head = await readFile(join(dir, ".git/HEAD"));
    const status = await git(dir, "status", "--porcelain=v1", "-z");

    for (const mode of ["working", "committed", "branch", "unstaged"] as const) {
      const ref = mode === "working" ? "HEAD" : base;
      const target = mode === "committed" ? ["HEAD"] : [];
      const native = await git(dir, "diff", "--no-ext-diff", "--no-renames", "--unified=12", ...(mode === "unstaged" ? [] : [ref, ...target]), "--", ".");
      const expected = chunksByFile({ text: native, truncated: false }, () => undefined);
      const actual = await Git.diff(dir, mode);
      assert.deepEqual(actual.map((p) => p.file).sort(), [...expected.keys(), ...(mode === "committed" ? [] : ["untracked.txt"])].sort());
      for (const patch of actual) {
        if (patch.file === "untracked.txt") {
          assert.equal(patch.status, "added");
          assert.equal(patch.additions, 1);
          assert.match(patch.patch, /\+new/);
        } else {
          assert.equal(patch.patch, expected.get(patch.file));
          assert.deepEqual({ additions: patch.additions, deletions: patch.deletions }, countPatch(patch.patch));
        }
      }
      assert.ok(!actual.some((p) => p.file === "main-only.txt"), "review starts at merge base");
    }
    assert.deepEqual(await readFile(join(dir, ".git/index")), index, "queries never write the index");
    assert.deepEqual(await readFile(join(dir, ".git/HEAD")), head);
    assert.equal(await git(dir, "status", "--porcelain=v1", "-z"), status);
    assert.equal((await Git.showRevision(dir, "", "staged.txt"))?.toString(), "stage me\n", "index old-side retrieval still works");
    assert.equal((await Git.showRevision(dir, "HEAD", "base.txt"))?.toString(), "feature\n");
  });
});

test("remote HEAD, configured default, explicit base and detached HEAD resolve correctly", async () => {
  await repository(async (dir) => {
    const base = (await git(dir, "rev-parse", "HEAD")).trim();
    await git(dir, "checkout", "-qb", "feature");
    await writeFile(join(dir, "base.txt"), "changed\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feature");
    await git(dir, "remote", "add", "origin", "https://example.invalid/repo.git");
    await git(dir, "update-ref", "refs/remotes/origin/trunk", base);
    await git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    await git(dir, "config", "init.defaultBranch", "feature");
    assert.equal((await Git.diff(dir, "committed")).length, 1, "remote HEAD precedes configuration");
    await git(dir, "remote", "remove", "origin");
    assert.deepEqual(await Git.diff(dir, "committed"), [], "configured default precedes main");
    assert.equal((await Git.diff(dir, "committed", { base: "main" })).length, 1);
    await git(dir, "checkout", "--detach", "-q");
    assert.equal((await Git.diff(dir, "committed", { base: "main" })).length, 1);
    await assert.rejects(Git.diff(dir, "branch", { base: "missing" }), /No merge base/);
    await assert.rejects(Git.diff(dir, "branch", { base: "--help" }), /No merge base/);
    await assert.rejects(Git.diff(dir, "working", { context: -1 }), /Invalid Git diff context/);
    await git(dir, "branch", "-m", "main", "trunk");
    await git(dir, "config", "--unset", "init.defaultBranch");
    await assert.rejects(Git.diff(dir, "branch"), /No review base/);
  });
});

test("no Git and unborn HEAD degrade without errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-no-git-"));
  try {
    for (const mode of ["working", "committed", "branch", "unstaged"] as const) assert.deepEqual(await Git.diff(dir, mode), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await repository(async (dir) => {
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await git(dir, "add", "staged.txt");
    await writeFile(join(dir, "untracked.txt"), "untracked\n");
    assert.deepEqual(await Git.diff(dir, "committed"), []);
    assert.deepEqual((await Git.diff(dir, "unstaged")).map((p) => p.file), ["untracked.txt"]);
    await writeFile(join(dir, "staged.txt"), "staged then edited\n");
    assert.match((await Git.diff(dir, "unstaged")).find((p) => p.file === "staged.txt")!.patch, /-staged\n\+staged then edited/);
    for (const mode of ["working", "branch"] as const) {
      const patches = await Git.diff(dir, mode);
      assert.deepEqual(patches.map((p) => p.file), ["staged.txt", "untracked.txt"]);
      assert.ok(patches.every((p) => p.status === "added" && p.additions === 1));
    }
  }, false);
});

test("unstaged compares against index, omits staged-only edits and preserves subdirectory/binary budgets", async () => {
  await repository(async (dir) => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "base.txt"), "staged only\n");
    await writeFile(join(dir, "sub", "staged-new.txt"), "index\n");
    await writeFile(join(dir, "sub", "gone.txt"), "delete after stage\n");
    await git(dir, "add", "-A");
    await writeFile(join(dir, "sub", "staged-new.txt"), "disk\n");
    await rm(join(dir, "sub", "gone.txt"));
    await writeFile(join(dir, "sub", "untracked.txt"), "untracked\n");
    await writeFile(join(dir, "sub", "binary"), Buffer.from([0, 1]));
    await writeFile(join(dir, "sub", "large"), "x".repeat(MAX_PATCH_BYTES + 1));
    const index = await readFile(join(dir, ".git", "index"));
    const actual = await Git.diff(join(dir, "sub"), "unstaged");
    assert.ok(!actual.some((p) => p.file === "base.txt"));
    assert.match(actual.find((p) => p.file === "sub/staged-new.txt")!.patch, /-index\n\+disk/);
    assert.equal(actual.find((p) => p.file === "sub/staged-new.txt")!.status, "modified");
    assert.equal(actual.find((p) => p.file === "sub/gone.txt")!.status, "deleted");
    assert.equal(actual.find((p) => p.file === "sub/binary")!.binary, true);
    assert.equal(actual.find((p) => p.file === "sub/large")!.tooLarge, true);
    assert.equal(actual.find((p) => p.file === "sub/untracked.txt")!.status, "added");
    assert.deepEqual(await readFile(join(dir, ".git", "index")), index);
  });
});

test("subdirectory scopes, unusual paths, binary, symlinks, empty files and 12-line context", async () => {
  await repository(async (dir) => {
    await mkdir(join(dir, "sub"));
    const names = ["中文 空格.txt", "tab\tfile.txt", "line\nfile.txt", 'quote"file.txt', "[magic]*.txt"];
    for (const name of names) await writeFile(join(dir, "sub", name), "old\n");
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("");
    await writeFile(join(dir, "sub/context.txt"), content);
    await writeFile(join(dir, "sub/binary.bin"), Buffer.from([1, 0, 2]));
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "paths");
    for (const name of names) await writeFile(join(dir, "sub", name), "new\n");
    await writeFile(join(dir, "sub/context.txt"), content.replace("line 25\n", "changed\n"));
    await writeFile(join(dir, "sub/binary.bin"), Buffer.from([1, 0, 3]));
    await writeFile(join(dir, "sub/new\n中文.txt"), "untracked\n");
    await writeFile(join(dir, "sub/empty.txt"), "");
    await symlink("context.txt", join(dir, "sub/link"));
    await writeFile(join(dir, "outside.txt"), "outside scope\n");
    const patches = await Git.diff(join(dir, "sub"), "working");
    assert.equal(patches.length, names.length + 5);
    assert.ok(patches.every((p) => p.file.startsWith("sub/")));
    for (const name of names) assert.match(patches.find((p) => p.file === `sub/${name}`)!.patch, /\+new/);
    assert.equal(patches.find((p) => p.file === "sub/binary.bin")!.binary, true);
    assert.equal(patches.find((p) => p.file === "sub/binary.bin")!.patch, "");
    assert.equal(patches.find((p) => p.file === "sub/empty.txt")!.status, "added");
    assert.match(patches.find((p) => p.file === "sub/link")!.patch, /\+context.txt/);
    const patch = patches.find((p) => p.file === "sub/context.txt")!.patch;
    assert.equal(VCS_DIFF_CONTEXT_LINES, 12);
    assert.match(patch, /@@ -14,25 \+14,25 @@/);
    assert.ok(!patch.includes("line 0\n"));
  });
});

test("per-file and aggregate budgets retain filenames and counts without partial patches", async () => {
  await repository(async (dir) => {
    const line = "x".repeat(998) + "\n";
    await writeFile(join(dir, "a-large.txt"), line.repeat(6000));
    await writeFile(join(dir, "b-large.txt"), line.repeat(6000));
    await writeFile(join(dir, "c-small.txt"), "small\n");
    const patches = await Git.diff(dir, "working");
    assert.equal(patches.length, 3);
    assert.equal(patches[0]!.tooLarge, undefined);
    assert.equal(patches[1]!.tooLarge, true);
    assert.equal(patches[2]!.tooLarge, true);
    assert.equal(patches[1]!.additions, 6000, "counts survive budget degradation");
    assert.equal(countPatch(patches[1]!.patch).additions, 0);
    assert.ok(patches.filter((p) => !p.tooLarge).reduce((sum, p) => sum + Buffer.byteLength(p.patch), 0) <= MAX_TOTAL_PATCH_BYTES);
    await rm(join(dir, "a-large.txt"));
    await rm(join(dir, "b-large.txt"));
    await writeFile(join(dir, "a-oversized.txt"), "z".repeat(MAX_PATCH_BYTES + 1));
    const oversized = await Git.diff(dir, "working");
    assert.equal(oversized[0]!.tooLarge, true);
    assert.equal(oversized[0]!.additions, 1);
    assert.equal(oversized[1]!.tooLarge, undefined, "one oversized file need not crowd out small files");

    await rm(join(dir, "a-oversized.txt"));
    await writeFile(join(dir, "a-tracked.txt"), "old\n");
    await writeFile(join(dir, "b-tracked.txt"), "old\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "tracked");
    await writeFile(join(dir, "a-tracked.txt"), line.repeat(6000));
    await writeFile(join(dir, "b-tracked.txt"), line.repeat(6000));
    const truncated = await Git.diff(dir, "working");
    assert.equal(truncated.length, 2);
    assert.equal(truncated[0]!.tooLarge, undefined);
    assert.equal(truncated[1]!.tooLarge, true);
    assert.equal(truncated[1]!.additions, 6000);
    assert.equal(countPatch(truncated[1]!.patch).additions, 0);
  });
});

test("rename, ignored files and unresolved merges retain Git semantics", async () => {
  await repository(async (dir) => {
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "ignore");
    await git(dir, "mv", "base.txt", "renamed.txt");
    await writeFile(join(dir, "ignored.txt"), "ignored\n");
    const renamed = await Git.diff(dir, "working");
    assert.deepEqual(renamed.map((p) => [p.file, p.status]), [["base.txt", "deleted"], ["renamed.txt", "added"]]);
    await git(dir, "commit", "-qm", "rename");
    await git(dir, "checkout", "-qb", "other");
    await writeFile(join(dir, "renamed.txt"), "other branch\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "other edit");
    await git(dir, "checkout", "-q", "main");
    await writeFile(join(dir, "renamed.txt"), "main branch\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "main edit");
    await assert.rejects(git(dir, "merge", "other"));
    const conflict = await Git.diff(dir, "working");
    assert.equal(conflict.length, 1);
    assert.equal(conflict[0]!.status, "modified");
    assert.equal(conflict[0]!.patch, await git(dir, "diff", "--no-ext-diff", "--no-renames", "--unified=12", "HEAD", "--", "renamed.txt"));
  });
});
