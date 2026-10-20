/** Command wiring and awaited event contracts, without calling a model. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CUSTOM_TYPE } from "../src/store.ts";
import { Git } from "../src/git.ts";
import { makeFilePatch } from "../src/diff-engine.ts";
import { messages } from "../src/language.ts";

// Resolve production preference paths only after isolating the test home.
const testHome = await mkdtemp(join(tmpdir(), "pi-diff-extension-home-"));
const originalHome = process.env.HOME;
process.env.HOME = testHome;
const { default: extension } = await import("../index.ts");
const { LANGUAGE_PREFERENCE_PATH, loadLanguagePreference, saveLanguagePreference } = await import("../src/preferences.ts");
assert.ok(LANGUAGE_PREFERENCE_PATH.startsWith(testHome + "/"));
after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

const exec = promisify(execFile);
const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));

function setup(cwd: string) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const entries: any[] = [];
  let command: any;
  extension({
    on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name); },
    registerCommand: (name: string, config: any) => { assert.equal(name, "diff"); command = config.handler; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as never);
  const notifications: { message: string; level: string }[] = [];
  const frames: string[] = [];
  let screenInputs: string[][] = [["q"]];
  let waited = 0;
  let customCalls = 0;
  let current: any;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const ui = {
    notify: (message: string, level: string) => notifications.push({ message, level }),
    custom: (factory: any, options: any) => new Promise((resolve, reject) => {
      customCalls++;
      assert.equal(options.overlay, true);
      assert.equal(options.overlayOptions.width, "100%");
      let active = true;
      let loading = false;
      let waiters: (() => void)[] = [];
      const render = () => {
        if (!active) return;
        const output = current.render(160).join("\n");
        loading = output.includes("Loading changes…") || output.includes("正在加载改动…");
        if (!loading && frames.at(-1) !== output) frames.push(output);
        for (const notify of waiters.splice(0)) notify();
      };
      current = factory({ terminal: { rows: 24, columns: 160 }, requestRender: render }, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => {
        active = false;
        for (const notify of waiters.splice(0)) notify();
        resolve(undefined);
      });
      render();
      opened();
      void (async () => {
        for (const batch of screenInputs) {
          for (const input of batch) current.handleInput(input);
          while (active && loading) await new Promise<void>((notify) => waiters.push(notify));
          if (!active) break;
        }
      })().catch(reject);
    }),
  };
  const ctx: any = {
    cwd, mode: "tui", hasUI: true, ui,
    sessionManager: { getBranch: () => entries },
    waitForIdle: async () => { waited++; },
  };
  return {
    ctx, handlers, entries, frames, notifications,
    emit: async (type: string, event: unknown = {}) => await handlers.get(type)?.(event, ctx),
    run: async (screens = [["q"]]) => {
      screenInputs = screens;
      frames.length = 0;
      customCalls = 0;
      await command("", ctx);
    },
    waited: () => waited,
    customCalls: () => customCalls,
    current: () => current,
    ready,
  };
}

async function workspace(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-diff-extension-"));
  const oldCwd = process.cwd();
  process.chdir(dir);
  try {
    await rm(LANGUAGE_PREFERENCE_PATH, { force: true });
    await fn(dir);
  }
  finally { process.chdir(oldCwd); await rm(dir, { recursive: true, force: true }); }
}

test("pi's actual extension loader can load the entry point and register /diff", async () => {
  await workspace(async (cwd) => {
    const loader = new DefaultResourceLoader({
      cwd, agentDir: join(cwd, "agent"), settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [indexPath], noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.ok(loaded.extensions[0]!.commands.has("diff"));
  });
});

test("pi discovers the package manifest and registers /diff without host dependency warnings", async () => {
  await workspace(async (cwd) => {
    const loader = new DefaultResourceLoader({
      cwd, agentDir: join(cwd, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [dirname(indexPath)] }),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.extensions.length, 1);
    assert.equal(loaded.extensions[0]!.path, indexPath);
    assert.ok(loaded.extensions[0]!.commands.has("diff"));
  });
});

test("direct entry cycles scopes without a picker and ignores the removed d shortcut", async () => {
  await workspace(async (dir) => {
    const api = setup(dir);
    api.entries.push({ type: "custom", customType: CUSTOM_TYPE, data: { turn: 1, endedAt: "2026-10-14T00:00:00Z", fileCount: 0, patches: [] } });
    await api.run([["\t"], ["\x1b[Z"], ["d", "q"]]);
    assert.equal(api.frames.length, 3);
    assert.equal(api.customCalls(), 1, "scope changes must keep the same overlay alive");
    assert.match(api.frames[0]!, /Last turn.*Turn 1/);
    assert.match(api.frames[1]!, /Session total/);
    assert.match(api.frames[2]!, /Last turn.*Turn 1/);
    assert.ok(api.frames.every((frame) => !frame.includes("选择改动范围") && !frame.includes("切换范围")));
    assert.deepEqual(api.notifications, []);
  });
});

test("Git entry opens unstaged changes independently of turn history and stays there when empty", async () => {
  await workspace(async (dir) => {
    const git = (...args: string[]) => exec("git", args, { cwd: dir });
    await git("init", "-q", "-b", "main");
    const api = setup(dir);
    await api.run();
    assert.match(api.frames[0]!, /Unstaged[\s\S]*No file changes/);
    await git("config", "user.email", "test@example.invalid");
    await git("config", "user.name", "test");
    await writeFile("file.txt", "base\n");
    await git("add", "file.txt");
    await git("commit", "-qm", "base");
    await writeFile("file.txt", "staged\n");
    await git("add", "file.txt");
    await writeFile("file.txt", "unstaged\n");
    await writeFile("new.txt", "untracked\n");
    api.entries.push({ type: "custom", customType: CUSTOM_TYPE, data: {
      turn: 7, endedAt: "2026-10-20T00:00:00Z", fileCount: 1,
      patches: [makeFilePatch("history-only.txt", null, Buffer.from("history\n"))],
    } });
    const indexBefore = await readFile(join(dir, ".git/index"));
    await api.run();
    assert.match(api.frames[0]!, /Unstaged[\s\S]*-staged[\s\S]*\+unstaged/);
    assert.match(api.frames[0]!, /new.txt/);
    assert.ok(!api.frames[0]!.includes("history-only.txt"));
    assert.deepEqual(await readFile(join(dir, ".git/index")), indexBefore, "opening /diff leaves the index unchanged");
    await git("add", "file.txt", "new.txt");
    await api.run();
    assert.match(api.frames[0]!, /Unstaged[\s\S]*No file changes/, "empty unstaged changes do not fall back to recorded history");
    assert.equal(api.customCalls(), 1);
    assert.deepEqual(api.notifications, []);
  });
});

test("legacy malformed history is unavailable, while a valid empty turn remains genuinely empty", async () => {
  await workspace(async (dir) => {
    const api = setup(dir);
    api.entries.push({ type: "custom", customType: { customType: CUSTOM_TYPE, data: { turn: 0, patches: [] } } });
    await api.run();
    assert.equal(api.frames.length, 1);
    assert.match(api.frames[0]!, /No valid change records/);
    await api.run([["\t"], ["q"]]);
    assert.match(api.frames.at(-1)!, /complete session total unavailable/);
    api.entries.push({ type: "custom", customType: CUSTOM_TYPE, data: { turn: 1, endedAt: "2026-10-14T00:00:00Z", fileCount: 0, patches: [] } });
    await api.run();
    assert.match(api.frames[0]!, /No file changes in this turn/);
    assert.match(api.frames[0]!, /History incomplete/);
    api.entries.shift();
    await api.run();
    assert.ok(!api.frames[0]!.includes("History incomplete"));
  });
});

test("real entry handlers await old-side capture, shell scans and settled persistence", async () => {
  await workspace(async (dir) => {
    const api = setup(dir);
    await writeFile("edit.txt", "before\n");
    await api.emit("before_agent_start");
    const capture = api.handlers.get("tool_call")!({ toolName: "edit", toolCallId: "edit-1", input: { path: "edit.txt" } }, api.ctx);
    assert.ok(capture instanceof Promise, "pi must be able to await pre-tool capture");
    await capture;
    await writeFile("edit.txt", "after\n");
    await api.emit("tool_call", { toolName: "bash", toolCallId: "bash-1", input: {} });
    await writeFile("shell.txt", "shell change\n");
    await api.emit("tool_result", { toolName: "bash", toolCallId: "bash-1" });
    // A non-builtin tool bypasses edit/write hooks; the turn scan must catch it.
    await exec(process.execPath, ["-e", "require('node:fs').writeFileSync('other.txt', 'other tool\\n')"], { cwd: dir });
    const settled = api.handlers.get("agent_settled")!({}, api.ctx);
    assert.ok(settled instanceof Promise, "idle must wait for persistence");
    await settled;
    assert.equal(api.entries.length, 1);
    assert.equal(api.entries[0].customType, CUSTOM_TYPE);
    assert.deepEqual(api.entries[0].data.patches.map((p: any) => p.file), ["edit.txt", "other.txt", "shell.txt"]);
    assert.match(api.entries[0].data.patches[0].patch, /-before\n\+after/);
    assert.equal(api.entries[0].data.patches.find((p: any) => p.file === "other.txt").baselineUnknown, true);
    assert.ok(!api.handlers.has("turn_end"));

    await api.run();
    assert.equal(api.waited(), 1);
    assert.equal(api.frames.length, 1, "opens the latest turn directly without a scope picker");
    assert.match(api.frames[0]!, /Last turn.*Turn 1.*3 files[\s\S]*-before[\s\S]*\+after/);
    await api.run([["\t"], ["q"]]);
    assert.match(api.frames.at(-1)!, /Session total/);
    assert.deepEqual(api.notifications, []);
    assert.equal(await readFile("edit.txt", "utf8"), "after\n");
  });
});

test("direct screen exit, active branch refresh and non-TUI guard do not open stale screens", async () => {
  await workspace(async (dir) => {
    const api = setup(dir);
    await api.run([["\x1b"]]);
    assert.equal(api.frames.length, 1);
    api.entries.push({ type: "custom", customType: CUSTOM_TYPE, data: {
      turn: 7, endedAt: "2026-10-14T00:00:00Z", fileCount: 0, patches: [],
    } });
    await api.emit("session_tree");
    await api.run();
    assert.equal(api.frames.length, 1);
    assert.match(api.frames[0]!, /Last turn.*Turn 7/);
    api.entries.length = 0;
    await api.run();
    assert.match(api.frames[0]!, /Last turn[\s\S]*No turn records/);
    api.ctx.mode = "rpc";
    await api.run();
    assert.equal(api.frames.length, 0);
    assert.match(api.notifications[0]!.message, /interactive TUI/);
  });
});

test("Git starts unstaged and cycles all five scopes in order; a missing branch base stays in the overlay", async () => {
  await workspace(async (dir) => {
    const git = (...args: string[]) => exec("git", args, { cwd: dir });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "user.name", "test");
    await git("config", "init.defaultBranch", "main");
    await writeFile("file.txt", "base\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await git("checkout", "-qb", "feature");
    await writeFile("file.txt", "committed\n");
    await git("add", "-A");
    await git("commit", "-qm", "feature");
    await writeFile("file.txt", "staged\n");
    await git("add", "file.txt");
    await writeFile("file.txt", "working\n");
    const api = setup(dir);
    await api.run([...Array.from({ length: 5 }, () => ["\t"]), ["q"]]);
    assert.equal(api.frames.length, 6);
    for (const [index, title] of ["Unstaged", "Uncommitted", "All branch changes", "Last turn", "Session total", "Unstaged"].entries()) {
      assert.ok(api.frames[index]!.includes(title));
    }
    for (const [index, old] of ["staged", "committed", "base"].entries()) assert.ok(api.frames[index]!.includes(`-${old}`));
    await api.run([["\x1b[Z"], ["\x1b[Z"], ["\x1b[Z"], ["q"]]);
    assert.match(api.frames.at(-1)!, /All branch changes/);
    await git("branch", "-m", "main", "trunk");
    await git("config", "init.defaultBranch", "missing");
    await api.run([["\t"], ["\t"], ["q"]]);
    assert.equal(api.customCalls(), 1);
    assert.match(api.frames.at(-1)!, /All branch changes[\s\S]*Failed to load[\s\S]*No review base available/);
    assert.deepEqual(api.notifications, []);
  });
});

test("rapid scope changes ignore stale responses and callbacks after closing the one overlay", async () => {
  await workspace(async (dir) => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const original = Git.diff;
    let resolveSlow!: (files: ReturnType<typeof makeFilePatch>[]) => void;
    let rejectClosed!: (error: Error) => void;
    const slow = new Promise<ReturnType<typeof makeFilePatch>[]>((resolve) => { resolveSlow = resolve; });
    const afterClose = new Promise<ReturnType<typeof makeFilePatch>[]>((_resolve, reject) => { rejectClosed = reject; });
    Git.diff = async (_cwd, mode) => mode === "working" ? slow : mode === "branch" ? afterClose
      : [makeFilePatch("latest.txt", Buffer.from("old\n"), Buffer.from("LATEST\n"))];
    const api = setup(dir);
    const running = api.run([]);
    try {
      await api.ready;
      api.current().handleInput("\t");
      api.current().handleInput("\x1b[Z");
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(api.frames.at(-1)!, /Unstaged[\s\S]*LATEST/);
      resolveSlow([makeFilePatch("stale.txt", null, Buffer.from("STALE\n"))]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(api.frames.at(-1)!, /Unstaged[\s\S]*LATEST/);
      assert.ok(!api.frames.at(-1)!.includes("STALE"));
      api.current().handleInput("\t");
      api.current().handleInput("\t");
      api.current().handleInput("q");
      await running;
      const frames = [...api.frames];
      rejectClosed(new Error("late failure"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(api.frames, frames);
      assert.equal(api.customCalls(), 1);
      assert.deepEqual(api.notifications, []);
    } finally {
      Git.diff = original;
      resolveSlow([]);
      api.current()?.handleInput("q");
      await running;
    }
  });
});

test("language toggles persist on close across extension instances, projects and non-TUI notifications", async () => {
  await workspace(async (dir) => {
    const api = setup(dir);
    await api.run([["l"], ["q"]]);
    assert.match(api.frames[0]!, /Last turn/);
    assert.match(api.frames.at(-1)!, /最近一轮[\s\S]*没有轮次记录/);
    assert.equal(await loadLanguagePreference(LANGUAGE_PREFERENCE_PATH), "zh-CN");
    const other = join(dir, "another-project");
    await mkdir(other);
    const reopened = setup(other);
    await reopened.run();
    assert.match(reopened.frames[0]!, /最近一轮/);
    reopened.ctx.mode = "rpc";
    await reopened.run();
    assert.match(reopened.notifications.at(-1)!.message, /交互式 TUI/);
    reopened.ctx.mode = "tui";
    await reopened.run([["L"], ["q"]]);
    assert.equal(await loadLanguagePreference(LANGUAGE_PREFERENCE_PATH), "en");
    await writeFile(LANGUAGE_PREFERENCE_PATH, '{"language":"broken"}');
    await reopened.run();
    assert.match(reopened.frames[0]!, /Last turn/);
    assert.deepEqual(api.notifications, []);
  });
});

test("a failed language save reports the current language and preserves the existing target", async () => {
  await workspace(async (dir) => {
    await mkdir(LANGUAGE_PREFERENCE_PATH, { recursive: true });
    const sentinel = join(LANGUAGE_PREFERENCE_PATH, "preserved");
    await writeFile(sentinel, "keep");
    try {
      const api = setup(dir);
      await api.run([["L"], ["q"]]);
      assert.equal(api.notifications.length, 1);
      assert.equal(api.notifications[0]!.level, "error");
      assert.match(api.notifications[0]!.message, /^pi-diff：.*EISDIR/);
      assert.equal(await readFile(sentinel, "utf8"), "keep");
    } finally { await rm(LANGUAGE_PREFERENCE_PATH, { recursive: true, force: true }); }
  });
});

test("both languages cover five scopes, empty turns and incomplete history", async () => {
  await workspace(async (dir) => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const original = Git.diff;
    Git.diff = async () => [];
    try {
      for (const language of ["en", "zh-CN"] as const) {
        await saveLanguagePreference(LANGUAGE_PREFERENCE_PATH, language);
        const text = messages[language];
        const api = setup(dir);
        api.entries.push({ type: "custom", customType: { customType: CUSTOM_TYPE, data: {} } });
        await api.run([["\x1b[Z"], ["\x1b[Z"], ["q"]]);
        assert.ok(api.frames.at(-1)!.includes(text.noHistory));
        await api.run([["\x1b[Z"], ["q"]]);
        assert.ok(api.frames.at(-1)!.includes(text.unavailableTotal));
        api.entries.push({ type: "custom", customType: CUSTOM_TYPE, data: { turn: 9, endedAt: "2026-10-19T00:00:00Z", fileCount: 0, patches: [] } });
        await api.run([["\t"], ["\t"], ["\t"], ["\t"], ["q"]]);
        assert.equal(api.customCalls(), 1);
        assert.equal(api.frames.length, 5);
        for (const [index, title] of [text.unstaged, text.working, text.branch, text.turn(9), text.session].entries()) {
          assert.ok(api.frames[index]!.includes(title));
        }
        assert.ok(api.frames[3]!.includes(text.emptyTurn));
        assert.ok(api.frames[3]!.includes(text.incompleteHistory));
        assert.ok(!api.frames[0]!.includes(text.incompleteHistory));
      }
    } finally { Git.diff = original; }
  });
});

test("language changes during loading and failure keep one request and use the current language", async () => {
  await workspace(async (dir) => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const original = Git.diff;
    let resolve!: (files: ReturnType<typeof makeFilePatch>[]) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<ReturnType<typeof makeFilePatch>[]>((done) => { resolve = done; });
    const failure = new Promise<ReturnType<typeof makeFilePatch>[]>((_done, fail) => { reject = fail; });
    let requests = 0;
    Git.diff = async (_cwd, mode) => { requests++; return mode === "unstaged" ? [] : mode === "working" ? pending : failure; };
    const api = setup(dir);
    const running = api.run([]);
    try {
      await api.ready;
      api.current().handleInput("\t");
      await new Promise((done) => setImmediate(done));
      assert.match(api.current().render(160).join("\n"), /Uncommitted[\s\S]*Loading changes/);
      api.current().handleInput("L");
      assert.match(api.current().render(160).join("\n"), /未提交[\s\S]*正在加载改动/);
      assert.equal(requests, 2);
      resolve([makeFilePatch("原文件.txt", Buffer.from("old\n"), Buffer.from("new\n"))]);
      await new Promise((done) => setImmediate(done));
      assert.match(api.frames.at(-1)!, /未提交[\s\S]*原文件.txt[\s\S]*-old[\s\S]*\+new/);
      api.current().handleInput("\t");
      api.current().handleInput("L");
      reject(new Error("RAW_ERROR 原始错误"));
      await new Promise((done) => setImmediate(done));
      assert.match(api.frames.at(-1)!, /All branch changes[\s\S]*Failed to load: RAW_ERROR 原始错误/);
      api.current().handleInput("L");
      assert.match(api.frames.at(-1)!, /分支全部改动[\s\S]*加载失败：RAW_ERROR 原始错误/);
      assert.equal(requests, 3);
      assert.equal(api.customCalls(), 1);
      api.current().handleInput("q");
      await running;
      assert.deepEqual(api.notifications, []);
    } finally {
      Git.diff = original;
      resolve([]);
      api.current()?.handleInput("q");
      await running;
    }
  });
});
