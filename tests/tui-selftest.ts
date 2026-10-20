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
import { messages, type Language } from "../src/language.ts";
import { cycleScope, type DiffScope } from "../src/tui/scopes.ts";

function theme(light = false): Theme {
  return new Theme({
    accent: light ? "#0000ff" : "#00ffff", success: "#00ff00", error: "#ff0000",
    muted: light ? "#444444" : "#aaaaaa", borderMuted: "#555555", text: "", thinkingXhigh: "#aaaaaa",
  } as never, { selectedBg: light ? "#dbeafe" : "#264f78", toolSuccessBg: light ? "#dcfce7" : "#143322", toolErrorBg: light ? "#fee2e2" : "#3d1a1a" } as never, "truecolor");
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

test("l and L switch language in place while brackets focus the diff", () => {
  const ui = host();
  const languages: Language[] = [];
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
  const files = [patch("src/a.ts", text, text + "added\n"), patch("src/b.ts", text, text + "中文\n"), patch("other/c.ts", "a\n", "b\n")];
  const screen = new DiffScreen(ui, theme(), (language) => messages[language].session, files, () => {}, {
    onLanguageChange: (language) => languages.push(language),
  });
  screen.handleInput("[");
  screen.handleInput("j");
  screen.handleInput("]");
  screen.handleInput("v");
  screen.handleInput("\x1b[6~");
  screen.handleInput("[");
  // Collapse a directory while retaining the selected diff and its scroll position.
  screen.handleMouse(mouse(2, 3));
  const before = screen.render(160);
  assert.match(plain(before), /Session total/);
  assert.match(stripTerminalSequences(before.at(-1)!), /^l\/L 中文/);
  screen.handleInput("l");
  const chinese = screen.render(160);
  assert.match(plain(chinese), /会话累计/);
  assert.match(stripTerminalSequences(chinese.at(-1)!), /^l\/L English/);
  assert.deepEqual(chinese.slice(3, -1), before.slice(3, -1), "tree, selected source, focus and scrolled diff stay unchanged");
  screen.handleInput("L");
  assert.deepEqual(screen.render(160), before);
  screen.handleInput("]");
  assert.deepEqual(languages, ["zh-CN", "en"]);
  const focused = screen.render(160);
  screen.handleInput("\x1b[B");
  assert.notDeepEqual(screen.render(160).slice(3, -1), focused.slice(3, -1), "closing bracket focuses diff scrolling");
});

test("j/k follow bracket focus to navigate files or scroll the diff in narrow and wide layouts", () => {
  for (const language of ["en", "zh-CN"] as const) for (const width of [40, 160]) {
    const ui = host();
    ui.terminal.columns = width;
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("");
    const screen = new DiffScreen(ui, theme(), "Scope", [
      patch("src/a.txt", content, content + "a\n"),
      patch("src/b.txt", content, content + "b\n"),
      patch("root.txt", content, content + "root\n"),
    ], () => {}, { language });
    const assertFile = (name: string) => {
      screen.handleInput("]");
      assert.ok(stripTerminalSequences(screen.render(width)[1]!).includes(name));
      screen.handleInput("[");
    };
    assertFile("src/a.txt");
    screen.handleInput("k");
    assertFile("src/a.txt");
    screen.handleInput("j");
    assertFile("src/b.txt");
    screen.handleInput("j");
    assertFile("root.txt");
    screen.handleInput("j");
    assertFile("root.txt");
    screen.handleInput("[");
    screen.handleInput("k");
    assertFile("src/b.txt");
    screen.handleInput("k");
    screen.handleInput("[");
    screen.handleInput("\x1b[A");
    screen.handleInput("\r");
    assert.match(frame(screen, width, 24), /▸ src/);
    screen.handleInput("j");
    assertFile("src/b.txt");
    screen.handleInput("]");
    const beforeScroll = screen.render(width);
    screen.handleInput("j");
    assert.notDeepEqual(screen.render(width).slice(3, -1), beforeScroll.slice(3, -1), "] makes j scroll instead of changing files");
    assert.ok(stripTerminalSequences(screen.render(width)[1]!).includes("src/b.txt"));
    screen.handleInput("k");
    assert.deepEqual(screen.render(width), beforeScroll, "k restores the previous diff row without changing files");
    screen.handleInput("k");
    assert.deepEqual(screen.render(width), beforeScroll, "scrolling up clamps at the first row");
    screen.handleInput("\x1b[F");
    const bottom = screen.render(width);
    screen.handleInput("j");
    assert.deepEqual(screen.render(width), bottom, "scrolling down clamps at the last row without changing files");
    const beforeRemovedKeys = screen.render(width);
    for (const key of ["h", "n", "p"]) screen.handleInput(key);
    assert.deepEqual(screen.render(width), beforeRemovedKeys, "old bindings are removed");
    screen.setData("Empty", []);
    for (const key of ["j", "k", "[", "]"]) screen.handleInput(key);
    frame(screen, width, 24);
  }
});

test("both languages render honest placeholders, fixed layouts and correctly sized view buttons", () => {
  for (const language of ["en", "zh-CN"] as const) for (const light of [false, true]) {
    const text = messages[language];
    const cases: [FilePatch, string][] = [
      [{ ...patch("unavailable", "a", "b"), unavailable: true }, text.unavailable],
      [{ ...patch("binary", "a", "b"), binary: true }, text.binary],
      [{ ...patch("large", "a", "b"), tooLarge: true }, text.tooLarge],
      [{ ...patch("deleted", "a", null), baselineUnknown: true }, text.deletedUnknown],
      [{ ...patch("no-patch", "a", "b"), patch: "" }, text.noPatch],
      [{ ...patch("metadata", "a", "b"), patch: "diff --git a/metadata b/metadata\nold mode 100644\nnew mode 100755\n" }, text.noTextChanges],
      [{ ...patch("unknown", "a", "b"), baselineUnknown: true }, text.baselineUnknown],
      [{ ...patch("fallback", "a", "b"), cumulativeFallback: true }, text.cumulativeFallback],
    ];
    const ui = host();
    const screen = new DiffScreen(ui, theme(light), "Scope", [], () => {}, { language });
    assert.ok(frame(screen, 200, 24).includes(text.noChanges));
    for (const [file, expected] of cases) {
      screen.setData("Scope", [file]);
      assert.ok(frame(screen, 200, 24).includes(expected), `${language}: ${expected}`);
      screen.handleInput("L");
      screen.handleInput("L");
      assert.ok(frame(screen, 200, 24).includes(expected));
    }
    for (const width of [40, 89, 90, 160, 200]) {
      ui.terminal.columns = width;
      screen.setData("Scope", [patch("modified.ts", "old\n", "new\n")]);
      frame(screen, width, 24);
      const header = stripTerminalSequences(screen.render(width)[0]!);
      const start = visibleWidth(header.slice(0, header.indexOf(text.switchView)));
      if (width >= 160) {
        const before = frame(screen, width, 24);
        screen.handleMouse(mouse(start + visibleWidth(text.switchView) - 1, 0, { width }));
        const after = frame(screen, width, 24);
        assert.notEqual(after, before, "last column of translated button is clickable");
        screen.handleMouse(mouse(start + visibleWidth(text.switchView), 0, { width }));
        assert.equal(frame(screen, width, 24), after, "column after button does not toggle");
      }
      for (const file of [patch("added", null, "new\n"), patch("deleted", "old\n", null)]) {
        screen.setData("Scope", [file]);
        const before = frame(screen, width, 24);
        screen.handleInput("v");
        screen.handleInput("V");
        screen.handleMouse(mouse(45, 0, { width }));
        assert.equal(frame(screen, width, 24), before);
        if (width >= 160) assert.ok(before.includes(text.fixedUnified));
      }
    }
    ui.terminal.columns = 100;
    screen.setData("Scope", [patch("modified", "old\n", "new\n")]);
    screen.handleInput("v");
    assert.ok(frame(screen, 100, 24).includes(language === "en" ? "too narrow" : "宽度不足"));
    screen.handleInput("L");
    ui.terminal.columns = 200;
    const wide = frame(screen, 200, 24);
    assert.ok(!wide.includes("too narrow") && !wide.includes("宽度不足"));
  }
});

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
  assert.match(output, /A .*a.ts/);
  assert.match(output, /D .*b.ts/);
  assert.equal(view.selectedFile(), 2);
});

test("the complete screen preserves left-side A/D/M badges for clipped file names", () => {
  const files = [
    patch(`src/a-${"中文".repeat(30)}.ts`, null, "added\n"),
    patch("src/d-deleted.ts", "deleted\n", null),
    patch("src/m-modified.ts", "old\n", "new\n"),
  ];
  for (const light of [false, true]) for (const width of [40, 89, 90, 120, 160, 200]) {
    const ui = host();
    ui.terminal.columns = width;
    const screen = new DiffScreen(ui, theme(light), "Last turn", files, () => {});
    if (width < 90) screen.handleInput("[");
    frame(screen, width, 24);
    const treeWidth = width < 90 ? width : Math.min(40, Math.floor(width / 4)) - 1;
    const statuses = screen.render(width).map((line) => stripTerminalSequences(sliceByColumn(line, 0, treeWidth)))
      .flatMap((line) => /^(?:› |  )([AMD]) /.exec(line)?.[1] ?? []);
    assert.deepEqual(statuses, ["A", "D", "M"], `status column at width ${width}, light=${light}`);
  }
});

test("status badges stay left of clipped file names at a fixed column while resizing the tree", () => {
  const files = [
    patch(`src/a-${"中文".repeat(30)}.ts`, null, "added\n"),
    patch("src/d-deleted.ts", "deleted\n", null),
    patch("root-modified.ts", "old\n", "new\n"),
  ];
  for (const language of ["en", "zh-CN"] as const) for (const light of [false, true]) {
    const ui = host();
    const screen = new DiffScreen(ui, theme(light), "Scope", files, () => {}, { language });
    const check = (width: number, treeWidth: number) => {
      const rows = screen.render(width).map((line) => stripTerminalSequences(sliceByColumn(line, 0, treeWidth)));
      const badges = rows.flatMap((line) => /^(?:› |  )([AMD]) /.exec(line)?.[1] ?? []);
      assert.deepEqual(badges, ["A", "D", "M"]);
      for (const status of badges) {
        const line = rows.find((line) => line[2] === status)!;
        assert.equal(visibleWidth(line.slice(0, line.indexOf(status))), 2);
        assert.ok(line.indexOf(status) < line.indexOf("≡"));
      }
      frame(screen, width, 24);
    };
    check(160, 39);
    screen.handleMouse(mouse(39, 8, { type: "press" }));
    screen.handleMouse(mouse(79, 8, { type: "drag" }));
    check(160, 39);
    screen.handleMouse(mouse(1, 8, { type: "drag" }));
    check(160, 9);
    screen.handleMouse(mouse(1, 8, { type: "release" }));
    ui.terminal.columns = 40;
    screen.handleInput("[");
    check(40, 40);
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

test("scope totals include every file and update when the scope changes", () => {
  const files = [patch("a.txt", null, "one\ntwo\n"), patch("b.txt", "old\n", "new\n"), patch("c.txt", "gone\n", null)];
  const screen = new DiffScreen(host(), theme(), "Last turn", files, () => {});
  const header = () => screen.render(160)[0]!;
  assert.match(stripTerminalSequences(header()), /Last turn · 3 files\s+\+3 -2/);
  assert.ok(header().includes(theme().fg("success", "+3")));
  assert.ok(header().includes(theme().fg("error", "-2")));
  screen.handleInput("[");
  screen.handleInput("j");
  assert.match(stripTerminalSequences(header()), /\+3 -2/);
  for (const title of ["Session total", "Unstaged", "Uncommitted", "All branch changes"]) {
    screen.setData(title, [files[0]!]);
    assert.ok(stripTerminalSequences(header()).startsWith(`${title} · 1 file  +2 -0`));
  }
  screen.setData("Last turn", []);
  assert.match(stripTerminalSequences(header()), /0 files\s+\+0 -0/);
});

test("selected tree rows keep a full-width theme background across focus, navigation and mouse selection", () => {
  for (const light of [false, true]) for (const width of [40, 90, 160]) {
    const ui = host();
    ui.terminal.columns = width;
    const current = theme(light);
    const screen = new DiffScreen(ui, current, "Last turn", [patch("a.txt", null, "a\n"), patch("b.txt", "b\n", null)], () => {});
    const treeWidth = width < 90 ? width : Math.min(40, Math.floor(width / 4)) - 1;
    const selectedRows = () => {
      frame(screen, width, 24);
      return screen.render(width).map((line) => sliceByColumn(line, 0, treeWidth))
        .filter((line) => line.includes(current.getBgAnsi("selectedBg")));
    };
    if (width < 90) screen.handleInput("[");
    const assertSelected = (name: string, status: string) => {
      const rows = selectedRows();
      assert.equal(rows.length, 1);
      assert.equal(visibleWidth(rows[0]!), treeWidth);
      assert.match(stripTerminalSequences(rows[0]!), new RegExp(`› ${status} .*${name}`));
      const colored = rows[0]!.slice(rows[0]!.indexOf(current.getBgAnsi("selectedBg")) + current.getBgAnsi("selectedBg").length).split("\x1b[49m")[0]!;
      assert.equal(visibleWidth(colored), treeWidth, "selection background includes the status column");
    };
    assertSelected("a.txt", "A");
    screen.handleInput("[");
    assertSelected("a.txt", "A");
    screen.handleInput("\x1b[B");
    assertSelected("b.txt", "D");
    if (width >= 90) {
      screen.handleInput("]");
      assertSelected("b.txt", "D");
      screen.handleMouse(mouse(3, 3, {width}));
      assertSelected("a.txt", "A");
    }
  }
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
  assert.match(frame(screen, 160, 24), /Binary file changed/);
  screen.handleInput("[");
  screen.handleInput("j");
  assert.match(frame(screen, 160, 24), /No text changes/);
  screen.handleInput("j");
  assert.match(frame(screen, 160, 24), /10 MB limit/);
  screen.handleInput("j");
  assert.match(frame(screen, 160, 24), /Previous contents unknown/);
  assert.match(frame(new DiffScreen(ui, theme(), "Session", [], () => {}), 160, 24), /No file changes/);
  const unavailable = new DiffScreen(ui, theme(), "Session", [{ ...patch("unreadable", "old\n", "new\n"), unavailable: true }], () => {});
  assert.match(frame(unavailable, 160, 24), /File contents unavailable/);
  const fallback = new DiffScreen(ui, theme(), "Session", [{ ...patch("partial", "old\n", "new\n"), cumulativeFallback: true }], () => {});
  assert.match(frame(fallback, 160, 24), /Showing last turn only/);
  const deleted = new DiffScreen(ui, theme(), "Session", [{ ...patch("gone", "old\n", null), baselineUnknown: true }], () => {});
  assert.match(frame(deleted, 160, 24), /File deleted; previous contents unknown/);
});

test("keyboard layout/focus/navigation, CJK wrapping and resize never overflow", () => {
  const ui = host();
  let closed = 0;
  const preferences: string[] = [];
  const screen = new DiffScreen(ui, theme(), "Session", [
    patch("src/中文.ts", "old\n", "new\n"),
    patch("src/long.ts", "old\n", "长".repeat(100) + "TAIL\n"),
  ], () => { closed++; }, { onViewChange: (view) => preferences.push(view) });
  assert.match(frame(screen, 160, 24), /Split view/);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /Unified view/);
  assert.deepEqual(preferences, ["unified"]);
  screen.handleInput("[");
  screen.handleInput("\x1b[B");
  assert.match(frame(screen, 160, 24), /中文.ts/);
  screen.handleInput("k");
  screen.handleInput("]");
  assert.match(frame(screen, 160, 24), /long.ts/);
  assert.match(frame(screen, 160, 24), /TAIL/);
  for (const width of [140, 100, 89, 40, 9, 3, 1, 160]) {
    ui.terminal.columns = width;
    ui.terminal.rows = Math.min(24, width);
    frame(screen, width, ui.terminal.rows);
    screen.handleInput("[");
    frame(screen, width, ui.terminal.rows);
    screen.handleInput("]");
  }
  screen.handleInput("q");
  assert.equal(closed, 1);
  screen.handleInput("\x1b");
  assert.equal(closed, 2);
});

test("compact diff uses the full width while wide layouts keep their insets", () => {
  const file = patch("file.txt", "old ".repeat(320) + "OLD_END\n", "新内容 ".repeat(320) + "NEW_END\n");
  for (const light of [false, true]) {
    const ui = host();
    const current = theme(light);
    const screen = new DiffScreen(ui, current, "Last turn", [file], () => {}, { view: "unified" });
    for (const width of [40, 87, 88, 89, 90, 160, 89, 40]) {
      ui.terminal.columns = width;
      const lines = screen.render(width);
      const start = width < 90 ? 0 : Math.min(40, Math.floor(width / 4)) + 2;
      const available = width < 90 ? width : width - start - 2;
      const expected = new PatchDiff(file).renderViewport(available, 20, 0, "unified", current);
      assert.equal(plain(lines.slice(3, 23).map((line) => sliceByColumn(line, start, available))), plain(expected));
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      if (width < 90) {
        assert.match(stripTerminalSequences(lines[1]!), /^file.txt/);
        screen.handleInput("[");
        assert.match(frame(screen, width, 24), /M ≡ file.txt/);
        screen.handleInput("]");
        screen.handleMouse(mouse(0, 3, { width, type: "wheel", wheelDelta: 3 }));
        const scrolled = screen.render(width);
        assert.equal(plain(scrolled.slice(3, 23)), plain(new PatchDiff(file).renderViewport(width, 20, 3, "unified", current)));
        screen.handleInput("\x1b[H");
        screen.render(width);
      }
    }
  }
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

const treePaneWidth = (line: string) => {
  const text = stripTerminalSequences(line);
  const divider = text.indexOf("│");
  assert.ok(divider >= 0);
  return visibleWidth(text.slice(0, divider)) + 1;
};

test("divider hover highlights and explains dragging without changing selection, focus or scroll", () => {
  for (const language of ["en", "zh-CN"] as const) for (const light of [false, true]) {
    const ui = host();
    const current = theme(light);
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("");
    const files = [patch("a.txt", content, content + "new\n")];
    const screen = new DiffScreen(ui, current, "Scope", files, () => {}, { language });
    screen.handleInput("j");
    const initial = screen.render(160);
    const x = treePaneWidth(initial[1]!) - 1;
    const expected = language === "en" ? "Drag to resize" : "拖动调整宽度";
    assert.equal(screen.handleMouse(mouse(x, 8, { type: "move", button: "none" })).render, true);
    const hovered = screen.render(160);
    assert.ok(plain(hovered).includes(expected));
    assert.ok(hovered[1]!.includes(current.bg("selectedBg", current.fg("accent", "│"))));
    assert.equal(plain(hovered.slice(3, -1)), plain(initial.slice(3, -1)));
    assert.ok(plain(hovered).includes(language === "en" ? "Focus: Diff" : "焦点：内容"));
    assert.equal(screen.handleMouse(mouse(x, 9, { type: "move", button: "none" })).render, false, "movement along the divider does not redraw identical feedback");
    screen.handleInput("l");
    assert.ok(plain(screen.render(160)).includes(language === "en" ? "拖动调整宽度" : "Drag to resize"));
    screen.handleInput("l");
    assert.equal(screen.handleMouse(mouse(x + 3, 9, { type: "move", button: "none" })).render, true);
    assert.deepEqual(screen.render(160), initial, "leaving the divider restores the original frame");
    screen.handleMouse(mouse(x, 0, { type: "move", button: "none" }));
    assert.deepEqual(screen.render(160), initial, "the header is not a drag target");
    screen.handleMouse(mouse(x, 23, { type: "move", button: "none" }));
    assert.deepEqual(screen.render(160), initial, "the footer is not a drag target");
    screen.handleMouse(mouse(x, 8, { type: "move", button: "none" }));
    ui.terminal.columns = 120;
    assert.ok(!plain(screen.render(120)).includes(expected), "a moved divider does not leave stale hover feedback");
    ui.terminal.columns = 80;
    assert.ok(!plain(screen.render(80)).includes(expected));
    ui.terminal.columns = 160;
    screen.setData("Empty", []);
    assert.ok(!plain(screen.render(160)).includes(expected));
  }
});

test("real pi mouse motion shows and clears the divider hint before and after dragging", () => {
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  const screen = new DiffScreen(tui, theme(), "Scope", [patch("a.txt", "old\n", "new\n")], () => {});
  tui.start();
  try {
    tui.showOverlay(screen, FULLSCREEN_OPTIONS.overlayOptions);
    tui.renderNow(true);
    terminal.input("\x1b[<35;40;8M");
    tui.renderNow();
    assert.match(plain(tui.getScreenLines()), /Drag to resize/);
    terminal.input("\x1b[<0;40;8M");
    terminal.input("\x1b[<32;35;8M");
    terminal.input("\x1b[<0;35;8m");
    tui.renderNow();
    assert.equal(treePaneWidth(tui.getScreenLines()[1]!), 35);
    assert.match(plain(tui.getScreenLines()), /Drag to resize/, "the pointer remains over the resized divider after release");
    terminal.input("\x1b[<35;90;8M");
    tui.renderNow();
    assert.ok(!plain(tui.getScreenLines()).includes("Drag to resize"));
    assert.equal(treePaneWidth(tui.getScreenLines()[1]!), 35);
  } finally { tui.stop(); }
});

test("divider dragging clamps pane widths without changing focus, selection, scroll or view preferences", () => {
  for (const language of ["en", "zh-CN"] as const) for (const light of [false, true]) for (const width of [90, 120, 160, 240]) {
    const ui = host();
    ui.terminal.columns = width;
    const content = Array.from({ length: 80 }, (_, i) => `line ${i}\n`).join("");
    const files = [patch("a.txt", content, content + "a\n"), patch("b.txt", content, content + "b\n")];
    const views: string[] = [];
    const screen = new DiffScreen(ui, theme(light), "Scope", files, () => {}, { language, view: "unified", onViewChange: (view) => views.push(view) });
    screen.handleInput("[");
    screen.handleInput("j");
    screen.handleInput("]");
    for (let i = 0; i < 5; i++) screen.handleInput("j");
    screen.handleInput("[");
    const render = () => screen.render(width).map(stripTerminalSequences);
    const treeWidth = () => treePaneWidth(render()[1]!);
    const initial = treeWidth();
    assert.equal(initial, Math.min(40, Math.floor(width / 4)), "the automatic default obeys the narrower maximum");
    assert.equal(screen.handleMouse(mouse(initial - 1, 8, { width, type: "press" })).capture, true);
    screen.handleMouse(mouse(width * 2, 8, { width, type: "drag" }));
    const max = Math.floor(width / 4);
    assert.equal(treeWidth(), max);
    assert.ok(width - treeWidth() - 4 >= 40);
    assert.ok(render()[1]!.includes("b.txt"));
    assert.match(render()[3]!, /line 4/, "dragging preserves the diff scroll anchor");
    assert.ok(render().at(-1)!.includes(language === "en" ? "Focus: Files" : "焦点：文件树"));
    screen.handleMouse(mouse(1, 8, { width, type: "drag" }));
    assert.equal(treeWidth(), 10);
    screen.handleMouse(mouse(1, 8, { width, type: "release" }));
    screen.handleMouse(mouse(100, 8, { width, type: "drag" }));
    assert.equal(treeWidth(), 10, "motion after release must not keep resizing");
    screen.handleMouse(mouse(2, 3, { width, type: "press" }));
    screen.handleMouse(mouse(2, 3, { width, type: "release" }));
    screen.handleMouse(mouse(2, 3, { width, type: "click" }));
    assert.ok(render()[1]!.includes("a.txt"), "normal file clicks still work after dragging");
    assert.deepEqual(views, []);
    frame(screen, width, 24);
  }
});

test("two-column resize target resets on a double click and uses the final release position", () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    for (const light of [false, true]) {
      const ui = host();
      const current = theme(light);
      const screen = new DiffScreen(ui, current, "Scope", [patch("a.txt", "old\n", "new\n")], () => {});
      const treeWidth = () => treePaneWidth(screen.render(160)[1]!);
      assert.notEqual(screen.handleMouse(mouse(38, 8, { type: "press" })).capture, true, "tree content remains outside the handle");
      screen.handleMouse(mouse(40, 8, { type: "move", button: "none" }));
      assert.ok(screen.render(160)[1]!.includes(current.bg("selectedBg", current.fg("accent", "│"))));
      assert.equal(screen.handleMouse(mouse(40, 8, { type: "press" })).capture, true, "the second column captures drags too");
      screen.handleMouse(mouse(24, 8, { type: "drag" }));
      assert.equal(treeWidth(), 25);
      screen.handleMouse(mouse(29, 8, { type: "release" }));
      assert.equal(treeWidth(), 30, "release can contain the last movement");
      screen.handleMouse(mouse(29, 8, { type: "press" }));
      screen.handleMouse(mouse(29, 8, { type: "release" }));
      screen.handleMouse(mouse(29, 8));
      assert.equal(treeWidth(), 30, "one click leaves the width unchanged, including immediately after a drag");
      now += 299;
      screen.handleMouse(mouse(30, 8, { type: "press" }));
      assert.equal(treeWidth(), 40);
      screen.handleMouse(mouse(30, 8, { type: "release" }));
      screen.handleMouse(mouse(30, 8));
      assert.equal(treeWidth(), 40, "a reset consumes the synthetic click");
      ui.terminal.columns = 120;
      assert.equal(treePaneWidth(screen.render(120)[1]!), 30, "reset restores automatic sizing instead of pinning the old default");
      ui.terminal.columns = 160;
      screen.handleMouse(mouse(39, 8, { type: "press" }));
      screen.handleMouse(mouse(34, 8, { type: "drag" }));
      screen.handleMouse(mouse(34, 8, { type: "release" }));
      now += 301;
      for (let i = 0; i < 2; i++) {
        screen.handleMouse(mouse(34, 8, { type: "press" }));
        screen.handleMouse(mouse(34, 8, { type: "release" }));
        screen.handleMouse(mouse(34, 8));
        now += 301;
      }
      assert.equal(treeWidth(), 35, "clicks outside the double-click interval do not reset");
    }
  } finally { Date.now = originalNow; }
});

test("dragging to the left edge hides the tree and preserves selection, scroll and temporary width", () => {
  for (const language of ["en", "zh-CN"] as const) for (const width of [90, 160, 240]) {
    const ui = host();
    ui.terminal.columns = width;
    const content = Array.from({ length: 80 }, (_, i) => `line ${i}\n`).join("");
    const files = [patch("a.txt", content, content + "a\n"), patch("b.txt", content, content + "b\n")];
    const screen = new DiffScreen(ui, theme(), "Scope", files, () => {}, { language, view: "unified" });
    const render = () => screen.render(ui.terminal.columns);
    const show = language === "en" ? "[Show files]" : "[展开文件树]";
    screen.handleInput("[");
    screen.handleInput("j");
    screen.handleInput("]");
    for (let i = 0; i < 5; i++) screen.handleInput("j");
    const startWidth = treePaneWidth(render()[1]!);
    screen.handleMouse(mouse(startWidth, 8, { width, type: "press" }));
    for (const x of [19, 14, 9, 1]) {
      screen.handleMouse(mouse(x, 8, { width, type: "drag" }));
      assert.equal(treePaneWidth(render()[1]!), Math.max(10, x + 1), "leftward dragging narrows the visible tree before reaching the edge");
      assert.ok(!plain(render()).startsWith(show), "shrinking below 20 columns does not close the tree");
    }
    screen.handleMouse(mouse(0, 8, { width, type: "drag" }));
    assert.ok(plain(render()).startsWith(show));
    assert.ok(!stripTerminalSequences(render()[1]!).includes("│"));
    assert.match(stripTerminalSequences(render()[1]!), /b.txt/);
    assert.match(stripTerminalSequences(render()[3]!), /line 4/);
    assert.ok(plain(render()).includes(language === "en" ? "Focus: Diff" : "焦点：内容"));
    screen.handleMouse(mouse(14, 8, { width, type: "drag" }));
    assert.equal(treePaneWidth(render()[1]!), 15, "the same captured drag can reopen the tree");
    screen.handleMouse(mouse(-10, 8, { width, type: "release" }));
    assert.ok(plain(render()).startsWith(show));
    screen.handleMouse(mouse(60, 8, { width, type: "drag" }));
    assert.ok(plain(render()).startsWith(show), "release ends capture even while collapsed");
    screen.handleInput("j");
    assert.match(stripTerminalSequences(render()[1]!), /b.txt/, "j scrolls the diff instead of changing a hidden selection");
    assert.match(stripTerminalSequences(render()[3]!), /line 5/);
    screen.handleMouse(mouse(1, 0, { width, type: "press" }));
    screen.handleMouse(mouse(1, 0, { width, type: "release" }));
    screen.handleMouse(mouse(1, 0, { width }));
    assert.equal(treePaneWidth(render()[1]!), 15);
    screen.handleMouse(mouse(14, 8, { width, type: "press" }));
    screen.handleMouse(mouse(0, 8, { width, type: "drag" }));
    screen.handleMouse(mouse(0, 8, { width, type: "release" }));
    screen.setData("Loading", []);
    assert.ok(!plain(render()).includes(show));
    screen.setData("Session", files);
    assert.ok(plain(render()).startsWith(show), "collapse survives scope changes");
    ui.terminal.columns = 80;
    frame(screen, 80, 24);
    screen.handleInput("[");
    assert.ok(!plain(render()).includes(show), "keyboard recovery also works in the narrow tree page");
    ui.terminal.columns = width;
    assert.equal(treePaneWidth(render()[1]!), 15);
    assert.equal(treePaneWidth(new DiffScreen(ui, theme(), "Scope", files, () => {}).render(width)[1]!), startWidth, "a new screen resets collapse and width");
    frame(screen, width, 24);
  }
});

test("real pi SGR dragging collapses the tree and both recovery controls work without exposing chat", () => {
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  const views: string[] = [];
  const files = [patch("a.txt", "old\n", "new\n")];
  const screen = new DiffScreen(tui, theme(), "Scope", files, () => {}, { onViewChange: (view) => views.push(view) });
  tui.addChild({ render: () => ["UNDERLYING CHAT"] });
  tui.start();
  try {
    tui.showOverlay(screen, FULLSCREEN_OPTIONS.overlayOptions);
    tui.renderNow(true);
    terminal.input("\x1b[<0;41;8M");
    for (const [position, width] of [[20, 20], [15, 15], [2, 10]]) {
      terminal.input(`\x1b[<32;${position};8M`);
      tui.renderNow();
      assert.equal(treePaneWidth(tui.getScreenLines()[1]!), width);
      assert.ok(!plain(tui.getScreenLines()).startsWith("[Show files]"), "leftward motion keeps the tree visible before the edge");
    }
    terminal.input("\x1b[<32;1;8M");
    tui.renderNow();
    assert.match(plain(tui.getScreenLines()), /^\[Show files\]/);
    terminal.input("\x1b[<0;1;8m");
    tui.renderNow();
    const header = stripTerminalSequences(tui.getScreenLines()[0]!);
    const toggle = header.indexOf("[Switch view]");
    for (const suffix of ["M", "m"]) terminal.input(`\x1b[<0;${toggle + 1};1${suffix}`);
    tui.renderNow();
    assert.deepEqual(views, ["unified"], "the view toggle still uses its shifted header position");
    for (const suffix of ["M", "m"]) terminal.input(`\x1b[<0;2;1${suffix}`);
    tui.renderNow();
    assert.equal(treePaneWidth(tui.getScreenLines()[1]!), 10);
    terminal.input("\x1b[<0;10;8M");
    terminal.input("\x1b[<32;1;8M");
    terminal.input("\x1b[<0;1;8m");
    tui.renderNow();
    terminal.input("[");
    tui.renderNow();
    assert.equal(treePaneWidth(tui.getScreenLines()[1]!), 10);
    assert.ok(!plain(tui.getScreenLines()).includes("UNDERLYING CHAT"));
    assert.equal(tui.getFocusedComponent(), screen);
  } finally { tui.stop(); }
});

test("keyboard reopening survives delayed divider drags and releases through the real pi overlay", () => {
  for (const language of ["en", "zh-CN"] as const) for (const late of ["drag", "release"] as const) {
    const terminal = new MemoryTerminal();
    const tui = new TuiAltScreen(terminal);
    const files = [patch("a.txt", "old\n", "new\n"), patch("b.txt", "old\n", "new\n")];
    const screen = new DiffScreen(tui, theme(), "Scope", files, () => {}, { language });
    tui.addChild({ render: () => ["UNDERLYING CHAT"] });
    tui.start();
    try {
      tui.showOverlay(screen, FULLSCREEN_OPTIONS.overlayOptions);
      terminal.input("[");
      terminal.input("j");
      tui.renderNow(true);
      terminal.input("\x1b[<0;40;8M");
      terminal.input("\x1b[<32;1;8M");
      tui.renderNow();
      assert.ok(plain(tui.getScreenLines()).startsWith(messages[language].showFiles));
      // The terminal can deliver the end of a drag after keyboard input.
      terminal.input("[");
      tui.renderNow();
      assert.equal(treePaneWidth(tui.getScreenLines()[1]!), 40, "the keyboard first reopens the tree");
      terminal.input(late === "drag" ? "\x1b[<32;1;8M" : "\x1b[<0;1;8m");
      tui.renderNow();
      assert.equal(treePaneWidth(tui.getScreenLines()[1]!), 40, "the old gesture cannot collapse it again");
      if (late === "drag") terminal.input("\x1b[<0;1;8m");
      tui.renderNow();
      assert.equal(treePaneWidth(tui.getScreenLines()[1]!), 40);
      assert.match(stripTerminalSequences(tui.getScreenLines()[1]!), /b.txt/);
      assert.ok(plain(tui.getScreenLines()).includes(language === "en" ? "Focus: Files" : "焦点：文件树"));
      assert.ok(!plain(tui.getScreenLines()).includes("UNDERLYING CHAT"));
      terminal.input("\x1b[<0;40;8M");
      terminal.input("\x1b[<32;20;8M");
      terminal.input("\x1b[<0;20;8m");
      tui.renderNow();
      assert.equal(treePaneWidth(tui.getScreenLines()[1]!), 20, "a fresh press can start a new drag");
    } finally { tui.stop(); }
    assert.equal(terminal.stopped, true);
  }
});

test("collapsed added/deleted files keep fixed unified controls and saved view preferences", () => {
  for (const language of ["en", "zh-CN"] as const) for (const deleted of [false, true]) {
    const ui = host();
    const views: string[] = [];
    const screen = new DiffScreen(ui, theme(), "Scope", [patch("a.txt", deleted ? "old\n" : null, deleted ? null : "new\n")], () => {}, {
      language, view: "split", onViewChange: (view) => views.push(view),
    });
    screen.render(160);
    screen.handleMouse(mouse(39, 8, { type: "press" }));
    screen.handleMouse(mouse(0, 8, { type: "drag" }));
    screen.handleMouse(mouse(0, 8, { type: "release" }));
    const collapsed = screen.render(160);
    assert.ok(plain(collapsed).includes(messages[language].unifiedOnly));
    screen.handleInput("v");
    screen.handleInput("V");
    assert.deepEqual(screen.render(160), collapsed);
    screen.handleMouse(mouse(1, 0, { type: "press" }));
    screen.handleMouse(mouse(1, 0, { type: "release" }));
    screen.handleMouse(mouse(1, 0));
    assert.equal(treePaneWidth(screen.render(160)[1]!), 40);
    assert.deepEqual(views, []);
  }
});

test("divider width survives scope and viewport changes only within one screen, and cancelled gestures stay cancelled", () => {
  const ui = host();
  ui.terminal.columns = 240;
  const files = [patch("a.txt", "old\n", "new\n")];
  const screen = new DiffScreen(ui, theme(), "Scope", files, () => {});
  const treeWidth = () => treePaneWidth(screen.render(ui.terminal.columns)[1]!);
  for (const [y, button] of [[0, "left"], [23, "left"], [8, "right"]] as const) {
    assert.notEqual(screen.handleMouse(mouse(39, y, { width: 240, type: "press", button })).capture, true);
    screen.handleMouse(mouse(100, 8, { width: 240, type: "drag", button }));
    assert.equal(treeWidth(), 40);
  }
  screen.handleMouse(mouse(39, 8, { width: 240, type: "press" }));
  screen.handleMouse(mouse(119, 8, { width: 240, type: "drag" }));
  assert.equal(treeWidth(), 60);
  ui.terminal.columns = 120;
  assert.equal(treeWidth(), 30);
  ui.terminal.columns = 240;
  assert.equal(treeWidth(), 60, "a temporary shrink does not erase the requested width");
  screen.handleMouse(mouse(119, 8, { width: 240, type: "release" }));
  screen.setData("Session total", files);
  assert.equal(treeWidth(), 60);
  const reopened = new DiffScreen(ui, theme(), "Scope", files, () => {});
  assert.equal(treePaneWidth(reopened.render(240)[1]!), 40);
  screen.handleMouse(mouse(59, 8, { width: 240, type: "press" }));
  ui.terminal.columns = 80;
  frame(screen, 80, 24);
  ui.terminal.columns = 240;
  screen.handleMouse(mouse(39, 8, { width: 240, type: "drag" }));
  assert.equal(treeWidth(), 60, "entering the narrow single-pane layout cancels the drag");
  screen.handleMouse(mouse(59, 8, { width: 240, type: "press" }));
  screen.setData("Loading", []);
  frame(screen, 240, 24);
  screen.setData("Next scope", files);
  screen.handleMouse(mouse(39, 8, { width: 240, type: "drag" }));
  assert.equal(treeWidth(), 60, "loading another scope cancels capture state without losing width");
});

test("real pi overlay captures divider drags across resize and releases them without selecting a file", () => {
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal);
  const files = [patch("a.txt", "old\n", "new\n"), patch("b.txt", "old\n", "new\n")];
  const views: string[] = [];
  const screen = new DiffScreen(tui, theme(), "Scope", files, () => {}, { onViewChange: (view) => views.push(view) });
  tui.addChild({ render: () => ["UNDERLYING CHAT"] });
  const treeWidth = () => treePaneWidth(tui.getScreenLines()[1]!);
  tui.start();
  try {
    tui.showOverlay(screen, FULLSCREEN_OPTIONS.overlayOptions);
    terminal.input("[");
    tui.renderNow(true);
    for (const suffix of ["M", "m"]) terminal.input(`\x1b[<0;40;6${suffix}`);
    tui.renderNow(true);
    assert.match(stripTerminalSequences(tui.getScreenLines().at(-1)!), /Focus: Files/);
    terminal.input("\x1b[<0;40;6M");
    terminal.input("\x1b[<0;40;6m");
    terminal.input("\x1b[<0;40;6M");
    terminal.input("\x1b[<32;71;6M");
    tui.renderNow(true);
    assert.equal(treeWidth(), 40);
    assert.match(plain(tui.getScreenLines()), /Split view/);
    terminal.columns = 120;
    terminal.resize();
    tui.renderNow(true);
    terminal.input("\x1b[<32;200;6M");
    terminal.input("\x1b[<0;200;6m");
    terminal.columns = 160;
    terminal.resize();
    tui.renderNow(true);
    assert.equal(treeWidth(), 30, "captured bounds from before resize cannot override current viewport limits");
    terminal.input("\x1b[<35;100;6M");
    for (const suffix of ["M", "m"]) terminal.input(`\x1b[<0;3;5${suffix}`);
    tui.renderNow(true);
    assert.equal(treeWidth(), 30);
    assert.match(stripTerminalSequences(tui.getScreenLines()[1]!), /b.txt/);
    assert.equal(tui.getFocusedComponent(), screen);
    assert.ok(!plain(tui.getScreenLines()).includes("UNDERLYING CHAT"));
    assert.deepEqual(views, []);
  } finally { tui.stop(); }
  assert.equal(terminal.stopped, true);
});

test("bracket keys route through the pi overlay with a visible focus label and matching j/k behavior", () => {
  for (const language of ["en", "zh-CN"] as const) for (const width of [40, 160]) for (const light of [false, true]) {
    const terminal = new MemoryTerminal();
    terminal.columns = width;
    terminal.rows = 12;
    const tui = new TuiAltScreen(terminal);
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("");
    const files = [patch("a.txt", "old\n", content), patch("b.txt", "old\n", content)];
    const screen = new DiffScreen(tui, theme(light), "Scope", files, () => {}, { language });
    const footer = () => stripTerminalSequences(tui.getScreenLines().at(-1)!);
    const treeLabel = language === "en" ? "Focus: Files" : "焦点：文件树";
    const diffLabel = language === "en" ? "Focus: Diff" : "焦点：内容";
    tui.start();
    try {
      tui.showOverlay(screen, FULLSCREEN_OPTIONS.overlayOptions);
      for (const [left, right] of [["[", "]"], ["\x1b[91;1u", "\x1b[93;1u"], ["\x1b[27;1;91~", "\x1b[27;1;93~"]]) {
        screen.setData("Scope", files);
        tui.renderNow(true);
        assert.ok(footer().includes(diffLabel));
        const initial = tui.getScreenLines();
        terminal.input("j");
        tui.renderNow(true);
        assert.match(stripTerminalSequences(tui.getScreenLines()[1]!), /a.txt/);
        assert.notDeepEqual(tui.getScreenLines().slice(3, -1), initial.slice(3, -1));
        terminal.input("k");
        tui.renderNow(true);
        assert.deepEqual(tui.getScreenLines(), initial, "j/k scroll in the default diff focus");
        terminal.input(left);
        tui.renderNow(true);
        assert.ok(footer().includes(treeLabel), "focus feedback remains visible without ANSI colors, even at 40 columns");
        terminal.input("j");
        terminal.input(right);
        tui.renderNow(true);
        assert.ok(footer().includes(diffLabel));
        assert.match(stripTerminalSequences(tui.getScreenLines()[1]!), /b.txt/);
        const beforeScroll = tui.getScreenLines();
        terminal.input("j");
        tui.renderNow(true);
        assert.match(stripTerminalSequences(tui.getScreenLines()[1]!), /b.txt/);
        assert.notDeepEqual(tui.getScreenLines().slice(3, -1), beforeScroll.slice(3, -1));
        terminal.input("k");
        tui.renderNow(true);
        assert.deepEqual(tui.getScreenLines(), beforeScroll);
        assert.equal(tui.getFocusedComponent(), screen);
      }
      if (width >= 90) {
        terminal.input("\x1b[<0;3;4M");
        terminal.input("\x1b[<0;3;4m");
        tui.renderNow(true);
        assert.ok(footer().includes(treeLabel));
        terminal.input("j");
        terminal.input("\x1b[<0;70;4M");
        terminal.input("\x1b[<0;70;4m");
        tui.renderNow(true);
        assert.ok(footer().includes(diffLabel));
        assert.match(stripTerminalSequences(tui.getScreenLines()[1]!), /b.txt/);
        const beforeScroll = tui.getScreenLines();
        terminal.input("j");
        tui.renderNow(true);
        assert.match(stripTerminalSequences(tui.getScreenLines()[1]!), /b.txt/);
        assert.notDeepEqual(tui.getScreenLines().slice(3, -1), beforeScroll.slice(3, -1), "j follows mouse focus too");
      }
    } finally { tui.stop(); }
    assert.equal(terminal.stopped, true);
  }
});

test("scope keys are separate from layout; mouse changes layout, directories and narrow files", () => {
  const ui = host();
  const actions: number[] = [];
  const screen = new DiffScreen(ui, theme(), "会话累计", [patch("a.txt", "old\n", "new\n")], () => {}, { onScopeChange: (direction) => actions.push(direction) });
  screen.handleInput("\t"); screen.handleInput("\x1b[Z"); screen.handleInput("d");
  assert.deepEqual(actions, [1, -1]);
  assert.match(frame(screen, 160, 24), /Split view/);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /Unified view/);
  const heading = plain(screen.render(160)).split("\n")[0]!;
  screen.handleMouse(mouse(visibleWidth(heading.slice(0, heading.indexOf("[Switch view]"))), 0));
  assert.match(frame(screen, 160, 24), /Split view/);
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
  screen.handleInput("["); frame(screen, 60, 24);
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
    screen.handleInput("["); tui.renderNow(true);
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
  assert.match(frame(screen, 160, 24), /Unified view/);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /Split view/);
  assert.deepEqual(preferences, ["unified", "split"]);
  ui.terminal.columns = 100;
  screen.handleInput("V");
  assert.match(frame(screen, 100, 24), /too narrow/);
  assert.deepEqual(preferences, ["unified", "split"]);
  ui.terminal.columns = 160;
  assert.ok(!frame(screen, 160, 24).includes("too narrow"));
  screen.setData("Last turn", [patch("added", null, "new\n")]);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /Unified view \(added\/deleted file\)/);
  screen.setData("Last turn", []);
  screen.handleInput("v");
  assert.match(frame(screen, 160, 24), /No file to switch views/);
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
      assert.match(before, /\[Unified only\]/);
      assert.match(before, /Unified view \(added\/deleted file\)/);
      assert.ok(!before.includes("v/V Unified/Split"));
      const header = before.split("\n")[0]!;
      const button = visibleWidth(header.slice(0, header.indexOf("[Unified only]")));
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
    assert.match(frame(screen, 160, 24), new RegExp(view === "split" ? "Split view" : "Unified view"));
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
