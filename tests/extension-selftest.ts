/** Command wiring and awaited event contracts, without calling a model. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { CUSTOM_TYPE } from "../src/store.ts";
import { Git } from "../src/git.ts";
import { makeFilePatch } from "../src/diff-engine.ts";

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
        loading = output.includes("正在加载改动");
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
  try { await fn(dir); }
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

test("legacy malformed history is unavailable, while a valid empty turn remains genuinely empty", async () => {
  await workspace(async (dir) => {
    const api = setup(dir);
    api.entries.push({ type: "custom", customType: { customType: CUSTOM_TYPE, data: { turn: 0, patches: [] } } });
    await api.run();
    assert.equal(api.frames.length, 1);
    assert.match(api.frames[0]!, /旧会话没有有效的改动记录/);
    await api.run([["\t"], ["q"]]);
    assert.match(api.frames.at(-1)!, /无法展示完整累计/);
    api.entries.push({ type: "custom", customType: CUSTOM_TYPE, data: { turn: 1, endedAt: "2026-10-14T00:00:00Z", fileCount: 0, patches: [] } });
    await api.run();
    assert.match(api.frames[0]!, /本轮没有文件改动/);
    assert.match(api.frames[0]!, /历史记录不完整/);
    api.entries.shift();
    await api.run();
    assert.ok(!api.frames[0]!.includes("历史记录不完整"));
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
    assert.match(api.frames[0]!, /Last turn.*Turn 1.*3 个文件[\s\S]*-before[\s\S]*\+after/);
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
    assert.match(api.frames[0]!, /Last turn[\s\S]*没有轮次记录/);
    api.ctx.mode = "rpc";
    await api.run();
    assert.equal(api.frames.length, 0);
    assert.match(api.notifications[0]!.message, /交互式 TUI/);
  });
});

test("five screens follow the requested order and a missing branch base yields an error notification", async () => {
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
    await writeFile("file.txt", "working\n");
    const api = setup(dir);
    for (const [steps, title, old] of [[2, "Unstaged", "committed"], [3, "Uncommitted", "committed"], [4, "All branch changes", "base"]] as const) {
      await api.run([...Array.from({ length: steps }, () => ["\t"]), ["q"]]);
      assert.equal(api.frames.length, steps + 1);
      assert.match(api.frames[0]!, /Last turn/);
      assert.match(api.frames[1]!, /Session total/);
      assert.ok(api.frames.at(-1)!.includes(title));
      assert.ok(api.frames.at(-1)!.includes(old));
    }
    await git("branch", "-m", "main", "trunk");
    await git("config", "init.defaultBranch", "missing");
    await api.run([["\x1b[Z"], ["q"]]);
    assert.equal(api.customCalls(), 1);
    assert.match(api.frames.at(-1)!, /All branch changes[\s\S]*加载失败[\s\S]*No review base available/);
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
    Git.diff = async (_cwd, mode) => mode === "unstaged" ? slow : mode === "branch" ? afterClose
      : [makeFilePatch("latest.txt", Buffer.from("old\n"), Buffer.from("LATEST\n"))];
    const api = setup(dir);
    const running = api.run([]);
    try {
      await api.ready;
      api.current().handleInput("\t");
      api.current().handleInput("\t");
      api.current().handleInput("\t");
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(api.frames.at(-1)!, /Uncommitted[\s\S]*LATEST/);
      resolveSlow([makeFilePatch("stale.txt", null, Buffer.from("STALE\n"))]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(api.frames.at(-1)!, /Uncommitted[\s\S]*LATEST/);
      assert.ok(!api.frames.at(-1)!.includes("STALE"));
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
