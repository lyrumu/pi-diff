import { matchesKey, visibleWidth, type Component, type OverlayOptions, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FilePatch } from "../diff-engine.ts";
import { FileTree } from "./file-tree.ts";
import { PatchDiff, type DiffView } from "./patch-diff.ts";
import { displayText, fit, type TuiHost } from "./text.ts";

export const MIN_SPLIT_WIDTH = 100;
export const FILE_TREE_MIN_WIDTH = 30;
export const FILE_TREE_MAX_WIDTH = 40;
export const FILE_HEADER_HEIGHT = 2;
export const FULLSCREEN_OPTIONS = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } satisfies OverlayOptions,
} as const;

export interface DiffScreenPreferences {
  view?: DiffView;
  onViewChange?: (view: DiffView) => void;
  emptyMessage?: string;
  notice?: string;
  onScopeChange?: (direction: 1 | -1) => void;
}

/** Selected-file view on a fullscreen overlay; all data comes from FilePatch[]. */
export class DiffScreen implements Component {
  private readonly host: TuiHost;
  private readonly theme: Theme;
  private title: string;
  private files: readonly FilePatch[];
  private readonly close: () => void;
  private readonly preferences: DiffScreenPreferences;
  private tree: FileTree;
  private emptyMessage: string | undefined;
  private notice: string | undefined;
  private selected: number | undefined;
  private patch: PatchDiff | undefined;
  private focus: "tree" | "diff" = "diff";
  private viewOverride: DiffView | undefined;
  private top = 0;
  private viewButton = 0;
  private viewHint: string | undefined;

  constructor(host: TuiHost, theme: Theme, title: string, files: readonly FilePatch[], close: () => void, preferences: DiffScreenPreferences = {}) {
    this.host = host;
    this.theme = theme;
    this.title = title;
    this.files = files;
    this.close = close;
    this.preferences = preferences;
    this.emptyMessage = preferences.emptyMessage;
    this.notice = preferences.notice;
    this.viewOverride = preferences.view;
    this.tree = new FileTree(files);
    this.select(this.tree.selectedFile());
  }

  /** Replace the source inside the existing overlay; never expose the chat between scopes. */
  setData(title: string, files: readonly FilePatch[], status: { emptyMessage?: string; notice?: string } = {}): void {
    this.title = title;
    this.files = files;
    this.emptyMessage = status.emptyMessage;
    this.notice = status.notice;
    this.tree = new FileTree(files);
    this.selected = undefined;
    this.patch = undefined;
    this.top = 0;
    this.focus = "diff";
    this.viewHint = undefined;
    this.select(this.tree.selectedFile());
    this.host.requestRender();
  }

  private select(index: number | undefined): void {
    if (index === undefined || index === this.selected) return;
    const file = this.files[index];
    if (!file) return;
    this.selected = index;
    this.patch = new PatchDiff(file);
    this.top = 0;
    this.viewHint = undefined;
  }

  private layout(width: number) {
    const treeWidth = width >= 90 && this.files.length > 0
      ? Math.max(FILE_TREE_MIN_WIDTH, Math.min(FILE_TREE_MAX_WIDTH, Math.floor(width / 4))) : 0;
    const patchWidth = Math.max(1, width - treeWidth - 4);
    const view: DiffView = patchWidth >= MIN_SPLIT_WIDTH ? this.viewOverride ?? "split" : "unified";
    const height = Math.max(0, this.host.terminal.rows - 2 - FILE_HEADER_HEIGHT);
    return { treeWidth, patchWidth, view, height };
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.preferences.onScopeChange?.(matchesKey(data, "tab") ? 1 : -1);
      return;
    }
    const { patchWidth, view, height } = this.layout(this.host.terminal.columns);
    if (matchesKey(data, "h")) this.focus = "tree";
    else if (matchesKey(data, "l")) this.focus = "diff";
    else if (matchesKey(data, "v") || matchesKey(data, "shift+v")) {
      const file = this.selected === undefined ? undefined : this.files[this.selected];
      if (!file) this.viewHint = "没有可切换的文件";
      else if (file.status !== "modified") return;
      else if (patchWidth < MIN_SPLIT_WIDTH) this.viewHint = "右侧宽度不足，请拉宽终端后切换拆分视图";
      else {
        this.viewOverride = view === "split" ? "unified" : "split";
        this.preferences.onViewChange?.(this.viewOverride);
        this.viewHint = undefined;
      }
    } else if (matchesKey(data, "n") || matchesKey(data, "p")) {
      const next = this.tree.moveFile(this.selected, matchesKey(data, "n") ? 1 : -1);
      if (next !== undefined) this.tree.selectFile(next);
      this.select(next);
    } else if (this.focus === "tree") {
      if (matchesKey(data, "up") || matchesKey(data, "down")) this.select(this.tree.move(matchesKey(data, "up") ? -1 : 1));
      else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) this.select(this.tree.move(matchesKey(data, "pageUp") ? -Math.max(1, height) : Math.max(1, height)));
      else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        const file = this.tree.toggle();
        this.select(file);
        if (file !== undefined) this.focus = "diff";
      }
    } else {
      if (matchesKey(data, "up") || matchesKey(data, "down")) this.top += matchesKey(data, "up") ? -1 : 1;
      else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) this.top += matchesKey(data, "pageUp") ? -Math.max(1, height) : Math.max(1, height);
      else if (matchesKey(data, "home")) this.top = 0;
      else if (matchesKey(data, "end")) this.top = this.patch?.rowCount(patchWidth, view) ?? 0;
    }
    this.host.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    const { treeWidth, height } = this.layout(event.width);
    const treeOnly = !treeWidth && this.focus === "tree" && this.files.length > 0;
    const inTree = treeOnly || (treeWidth > 0 && event.x < treeWidth - 1);
    const treeTop = treeOnly ? 2 : 3;
    const treeHeight = treeOnly ? Math.max(0, event.height - 3) : height;
    if (event.type === "wheel") {
      if (event.y >= treeTop && event.y < treeTop + treeHeight && inTree) {
        this.focus = "tree";
        this.tree.scroll(event.wheelDelta ?? 0, treeHeight);
      } else if (!inTree && event.y >= 3 && event.y < event.height - 1) {
        this.focus = "diff";
        this.top += event.wheelDelta ?? 0;
      }
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left") {
      if (event.y === 0 && this.viewButton >= 0 && event.x >= this.viewButton && event.x < this.viewButton + visibleWidth("[切换视图]")) this.handleInput("v");
      else if (inTree && event.y >= treeTop && event.y < treeTop + treeHeight) {
        this.focus = "tree";
        const selected = this.tree.clickRow(event.y - treeTop);
        this.select(selected);
        if (treeOnly && selected !== undefined) this.focus = "diff";
      } else if (!inTree && event.y > 0 && event.y < event.height - 1) this.focus = "diff";
      return { handled: true, focus: true };
    }
    // Consume overlay mouse events so they cannot scroll the conversation underneath.
    return { handled: true, render: false };
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.host.terminal.rows);
    const { treeWidth, patchWidth, view, height } = this.layout(width);
    if (patchWidth >= MIN_SPLIT_WIDTH && this.viewHint?.startsWith("右侧宽度不足")) this.viewHint = undefined;
    this.top = this.patch?.reflowTop(patchWidth, view, this.top) ?? 0;
    this.top = Math.max(0, Math.min(this.top, (this.patch?.rowCount(patchWidth, view) ?? 0) - Math.max(1, height)));
    const theme = this.theme;
    const file = this.selected === undefined ? undefined : this.files[this.selected];
    const fixedUnified = file !== undefined && file.status !== "modified";
    const heading = `${displayText(this.title)}${this.notice ? ` · ${this.notice}` : ""} · ${this.files.length} 个文件  `;
    this.viewButton = fixedUnified ? -1 : visibleWidth(heading);
    const header = theme.bold(theme.fg("accent", heading + (fixedUnified ? "[仅合并视图]" : "[切换视图]")));
    const lines = [fit(header, width)];
    const bodyHeight = Math.max(0, rows - 2);
    if (!treeWidth && this.focus === "tree" && this.files.length) {
      lines.push(fit(theme.bold("文件"), width), ...this.tree.render(width, Math.max(0, bodyHeight - 1), theme, true, this.selected));
    } else {
      const label = file ? displayText(file.file) : this.emptyMessage ?? "没有文件改动";
      const note = file?.cumulativeFallback ? "仅显示最后一轮，累计无法完整恢复"
        : file?.baselineUnknown ? "修改前内容未知" : "";
      const counts = file ? theme.fg("success", `+${file.additions}`) + " " + theme.fg("error", `-${file.deletions}`) : "";
      const effectiveView = this.patch?.effectiveView(view) ?? view;
      const layoutLabel = fixedUnified ? "合并视图（新增/删除文件）" : effectiveView === "split" ? "拆分视图" : "合并视图";
      const hint = this.viewHint || note;
      const detail = counts + theme.fg("muted", ` · ${layoutLabel}${hint ? ` · ${hint}` : ""} · 自动换行`);
      const metadata = [fit(theme.bold(label), patchWidth), fit(detail, patchWidth)];
      const content = this.patch?.renderViewport(patchWidth, height, this.top, view, theme) ?? Array.from({ length: height }, () => fit("", patchWidth));
      const pane = [...metadata, ...content];
      const left = treeWidth ? [fit(theme.bold(theme.fg(this.focus === "tree" ? "accent" : "muted", "文件")), treeWidth), fit("", treeWidth), ...this.tree.render(treeWidth - 1, height, theme, this.focus === "tree", this.selected)] : [];
      for (let i = 0; i < bodyHeight; i++) {
        const tree = treeWidth ? fit(left[i] ?? "", treeWidth - 1) + theme.fg("borderMuted", "│") : "";
        lines.push(fit(tree + "  " + fit(pane[i] ?? "", patchWidth) + "  ", width));
      }
    }
    if (rows > 1) lines.push(fit(theme.fg("muted", `Tab/Shift+Tab 范围 · ${fixedUnified ? "A/D 仅合并" : "v/V 合并/拆分"} · h/l 文件/内容 · ↑↓/滚轮 滚动 · n/p 文件 · Esc/q 关闭`), width));
    return lines.slice(0, rows);
  }

  invalidate(): void {
    this.patch?.invalidate();
  }
}
