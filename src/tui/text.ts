import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";

export type TuiHost = Pick<TUI, "terminal" | "requestRender">;

/** File names and source text must not become terminal control sequences. */
export function displayText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    if (char === "\t") return "    ";
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

export const fit = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), "", true);
