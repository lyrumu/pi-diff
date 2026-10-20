import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FilePatch } from "../diff-engine.ts";
import {
  allExpandedFileTreeDirectories, buildFileTree, fileTreeFileSelection,
  flattenFileTree, movePatchFileIndex, orderedPatchFileIndexes, toggleFileTreeDirectory, type FileTreeRow,
} from "./file-tree-utils.ts";
import { displayText, fit } from "./text.ts";

/** Tree state and rendering; patch selection remains owned by DiffScreen. */
export class FileTree {
  private readonly files: readonly FilePatch[];
  private readonly tree: ReturnType<typeof buildFileTree>;
  private expanded: ReadonlySet<number>;
  private rows: FileTreeRow[];
  private readonly fileIndexes: number[];
  private selected = 0;
  private top = 0;
  private revealSelection = true;

  constructor(files: readonly FilePatch[]) {
    this.files = files;
    this.tree = buildFileTree(files);
    this.expanded = allExpandedFileTreeDirectories(this.tree);
    this.rows = flattenFileTree(this.tree, this.expanded);
    this.fileIndexes = orderedPatchFileIndexes(this.rows);
    this.selected = Math.max(0, this.rows.findIndex((row) => row.fileIndex !== undefined));
  }

  selectedFile(): number | undefined {
    return this.rows[this.selected]?.fileIndex;
  }

  moveFile(current: number | undefined, offset: number): number | undefined {
    return movePatchFileIndex(this.fileIndexes, current, offset);
  }

  move(offset: number): number | undefined {
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + offset));
    this.revealSelection = true;
    return this.selectedFile();
  }

  toggle(): number | undefined {
    const row = this.rows[this.selected];
    if (!row) return undefined;
    this.expanded = toggleFileTreeDirectory(this.tree, this.expanded, row.id);
    this.rows = flattenFileTree(this.tree, this.expanded);
    this.selected = Math.max(0, this.rows.findIndex((item) => item.id === row.id));
    this.revealSelection = true;
    return this.selectedFile();
  }

  selectFile(index: number): void {
    const selection = fileTreeFileSelection(this.tree, index);
    if (!selection) return;
    this.expanded = new Set([...this.expanded, ...selection.expandedNodes]);
    this.rows = flattenFileTree(this.tree, this.expanded);
    this.selected = Math.max(0, this.rows.findIndex((row) => row.fileIndex === index));
    this.revealSelection = true;
  }

  clickRow(offset: number): number | undefined {
    const index = this.top + offset;
    if (offset < 0 || !this.rows[index]) return undefined;
    this.selected = index;
    this.revealSelection = true;
    return this.rows[index]!.kind === "directory" ? this.toggle() : this.selectedFile();
  }

  scroll(offset: number, height: number): void {
    this.top = Math.max(0, Math.min(this.rows.length - Math.max(1, height), this.top + offset));
    this.revealSelection = false;
  }

  render(width: number, height: number, theme: Theme, focused: boolean, fileIndex: number | undefined): string[] {
    this.top = Math.max(0, Math.min(this.top, this.rows.length - height));
    if (this.revealSelection) {
      this.top = Math.min(this.top, this.selected);
      if (this.selected >= this.top + height) this.top = this.selected - height + 1;
      this.revealSelection = false;
    }
    return Array.from({ length: height }, (_, offset) => {
      const index = this.top + offset;
      const row = this.rows[index];
      if (!row) return fit("", width);
      const status = row.fileIndex === undefined ? undefined : this.files[row.fileIndex]?.status;
      const color = status === "added" ? "success" : status === "deleted" ? "error" : "muted";
      const selected = focused ? index === this.selected : row.fileIndex !== undefined && row.fileIndex === fileIndex;
      const prefix = theme.fg(selected ? "accent" : "muted", selected ? "› " : "  ");
      const indent = "│ ".repeat(Math.max(0, Math.min(row.depth, Math.floor((width - 8) / 2))));
      const marker = row.kind === "directory" ? (this.expanded.has(row.id) ? "▾ " : "▸ ") : "≡ ";
      const label = `${indent}${marker}${displayText(row.name)}${row.kind === "directory" ? "/" : ""}`;
      const name = selected ? theme.bold(theme.fg("accent", label)) : label;
      const badge = theme.fg(color, status === "added" ? "A" : status === "deleted" ? "D" : status === "modified" ? "M" : " ");
      const line = fit(prefix + badge + " " + name, width);
      return selected ? theme.bg("selectedBg", line) : line;
    });
  }
}
