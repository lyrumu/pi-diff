/** Stage 3 checks use the actual pi renderer with an in-memory terminal. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, TuiAltScreen, visibleWidth, type Component, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { makeFilePatch, type FilePatch } from "../src/diff-engine.ts";
import { buildFileTree, flattenFileTree, toggleFileTreeDirectory } from "../src/tui/file-tree-utils.ts";
import { FileTree } from "../src/tui/file-tree.ts";
import { DiffScreen, FULLSCREEN_OPTIONS } from "../src/tui/diff-screen.ts";
import { PatchDiff, VIRTUAL_CHUNK_LINES, VIRTUAL_MIN_LINES } from "../src/tui/patch-diff.ts";
import { cycleScope, type DiffScope } from "../src/tui/scopes.ts";

function theme(light = false): Theme {
  return new Theme({
    accent: light ? "#0000ff" : "#00ffff", success: "#00ff00", error: "#ff0000",
    muted: light ? "#444444" : "#aaaaaa", borderMuted: "#555555", text: "", thinkingXhigh: "#aaaaaa",
  } as never, { selectedBg: "", toolSuccessBg: light ? "#dcfce7" : "#143322", toolErrorBg: light ? "#fee2e2" : "#3d1a1a" } as never, "truecolor");
}

class MemoryTerminal implements Terminal {
  columns = 160;
  rows = 24;
  kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  output = "";
  stopped = false;
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(text: string) { this.output += text; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

const host = () => ({ terminal: new MemoryTerminal(), requestRender() {} });
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const frame = (component: Component, width: number, height: number) => {
  const lines = component.render(width);
  assert.equal(lines.length, height);
  assert.ok(lines.every((line) => visibleWidth(line) <= width), `frame overflow at width ${width}`);
  return plain(lines);
};
const patch = (file: string, old: string | null, next: string | null) => makeFilePatch(file, old === null ? null : Buffer.from(old), next === null ? null : Buffer.from(next));

test("file tree preserves upstream ordering, collapsed directory chains and selection", () => {
  const files = [patch("root.txt", "a\n", "b\n"), patch("src/deep/a.ts", null, "a\n"), patch("src/deep/b.ts", "b\n", null)];
  const tree = buildFileTree(files);
  const rows = flattenFileTree(tree);
  assert.deepEqual(rows.map((row) => row.name), ["src/deep", "a.ts", "b.ts", "root.txt"]);
  const expanded = new Set(tree.nodes.filter((node) => node.kind === "directory").map((node) => node.id));
  assert.deepEqual(flattenFileTree(tree, toggleFileTreeDirectory(tree, expanded, rows[0]!.id)).map((row) => row.name), ["src/deep", "root.txt"]);
  const view = new FileTree(files);
  assert.equal(view.selectedFile(), 1);
  view.move(-1);
  view.toggle();
  assert.ok(!plain(view.render(30, 8, theme(), true, 1)).includes("a.ts"));
  view.selectFile(2);
  const output = plain(view.render(30, 8, theme(), true, 2));
  assert.match(output, /a.ts.*A/);
  assert.match(output, /b.ts.*D/);
  assert.equal(view.selectedFile(), 2);
});

test("the complete screen preserves upstream A/D/M status columns beside the tree divider", () => {
  const files = [
    patch(`src/a-${"中文".repeat(30)}.ts`, null, "added\n"),
    patch("src/d-deleted.ts", "deleted\n", null),
    patch("src/m-modified.ts", "old\n", "new\n"),
  ];
  for (const light of [false, true]) for (const width of [40, 89, 90, 120, 160, 200]) {
    const ui = host();
    ui.terminal.columns = width;
    const screen = new DiffScreen(ui, theme(light), "Last turn", files, () => {});
    if (width < 90) screen.handleInput("h");
    frame(screen, width, 24);
    const treeWidth = width < 90 ? width : Math.max(30, Math.min(40, Math.floor(width / 4))) - 1;
    const statuses = screen.render(width).map((line) => stripTerminalSequences(sliceByColumn(line, 0, treeWidth)))
      .flatMap((line) => / ([AMD])$/.exec(line)?.[1] ?? []);
    assert.deepEqual(statuses, ["A", "D", "M"], `status column at width ${width}, light=${light}`);
  }
});

test("five scopes cycle in order, reverse and hide Git outside a repository", () => {
  const turns = [{turn: 7, endedAt: "2026-10-14T00:00:00Z", fileCount: 0, patches: []}];
  const expected: DiffScope[] = [{kind: "turn", turn: 7}, {kind: "session"},
    {kind: "git", mode: "unstaged"}, {kind: "git", mode: "working"}, {kind: "git", mode: "branch"}];
  let scope: DiffScope = expected[0]!;
  for (let i = 1; i <= 5; i++) {
    scope = cycleScope(scope, 1, turns, true);
    assert.deepEqual(scope, expected[i % 5]);
  }
  assert.deepEqual(cycleScope(scope, -1, turns, true), expected[4]);
  assert.deepEqual(cycleScope(scope, 1, turns, false), {kind: "session"});
  assert.deepEqual(cycleScope({kind: "session"}, 1, [], false), {kind: "turn", turn: undefined});
});

test("unified/split line numbers pair unequal replacements, multiple hunks and no-newline markers", () => {
  const file: FilePatch = {
    file: "test.txt", status: "modified", additions: 3, deletions: 2,
    patch: "--- a/test.txt\n+++ b/test.txt\n@@ -2,3 +2,4 @@\n keep\n-old1\n-old2\n+new1\n+new2\n+new3\n\\ No newline at end of file\n@@ -100 +101 @@\n-tail\n+end\n",
  };
  const view = new PatchDiff(file);
  const unified = plain(view.renderViewport(80, view.rowCount(80, "unified"), 0, "unified", theme()));
  assert.match(unified, /3\s+-old1/);
  assert.match(unified, /4\s+\+new2/);
  assert.match(unified, /100\s+-tail/);
  const split = plain(view.renderViewport(80, view.rowCount(80, "split"), 0, "split", theme()));
  assert.match(split, /3 -old1[^\n]*│\s*3 \+new1/);
  assert.match(split, /4 -old2[^\n]*│\s*4 \+new2/);
  assert.match(split, /│\s*5 \+new3/);
  assert.match(split, /No newline at end of file/);
  assert.match(split, /100 -tail[^\n]*│\s*101 \+end/);
  assert.ok(view.rowCount(80, "split") < view.rowCount(80, "unified"));
  assert.equal(new PatchDiff(patch("new", null, "new\n")).effectiveView("split"), "unified");
});

test("binary, capped, baseline-unknown, empty and metadata-only patches show honest placeholders", () => {
  const files = [
    { ...patch("binary", null, "x"), binary: true, patch: "" },
    { ...patch("large", null, "x"), tooLarge: true, patch: "" },
    { ...patch("unknown", null, "x"), baselineUnknown: true },
    patch("empty", null, ""),
  ];
  const ui = host();
  const screen = new DiffScreen(ui, theme(), "Last turn", files, () => {});
  assert.match(frame(screen, 160, 24), /二进制文件已改变/);
  screen.handleInput("n");
  assert.match(frame(screen, 160, 24), /没有文本变化/);
  screen.handleInput("n");
  assert.match(frame(screen, 160, 24), /10MB 上限/);
  screen.handleInput("n");
  assert.match(frame(screen, 160, 24), /修改前内容未知/);
  assert.match(frame(new DiffScreen(ui, theme(), "Session", [], () => {}), 160, 24), /没有文件改动/);
  const unavailable = new DiffScreen(ui, theme(), "Session", [{ ...patch("unreadable", "old\n", "new\n"), unavailable: true }], () => {});
  assert.match(frame(unavailable, 160, 24), /文件内容不可用/);
  const fallback = new DiffScreen(ui, theme(), "Session", [{ ...patch("partial", "old\n", "new\n"), cumulativeFallback: true }], () => {});
  assert.match(frame(fallback, 160, 24), /仅显示最后一轮/);
  const deleted = new DiffScreen(ui, theme(), "Session", [{ ...patch("gone", "old\n", null), baselineUnknown: true }], () => {});
  assert.match(frame(deleted, 160, 24), /文件已删除；修改前内容未知/);
});

test("keyboard layout/focus/navigation, CJK wrapping and resize never overflow", () => {
  const ui = host();
  let closed = 0;
  const preferences: string[] = [];
  const screen = new DiffScreen(ui, theme(), "Session", [
    patch("src/中文.ts", "old\n", "new\n"),
    patch("src/long.ts", "old\n", "长".repeat(100) + "TAIL\n"),
  ], () => { closed++; }, { onViewChange: (view) => preferences.push(view) });
  assert.match(frame(screen, 160, 24), /拆分视图/);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /合并视图/);
  assert.deepEqual(preferences, ["unified"]);
  screen.handleInput("h");
  screen.handleInput("\x1b[B");
  assert.match(frame(screen, 160, 24), /中文.ts/);
  screen.handleInput("p");
  screen.handleInput("l");
  assert.match(frame(screen, 160, 24), /long.ts/);
  assert.match(frame(screen, 160, 24), /TAIL/);
  for (const width of [140, 100, 89, 40, 9, 3, 1, 160]) {
    ui.terminal.columns = width;
    ui.terminal.rows = Math.min(24, width);
    frame(screen, width, ui.terminal.rows);
    screen.handleInput("h");
    frame(screen, width, ui.terminal.rows);
    screen.handleInput("l");
  }
  screen.handleInput("q");
  assert.equal(closed, 1);
  screen.handleInput("\x1b");
  assert.equal(closed, 2);
});

test("large patches paint bounded 128-line chunks, preserve theme changes and scroll smoothly", () => {
  assert.equal(VIRTUAL_MIN_LINES, 3000);
  assert.equal(VIRTUAL_CHUNK_LINES, 128);
  const file = patch("big.txt", null, Array.from({ length: 10000 }, (_, i) => `中文 line ${i}`).join("\n") + "\n");
  const view = new PatchDiff(file);
  let painted = 0;
  const current = theme();
  const fg = current.fg.bind(current);
  current.fg = (color, text) => { painted++; return fg(color, text); };
  const first = view.renderViewport(100, 24, 5000, "unified", current);
  assert.ok(painted <= 2 * VIRTUAL_CHUNK_LINES);
  assert.match(plain(first), /line 4999/);
  painted = 0;
  assert.deepEqual(view.renderViewport(100, 24, 5000, "unified", current), first);
  assert.equal(painted, 0);
  view.invalidate();
  const changed = view.renderViewport(100, 24, 5000, "unified", theme(true));
  // Addition color is intentionally stable; hunk color changes with the theme.
  const hunk = view.renderViewport(100, 1, 0, "unified", theme(true));
  view.invalidate();
  assert.notDeepEqual(view.renderViewport(100, 1, 0, "unified", theme()), hunk);
  assert.equal(plain(changed), plain(first));
  const start = performance.now();
  for (let i = 0; i < 500; i++) view.renderViewport(100, 24, i, "unified", current);
  assert.ok(performance.now() - start < 5000, "500 scroll frames finish within a generous 5-second bound");
});

test("file/source control sequences are visible text instead of terminal instructions", () => {
  const ui = host();
  const screen = new DiffScreen(ui, theme(), "unsafe\x1b[2J", [patch("file\n\x1b[31m.txt", "old\n", "hello\x1b[2J\x07\tend\n")], () => {});
  const rendered = screen.render(160);
  assert.ok(!rendered.join("\n").includes("\x1b[2J"));
  assert.match(plain(rendered), /hello\\x1b\[2J\\x07/);
  assert.match(plain(rendered), /file\\n\\x1b\[31m.txt/);
});

test("real pi overlay occupies the whole terminal, resizes and restores underlying focus/content", () => {
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  const input: string[] = [];
  const chat: Component = { render: () => ["CHAT CONTENT"], invalidate() {}, handleInput: (data) => input.push(data) };
  tui.addChild(chat);
  tui.setFocus(chat);
  tui.start();
  try {
    let closed = false;
    const screen = new DiffScreen(tui, theme(), "Working copy", [patch("file.txt", "old\n", "new\n")], () => { closed = true; handle.hide(); });
    const handle = tui.showOverlay(screen, FULLSCREEN_OPTIONS.overlayOptions);
    tui.renderNow(true);
    assert.deepEqual(handle.getBounds(), { row: 0, col: 0, width: 160, height: 24 });
    assert.equal(tui.getFocusedComponent(), screen);
    assert.ok(!plain(tui.getScreenLines()).includes("CHAT CONTENT"));
    assert.match(plain(tui.getScreenLines()), /new/);
    screen.setData("Session total", [], { emptyMessage: "正在加载改动…" });
    tui.renderNow(true);
    assert.match(plain(tui.getScreenLines()), /正在加载改动/);
    assert.ok(!plain(tui.getScreenLines()).includes("CHAT CONTENT"));
    assert.equal(tui.getFocusedComponent(), screen);
    screen.setData("Session total", [patch("other.txt", "old\n", "new\n")]);
    tui.renderNow(true);
    assert.match(plain(tui.getScreenLines()), /other.txt/);
    assert.ok(!plain(tui.getScreenLines()).includes("CHAT CONTENT"));
    terminal.columns = 60;
    terminal.rows = 12;
    terminal.resize();
    tui.renderNow(true);
    assert.deepEqual(handle.getBounds(), { row: 0, col: 0, width: 60, height: 12 });
    terminal.input("q");
    tui.renderNow(true);
    assert.equal(closed, true);
    assert.equal(tui.getFocusedComponent(), chat);
    assert.match(plain(tui.getScreenLines()), /CHAT CONTENT/);
    assert.ok(!plain(tui.getScreenLines()).includes("Working copy"));
    terminal.input("x");
    assert.deepEqual(input, ["x"]);
  } finally {
    tui.stop();
  }
  assert.equal(terminal.stopped, true);
});

const mouse = (x: number, y: number, changes: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type: "click", button: "left", x, y, screenX: x, screenY: y, width: 160, height: 24,
  shift: false, alt: false, ctrl: false, ...changes,
});

test("scope keys are separate from layout; mouse changes layout, directories and narrow files", () => {
  const ui = host();
  const actions: number[] = [];
  const screen = new DiffScreen(ui, theme(), "会话累计", [patch("a.txt", "old\n", "new\n")], () => {}, { onScopeChange: (direction) => actions.push(direction) });
  screen.handleInput("\t"); screen.handleInput("\x1b[Z"); screen.handleInput("d");
  assert.deepEqual(actions, [1, -1]);
  assert.match(frame(screen, 160, 24), /拆分视图/);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /合并视图/);
  const heading = plain(screen.render(160)).split("\n")[0]!;
  screen.handleMouse(mouse(visibleWidth(heading.slice(0, heading.indexOf("[切换视图]"))), 0));
  assert.match(frame(screen, 160, 24), /拆分视图/);
  assert.ok(!heading.includes("切换范围"));
  assert.deepEqual(cycleScope({kind: "git", mode: "branch"}, 1, [], true), {kind: "turn", turn: undefined});
  assert.deepEqual(cycleScope({kind: "turn", turn: 12}, -1, [], false), {kind: "session"});
  const folders = new DiffScreen(ui, theme(), "会话累计", [patch("src/deep/a.ts", "old\n", "new\n")], () => {});
  assert.match(frame(folders, 160, 24).split("\n")[3]!, /▾ src\/deep/);
  folders.handleMouse(mouse(4, 3));
  assert.match(frame(folders, 160, 24).split("\n")[3]!, /▸ src\/deep/);
  folders.handleMouse(mouse(4, 3));
  assert.match(frame(folders, 160, 24).split("\n")[4]!, /a.ts/);
  ui.terminal.columns = 60;
  screen.handleInput("h"); frame(screen, 60, 24);
  screen.handleMouse(mouse(4, 2, {width: 60}));
  assert.match(frame(screen, 60, 24), /\+new/);
});

test("mouse scrolling and hit testing work through actual pi SGR overlay routing", () => {
  const terminal = new MemoryTerminal();
  terminal.rows = 10;
  const tui = new TuiAltScreen(terminal);
  tui.addChild({ render: () => ["CHAT"], invalidate() {} });
  tui.start();
  try {
    const files = Array.from({length: 30}, (_, i) => patch(`f${String(i).padStart(2, "0")}.txt`, "before\n", Array.from({length: 50}, (_, n) => `file ${i} line ${n}`).join("\n") + "\n"));
    const screen = new DiffScreen(tui, theme(), "会话累计", files, () => {});
    tui.showOverlay(screen, FULLSCREEN_OPTIONS.overlayOptions);
    tui.renderNow(true);
    terminal.input("\x1b[<0;3;5M"); terminal.input("\x1b[<0;3;5m"); tui.renderNow(true);
    assert.match(plain(tui.getScreenLines()), /file 1 line 0/);
    const before = plain(tui.getScreenLines());
    terminal.input("\x1b[<65;70;5M"); tui.renderNow(true);
    assert.notEqual(plain(tui.getScreenLines()), before);
    screen.handleMouse(mouse(3, 4, {type:"wheel", button:"none", wheelDelta: 10, height: 10}));
    tui.renderNow(true);
    assert.match(plain(tui.getScreenLines()), /f10.txt/);
    terminal.input("\x1b[<0;3;4M"); terminal.input("\x1b[<0;3;4m"); tui.renderNow(true);
    assert.match(plain(tui.getScreenLines()), /file 10 line 0/);
    terminal.columns = 60; terminal.resize(); tui.renderNow(true);
    screen.handleInput("h"); tui.renderNow(true);
    screen.handleMouse(mouse(3, 3, {type:"wheel", button:"none", wheelDelta: 5, width: 60, height: 10}));
    tui.renderNow(true);
    assert.ok(!plain(tui.getScreenLines()).includes("CHAT"));
  } finally { tui.stop(); }
});


test("soft wrapping preserves every space, CJK grapheme and original line number", () => {
  const text = "    abc    def      ";
  const width = 9;
  const view = new PatchDiff(patch("spaces.txt", null, text + "\n"));
  const count = view.rowCount(width, "unified");
  const lines = view.renderViewport(width, count, 0, "unified", theme()).map(stripTerminalSequences);
  const firstBody = lines.findIndex((line) => /^\s+1 \+/.test(line));
  assert.ok(firstBody > 0, "hunk headers may also wrap in tiny panes");
  assert.equal(count, firstBody + Math.ceil(text.length / 4));
  assert.equal(lines.slice(firstBody).map((line) => line.slice(5)).join("").slice(0, text.length), text);
  for (const line of lines.slice(firstBody + 1)) assert.match(line, /^\s{4}↳/);
  const unicode = "A👨‍👩‍👧‍👦e\u0301中🇨🇳Z";
  const wide = new PatchDiff(patch("unicode", null, unicode + "\n"));
  const wrapped = wide.renderViewport(8, wide.rowCount(8, "unified"), 0, "unified", theme()).map(stripTerminalSequences);
  const unicodeBody = wrapped.findIndex((line) => /^\s+1 \+/.test(line));
  assert.deepEqual(wrapped.slice(unicodeBody).map((line) => line.slice(5)), ["A👨‍👩‍👧‍👦", "e\u0301中", "🇨🇳Z"]);
  assert.ok(wrapped.every((line) => visibleWidth(line) === 8));
});

test("split wrapping aligns unequal sides; changed backgrounds fill only their own visual rows", () => {
  const old = "A".repeat(32);
  const next = "B".repeat(7);
  const view = new PatchDiff(patch("pair", old + "\ncontext\n", next + "\ncontext\n"));
  const width = 25;
  const count = view.rowCount(width, "split");
  for (const light of [false, true]) {
    const current = theme(light);
    const raw = view.renderViewport(width, count, 0, "split", current);
    const lines = raw.map(stripTerminalSequences);
    const context = lines.findIndex((line) => line.includes("context"));
    assert.ok(context > 2);
    assert.match(lines[1]!, /1 -A[^│]+│1 \+B/);
    assert.match(lines[2]!, /^\s+↳A/);
    assert.ok(!lines[2]!.slice(13).trim(), "short new side pads until the old side finishes");
    assert.match(lines[context]!, /2  context\s+│2  context/);
    assert.ok(raw[1]!.includes(current.getBgAnsi("toolSuccessBg")));
    assert.ok(raw[1]!.includes(current.getBgAnsi("toolErrorBg")));
    assert.ok(!raw[2]!.includes(current.getBgAnsi("toolSuccessBg")));
    assert.ok(!raw[context]!.includes(current.getBgAnsi("toolErrorBg")));
    assert.ok(raw.every((line) => visibleWidth(line) === width));
    const unified = view.renderViewport(80, view.rowCount(80, "unified"), 0, "unified", current);
    assert.ok(unified[1]!.startsWith(current.getBgAnsi("toolErrorBg")));
    assert.ok(unified[2]!.startsWith(current.getBgAnsi("toolSuccessBg")));
    assert.ok(unified[1]!.endsWith("\x1b[49m"));
  }
});

test("v and uppercase V toggle layout; unavailable splits explain why instead of silently ignoring input", () => {
  const ui = host();
  const preferences: string[] = [];
  const screen = new DiffScreen(ui, theme(), "Last turn", [patch("modified", "old\n", "new\n")], () => {}, {onViewChange: (view) => preferences.push(view)});
  frame(screen, 160, 24);
  screen.handleInput("V");
  assert.match(frame(screen, 160, 24), /合并视图/);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /拆分视图/);
  assert.deepEqual(preferences, ["unified", "split"]);
  ui.terminal.columns = 100;
  screen.handleInput("V");
  assert.match(frame(screen, 100, 24), /宽度不足/);
  assert.deepEqual(preferences, ["unified", "split"]);
  ui.terminal.columns = 160;
  assert.ok(!frame(screen, 160, 24).includes("宽度不足"));
  screen.setData("Last turn", [patch("added", null, "new\n")]);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /合并视图（新增\/删除文件）/);
  screen.setData("Last turn", []);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /没有可切换的文件/);
});

test("added and deleted files keep fixed unified controls through repeated keys and clicks", () => {
  for (const view of ["split", "unified"] as const) for (const width of [100, 160]) {
    const ui = host();
    ui.terminal.columns = width;
    const preferences: string[] = [];
    const screen = new DiffScreen(ui, theme(), "Last turn", [], () => {}, {view, onViewChange: (next) => preferences.push(next)});
    for (const file of [patch("added", null, "new\n"), patch("deleted", "old\n", null)]) {
      screen.setData("Last turn", [file]);
      const before = frame(screen, width, 24);
      assert.match(before, /\[仅合并视图\]/);
      assert.match(before, /合并视图（新增\/删除文件）/);
      assert.ok(!before.includes("v/V 合并/拆分"));
      const header = before.split("\n")[0]!;
      const button = visibleWidth(header.slice(0, header.indexOf("[仅合并视图]")));
      for (const key of ["v", "V", "v"]) {
        screen.handleInput(key);
        assert.equal(frame(screen, width, 24), before);
        screen.handleMouse(mouse(button, 0, {width}));
        assert.equal(frame(screen, width, 24), before);
      }
    }
    assert.deepEqual(preferences, []);
    ui.terminal.columns = 160;
    screen.setData("Last turn", [patch("modified", "old\n", "new\n")]);
    assert.match(frame(screen, 160, 24), new RegExp(view === "split" ? "拆分视图" : "合并视图"));
    screen.handleInput("v");
    assert.deepEqual(preferences, [view === "split" ? "unified" : "split"]);
  }
});

test("resize and layout changes anchor the visible source character and clamp the wrapped end", () => {
  const text = Array.from({length: 80}, (_, i) => String(i).padStart(2, "0") + "x").join("");
  const view = new PatchDiff(patch("anchor", "old\n", text + "\n"));
  view.rowCount(25, "unified");
  const oldTop = 5;
  const before = plain(view.renderViewport(25, 1, oldTop, "unified", theme()));
  const top = view.reflowTop(45, "unified", oldTop);
  const after = plain(view.renderViewport(45, 1, top, "unified", theme()));
  assert.ok(after.includes(before.slice(5).trim()), "wider continuation includes the previously visible source position");
  const splitTop = view.reflowTop(90, "split", top);
  const split = view.renderViewport(90, 2, splitTop, "split", theme()).map(stripTerminalSequences);
  assert.ok(split.map((line) => line.split("│")[1]!.slice(3)).join("").includes(before.slice(5).trim()));
  const ui = host();
  ui.terminal.rows = 8;
  const screen = new DiffScreen(ui, theme(), "Last turn", [patch("long", null, "X".repeat(1000) + "END\n")], () => {});
  frame(screen, 160, 8);
  screen.handleInput("\x1b[F");
  assert.match(frame(screen, 160, 8), /END/);
  screen.handleInput("\x1b[B");
  assert.match(frame(screen, 160, 8), /END/);
  screen.handleInput("\x1b[H");
  assert.ok(!frame(screen, 160, 8).includes("END"));
  assert.ok(!frame(screen, 160, 8).includes("[→]"));
});

test("a huge single ASCII line uses compact wrapping and only paints visible virtual chunks", () => {
  const text = "x".repeat(1_000_000) + "TAIL";
  const view = new PatchDiff(patch("huge", null, text + "\n"));
  const start = performance.now();
  const rows = view.rowCount(20, "unified");
  assert.equal(rows, 1 + Math.ceil(text.length / 15));
  const current = theme();
  let painted = 0;
  const fg = current.fg.bind(current);
  current.fg = (color, value) => { painted++; return fg(color, value); };
  const tail = view.renderViewport(20, 4, rows - 4, "unified", current);
  assert.match(plain(tail), /TAIL/);
  assert.ok(painted <= VIRTUAL_CHUNK_LINES);
  assert.deepEqual(view.renderViewport(20, 4, rows - 4, "unified", current), tail);
  assert.ok(performance.now() - start < 5000);
});
