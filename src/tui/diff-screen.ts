import { matchesKey, visibleWidth, type Component, type OverlayOptions, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FilePatch } from "../diff-engine.ts";
import { localize, messages, type Language, type LocalizedText } from "../language.ts";
import { FileTree } from "./file-tree.ts";
import { PatchDiff, type DiffView } from "./patch-diff.ts";
import { displayText, fit, type TuiHost } from "./text.ts";

export const MIN_SPLIT_WIDTH = 100;
export const FILE_TREE_MIN_WIDTH = 10;
export const FILE_TREE_MAX_WIDTH = 40;
const MIN_PATCH_WIDTH = 40;
export const FILE_HEADER_HEIGHT = 2;
export const FULLSCREEN_OPTIONS = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } satisfies OverlayOptions,
} as const;

export interface DiffScreenPreferences {
  language?: Language;
  onLanguageChange?: (language: Language) => void;
  view?: DiffView;
  onViewChange?: (view: DiffView) => void;
  emptyMessage?: LocalizedText;
  notice?: LocalizedText;
  onScopeChange?: (direction: 1 | -1) => void;
}

/** Selected-file view on a fullscreen overlay; all data comes from FilePatch[]. */
export class DiffScreen implements Component {
  private readonly host: TuiHost;
  private readonly theme: Theme;
  private title: LocalizedText;
  private language: Language;
  private files: readonly FilePatch[];
  private readonly close: () => void;
  private readonly preferences: DiffScreenPreferences;
  private tree: FileTree;
  private emptyMessage: LocalizedText | undefined;
  private notice: LocalizedText | undefined;
  private selected: number | undefined;
  private patch: PatchDiff | undefined;
  private focus: "tree" | "diff" = "diff";
  private viewOverride: DiffView | undefined;
  private top = 0;
  private viewButton = 0;
  private showFilesButton = 0;
  private viewHint: "noFileToSwitch" | "tooNarrow" | undefined;
  private treeWidthOverride: number | undefined;
  private treeCollapsed = false;
  private dividerGesture: "dragging" | "released" | undefined;
  private dividerMoved = false;
  private lastDividerClick = 0;
  private pointer: { x: number; y: number } | undefined;

  constructor(host: TuiHost, theme: Theme, title: LocalizedText, files: readonly FilePatch[], close: () => void, preferences: DiffScreenPreferences = {}) {
    this.host = host;
    this.theme = theme;
    this.title = title;
    this.files = files;
    this.close = close;
    this.preferences = preferences;
    this.language = preferences.language ?? "en";
    this.emptyMessage = preferences.emptyMessage;
    this.notice = preferences.notice;
    this.viewOverride = preferences.view;
    this.tree = new FileTree(files);
    this.select(this.tree.selectedFile());
  }

  /** Replace the source inside the existing overlay; never expose the chat between scopes. */
  setData(title: LocalizedText, files: readonly FilePatch[], status: { emptyMessage?: LocalizedText; notice?: LocalizedText } = {}): void {
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
    this.pointer = undefined;
    this.lastDividerClick = 0;
    if (this.dividerGesture === "dragging") this.dividerGesture = "released";
    this.select(this.tree.selectedFile());
    this.host.requestRender();
  }

  private select(index: number | undefined): void {
    if (index === undefined || index === this.selected) return;
    const file = this.files[index];
    if (!file) return;
    this.selected = index;
    this.patch = new PatchDiff(file, this.language);
    this.top = 0;
    this.viewHint = undefined;
  }

  private layout(width: number) {
    const inset = width < 90 ? 0 : 2;
    const maxTreeWidth = Math.min(Math.floor(width / 4), width - inset * 2 - MIN_PATCH_WIDTH);
    const defaultTreeWidth = Math.max(30, Math.min(FILE_TREE_MAX_WIDTH, Math.floor(width / 4)));
    const treeWidth = width >= 90 && this.files.length > 0 && !this.treeCollapsed
      ? Math.min(maxTreeWidth, Math.max(FILE_TREE_MIN_WIDTH, this.treeWidthOverride ?? defaultTreeWidth)) : 0;
    const patchWidth = Math.max(1, width - treeWidth - inset * 2);
    const view: DiffView = patchWidth >= MIN_SPLIT_WIDTH ? this.viewOverride ?? "split" : "unified";
    const height = Math.max(0, this.host.terminal.rows - 2 - FILE_HEADER_HEIGHT);
    return { inset, treeWidth, maxTreeWidth, patchWidth, view, height };
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
    if (matchesKey(data, "l") || matchesKey(data, "shift+l")) {
      this.language = this.language === "en" ? "zh-CN" : "en";
      this.patch?.setLanguage(this.language);
      this.preferences.onLanguageChange?.(this.language);
      this.host.requestRender();
      return;
    }
    const { patchWidth, view, height } = this.layout(this.host.terminal.columns);
    if (matchesKey(data, "[")) {
      // Explicit reopening takes precedence over pending drag/release events.
      if (this.dividerGesture === "dragging") this.dividerGesture = "released";
      this.lastDividerClick = 0;
      this.treeCollapsed = false;
      this.focus = "tree";
    } else if (matchesKey(data, "]")) this.focus = "diff";
    else if (matchesKey(data, "v") || matchesKey(data, "shift+v")) {
      const file = this.selected === undefined ? undefined : this.files[this.selected];
      if (!file) this.viewHint = "noFileToSwitch";
      else if (file.status !== "modified") return;
      else if (patchWidth < MIN_SPLIT_WIDTH) this.viewHint = "tooNarrow";
      else {
        this.viewOverride = view === "split" ? "unified" : "split";
        this.preferences.onViewChange?.(this.viewOverride);
        this.viewHint = undefined;
      }
    } else if (this.focus === "tree" && (matchesKey(data, "j") || matchesKey(data, "k"))) {
      const next = this.tree.moveFile(this.selected, matchesKey(data, "j") ? 1 : -1);
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
      if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "j") || matchesKey(data, "k")) this.top += matchesKey(data, "up") || matchesKey(data, "k") ? -1 : 1;
      else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) this.top += matchesKey(data, "pageUp") ? -Math.max(1, height) : Math.max(1, height);
      else if (matchesKey(data, "home")) this.top = 0;
      else if (matchesKey(data, "end")) this.top = this.patch?.rowCount(patchWidth, view) ?? 0;
    }
    this.host.requestRender();
  }

  private isOnDivider(treeWidth: number, height: number): boolean {
    return treeWidth > 0 && this.pointer !== undefined && this.pointer.x >= treeWidth - 1 && this.pointer.x <= treeWidth && this.pointer.y >= 1 && this.pointer.y < height - 1;
  }

  private resizeTree(x: number, maxWidth: number): number {
    this.treeCollapsed = x <= 0;
    if (this.treeCollapsed) {
      this.focus = "diff";
      return 0;
    }
    this.treeWidthOverride = Math.max(FILE_TREE_MIN_WIDTH, Math.min(maxWidth, x + 1));
    return this.treeWidthOverride;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    // Captured event bounds can predate a terminal resize.
    const { treeWidth, maxTreeWidth, height } = this.layout(this.dividerGesture === "dragging" ? this.host.terminal.columns : event.width);
    const wasHovered = this.isOnDivider(treeWidth, event.height);
    this.pointer = { x: event.x, y: event.y };
    const hovered = this.isOnDivider(treeWidth, event.height);
    if (event.type === "move") return { handled: true, render: wasHovered !== hovered };
    if (event.type === "press") {
      this.dividerGesture = undefined;
      if (event.button === "left" && hovered) {
        if (Date.now() - this.lastDividerClick < 300) {
          this.lastDividerClick = 0;
          this.treeWidthOverride = undefined;
          this.dividerGesture = "released";
          return { handled: true, capture: true };
        }
        this.dividerMoved = false;
        this.dividerGesture = "dragging";
        return { handled: true, capture: true };
      }
      this.lastDividerClick = 0;
    }
    if (this.dividerGesture) {
      if (this.host.terminal.columns < 90 || !this.files.length) {
        this.dividerGesture = "released";
        this.lastDividerClick = 0;
      }
      if (event.type === "release") {
        if (this.dividerGesture === "dragging") {
          if (this.dividerMoved) this.resizeTree(event.x, maxTreeWidth);
          this.lastDividerClick = this.dividerMoved ? 0 : Date.now();
        }
        this.dividerGesture = "released";
        return { handled: true, render: true };
      }
      if (event.type === "click") {
        // pi synthesizes a click after an unmoved press/release.
        this.dividerGesture = undefined;
        return { handled: true, render: false };
      }
      if (event.type === "drag") {
        if (this.dividerGesture !== "dragging" || event.button !== "left") return { handled: true, render: false };
        this.dividerMoved = true;
        this.lastDividerClick = 0;
        return { handled: true, render: this.resizeTree(event.x, maxTreeWidth) !== treeWidth };
      }
    }
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
      if (event.y === 0 && event.x < this.showFilesButton) this.handleInput("[");
      else if (event.y === 0 && this.viewButton >= 0 && event.x >= this.viewButton && event.x < this.viewButton + visibleWidth(messages[this.language].switchView)) this.handleInput("v");
      else if (inTree && event.y >= treeTop && event.y < treeTop + treeHeight) {
        this.focus = "tree";
        const selected = this.tree.clickRow(event.y - treeTop);
        this.select(selected);
        if (treeOnly && selected !== undefined) this.focus = "diff";
      } else if (!inTree && event.y > 0 && event.y < event.height - 1) this.focus = "diff";
      return { handled: true, focus: true };
    }
    // Consume overlay mouse events so they cannot scroll the conversation underneath.
    return { handled: true, render: wasHovered !== hovered };
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.host.terminal.rows);
    const { inset, treeWidth, patchWidth, view, height } = this.layout(width);
    if ((width < 90 || !this.files.length) && this.dividerGesture === "dragging") {
      this.dividerGesture = "released";
      this.lastDividerClick = 0;
    }
    const dividerActive = treeWidth > 0 && (this.dividerGesture === "dragging" || this.isOnDivider(treeWidth, rows));
    if (patchWidth >= MIN_SPLIT_WIDTH && this.viewHint === "tooNarrow") this.viewHint = undefined;
    this.top = this.patch?.reflowTop(patchWidth, view, this.top) ?? 0;
    this.top = Math.max(0, Math.min(this.top, (this.patch?.rowCount(patchWidth, view) ?? 0) - Math.max(1, height)));
    const theme = this.theme;
    const text = messages[this.language];
    const file = this.selected === undefined ? undefined : this.files[this.selected];
    const fixedUnified = file !== undefined && file.status !== "modified";
    const totals = this.files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
    const heading = theme.bold(theme.fg("accent", `${displayText(localize(this.title, this.language))}${this.notice ? ` · ${localize(this.notice, this.language)}` : ""} · ${text.fileCount(this.files.length)}  `)
      + theme.fg("success", `+${totals.additions}`) + " " + theme.fg("error", `-${totals.deletions}`) + "  ");
    const showFiles = this.treeCollapsed && this.files.length ? theme.bold(theme.fg("accent", text.showFiles)) + "  " : "";
    this.showFilesButton = showFiles ? visibleWidth(text.showFiles) : 0;
    this.viewButton = fixedUnified ? -1 : visibleWidth(showFiles + heading);
    const header = showFiles + heading + theme.bold(theme.fg("accent", fixedUnified ? text.unifiedOnly : text.switchView));
    const lines = [fit(header, width)];
    const bodyHeight = Math.max(0, rows - 2);
    if (!treeWidth && this.focus === "tree" && this.files.length) {
      lines.push(fit(theme.bold(text.files), width), ...this.tree.render(width, Math.max(0, bodyHeight - 1), theme, true, this.selected));
    } else {
      const label = file ? displayText(file.file) : localize(this.emptyMessage ?? text.noChanges, this.language);
      const note = file?.cumulativeFallback ? text.cumulativeFallback
        : file?.baselineUnknown ? text.baselineUnknown : "";
      const counts = file ? theme.fg("success", `+${file.additions}`) + " " + theme.fg("error", `-${file.deletions}`) : "";
      const effectiveView = this.patch?.effectiveView(view) ?? view;
      const layoutLabel = fixedUnified ? text.fixedUnified : effectiveView === "split" ? text.split : text.unified;
      const hint = this.viewHint ? text[this.viewHint] : note;
      const detail = counts + theme.fg("muted", ` · ${layoutLabel}${hint ? ` · ${hint}` : ""} · ${text.wrap}`);
      const metadata = [fit(theme.bold(label), patchWidth), fit(detail, patchWidth)];
      const content = this.patch?.renderViewport(patchWidth, height, this.top, view, theme) ?? Array.from({ length: height }, () => fit("", patchWidth));
      const pane = [...metadata, ...content];
      const left = treeWidth ? [fit(theme.bold(theme.fg(this.focus === "tree" ? "accent" : "muted", text.files)), treeWidth), fit("", treeWidth), ...this.tree.render(treeWidth - 1, height, theme, this.focus === "tree", this.selected)] : [];
      const divider = theme.fg(dividerActive ? "accent" : "borderMuted", "│");
      const separator = dividerActive ? theme.bg("selectedBg", divider) : divider;
      for (let i = 0; i < bodyHeight; i++) {
        const tree = treeWidth ? fit(left[i] ?? "", treeWidth - 1) + separator : "";
        lines.push(fit(tree + " ".repeat(inset) + fit(pane[i] ?? "", patchWidth) + " ".repeat(inset), width));
      }
    }
    if (rows > 1) lines.push(fit((dividerActive ? theme.fg("accent", `${text.dragDivider} · `) : "") + theme.fg("muted", text.footer(fixedUnified, this.focus)), width));
    return lines.slice(0, rows);
  }

  invalidate(): void {
    this.patch?.invalidate();
  }
}
