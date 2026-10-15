import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FilePatch } from "../diff-engine.ts";
import { displayText, fit } from "./text.ts";

export const VIRTUAL_MIN_LINES = 3000;
export const VIRTUAL_CHUNK_LINES = 128;
export type DiffView = "unified" | "split";

interface Line {
  sign: " " | "+" | "-" | "\\";
  text: string;
  oldLine?: number;
  newLine?: number;
}
type Row = { header: string } | { left?: Line; right?: Line };

interface WrappedText {
  text: string;
  width: number;
  count: number;
  starts?: number[];
}
interface WrappedRow {
  source: Row;
  start: number;
  height: number;
  left: WrappedText;
  right?: WrappedText;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Word wrapping trims code whitespace; keep graphemes and every space instead. */
function wrap(text: string, width: number): WrappedText {
  width = Math.max(1, width);
  if (/^[\x20-\x7e]*$/.test(text)) return { text, width, count: Math.max(1, Math.ceil(text.length / width)) };
  const starts = [0];
  let used = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    const cells = visibleWidth(segment);
    if (used > 0 && used + cells > width) { starts.push(index); used = 0; }
    used += cells;
  }
  return { text, width, starts, count: starts.length };
}
const partStart = (text: WrappedText, part: number) => text.starts?.[part] ?? part * text.width;
const partText = (text: WrappedText, part: number) => text.text.slice(partStart(text, part), part + 1 < text.count ? partStart(text, part + 1) : undefined);

/** pi-tui has no DiffRenderable: parse once, then paint only viewport chunks. */
export class PatchDiff {
  private readonly unified: Row[] = [];
  private readonly split: Row[] = [];
  private readonly digits: number;
  private readonly placeholder: string | undefined;
  private readonly status: FilePatch["status"];
  private cacheSignature = "";
  private readonly chunks = new Map<number, string[]>();
  private wrapped: WrappedRow[] = [];
  private totalRows = 0;
  private cacheTheme: Theme | undefined;

  constructor(file: FilePatch) {
    this.status = file.status;
    this.placeholder = file.unavailable ? "文件内容不可用"
      : file.binary ? "二进制文件已改变"
      : file.tooLarge ? "差异超过 10MB 上限"
      : file.baselineUnknown && file.status === "deleted" ? "文件已删除；修改前内容未知"
      : !file.patch ? "此文件没有可用的差异内容" : undefined;
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let maxLine = 0;
    if (!this.placeholder) for (const text of file.patch.replace(/\n$/, "").split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        this.unified.push({ header: displayText(text) });
        continue;
      }
      if (text.startsWith("diff --git ")) inHunk = false;
      if (!inHunk || ![" ", "+", "-", "\\"].includes(text[0] ?? "")) continue;
      const sign = text[0] as Line["sign"];
      const line: Line = { sign, text: displayText(text.slice(1)) };
      if (sign === " " || sign === "-") line.oldLine = oldLine++;
      if (sign === " " || sign === "+") line.newLine = newLine++;
      maxLine = Math.max(maxLine, line.oldLine ?? 0, line.newLine ?? 0);
      this.unified.push({ left: line, right: line });
    }
    this.digits = Math.max(1, String(maxLine).length);
    for (let i = 0; i < this.unified.length;) {
      const row = this.unified[i]!;
      if ("header" in row || row.left?.sign === " " || row.left?.sign === "\\") {
        this.split.push(row);
        i++;
        continue;
      }
      const removed: Line[] = [];
      const added: Line[] = [];
      while (i < this.unified.length) {
        const next = this.unified[i]!;
        if ("header" in next || !next.left || !["-", "+"].includes(next.left.sign)) break;
        (next.left.sign === "-" ? removed : added).push(next.left);
        i++;
      }
      for (let j = 0; j < Math.max(removed.length, added.length); j++) this.split.push({ left: removed[j], right: added[j] });
    }
    if (!this.placeholder && this.unified.length === 0) this.placeholder = "没有文本变化（空文件或仅元数据变化）";
  }

  effectiveView(view: DiffView): DiffView {
    return this.status === "modified" ? view : "unified";
  }

  private prepare(width: number, view: DiffView): void {
    const signature = `${width}:${view}`;
    if (signature === this.cacheSignature) return;
    this.cacheSignature = signature;
    this.chunks.clear();
    this.wrapped = [];
    this.totalRows = 0;
    const leftWidth = Math.floor((width - 1) / 2);
    for (const source of view === "split" ? this.split : this.unified) {
      let left: WrappedText;
      let right: WrappedText | undefined;
      if ("header" in source) left = wrap(source.header, width);
      else if (source.left?.sign === "\\") left = wrap(`\\${source.left.text}`, width);
      else if (view === "unified") left = wrap(source.left!.text, width - 2 * this.digits - 3);
      else {
        left = wrap(source.left?.text ?? "", leftWidth - this.digits - 2);
        right = wrap(source.right?.text ?? "", width - leftWidth - 1 - this.digits - 2);
      }
      const height = Math.max(left.count, right?.count ?? 1);
      this.wrapped.push({ source, start: this.totalRows, height, left, right });
      this.totalRows += height;
    }
  }

  private rowAt(index: number): WrappedRow | undefined {
    let low = 0;
    let high = this.wrapped.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.wrapped[mid]!.start <= index) low = mid + 1;
      else high = mid;
    }
    const row = this.wrapped[low - 1];
    return row && index < row.start + row.height ? row : undefined;
  }

  rowCount(width: number, view: DiffView): number {
    if (this.placeholder) return 1;
    this.prepare(width, this.effectiveView(view));
    return this.totalRows;
  }

  /** Keep the same source character visible when width or layout changes. */
  reflowTop(width: number, view: DiffView, top: number): number {
    view = this.effectiveView(view);
    if (this.cacheSignature === `${width}:${view}`) return top;
    const old = this.rowAt(top);
    const part = old ? top - old.start : 0;
    const right = old && part >= old.left.count;
    const text = right ? old?.right : old?.left;
    const line = old && !("header" in old.source) ? right ? old.source.right : old.source.left : undefined;
    const offset = text ? partStart(text, part) : 0;
    this.prepare(width, view);
    if (!old) return top;
    const next = this.wrapped.find((item) => item.source === old.source || (line && !("header" in item.source) && (item.source.left === line || item.source.right === line)));
    if (!next) return top;
    const nextText = line && !("header" in next.source) && next.source.right === line && next.source.left !== line ? next.right! : next.left;
    let nextPart = nextText.starts ? 0 : Math.floor(offset / nextText.width);
    if (nextText.starts) {
      while (nextPart + 1 < nextText.count && nextText.starts[nextPart + 1]! <= offset) nextPart++;
    }
    return next.start + Math.min(nextPart, next.height - 1);
  }

  private paint(wrapped: WrappedRow, part: number, width: number, view: DiffView, theme: Theme): string {
    const row = wrapped.source;
    if ("header" in row || row.left?.sign === "\\") return fit(theme.fg("header" in row ? "accent" : "muted", partText(wrapped.left, part)), width);
    const color = (line: Line) => line.sign === "+" ? "success" : line.sign === "-" ? "error" : "muted";
    const styled = (line: Line, text: string, size: number) => {
      const content = fit(theme.fg(color(line), text), size);
      return line.sign === "+" ? theme.bg("toolSuccessBg", content)
        : line.sign === "-" ? theme.bg("toolErrorBg", content) : content;
    };
    const number = (value: number | undefined) => String(value ?? "").padStart(this.digits);
    if (view === "unified") {
      const line = row.left!;
      const gutter = `${number(part === 0 ? line.oldLine : undefined)} ${number(part === 0 ? line.newLine : undefined)} ${part === 0 ? line.sign : "↳"}`;
      return styled(line, gutter + partText(wrapped.left, part), width);
    }
    const leftWidth = Math.floor((width - 1) / 2);
    const rightWidth = width - leftWidth - 1;
    const side = (line: Line | undefined, text: WrappedText, size: number, old: boolean) => {
      if (!line || part >= text.count) return fit("", size);
      const gutter = `${number(part === 0 ? (old ? line.oldLine : line.newLine) : undefined)} ${part === 0 ? line.sign : "↳"}`;
      return styled(line, gutter + partText(text, part), size);
    };
    return side(row.left, wrapped.left, leftWidth, true) + theme.fg("borderMuted", "│") + side(row.right, wrapped.right!, rightWidth, false);
  }

  renderViewport(width: number, height: number, top: number, view: DiffView, theme: Theme): string[] {
    if (this.placeholder) return [fit(theme.fg("muted", this.placeholder), width), ...Array.from({ length: Math.max(0, height - 1) }, () => fit("", width))].slice(0, height);
    view = this.effectiveView(view);
    this.prepare(width, view);
    if (theme !== this.cacheTheme) {
      this.chunks.clear();
      this.cacheTheme = theme;
    }
    return Array.from({ length: height }, (_, offset) => {
      const index = top + offset;
      const row = this.rowAt(index);
      if (!row) return fit("", width);
      if (this.totalRows < VIRTUAL_MIN_LINES) return this.paint(row, index - row.start, width, view, theme);
      const chunkIndex = Math.floor(index / VIRTUAL_CHUNK_LINES);
      let chunk = this.chunks.get(chunkIndex);
      if (!chunk) {
        const start = chunkIndex * VIRTUAL_CHUNK_LINES;
        chunk = Array.from({ length: Math.min(VIRTUAL_CHUNK_LINES, this.totalRows - start) }, (_, offset) => {
          const item = this.rowAt(start + offset)!;
          return this.paint(item, start + offset - item.start, width, view, theme);
        });
        this.chunks.set(chunkIndex, chunk);
        if (this.chunks.size > 4) this.chunks.delete(this.chunks.keys().next().value!);
      }
      return chunk[index % VIRTUAL_CHUNK_LINES]!;
    });
  }

  invalidate(): void {
    this.chunks.clear();
  }
}
