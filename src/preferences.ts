import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./snapshot.ts";
import type { DiffView } from "./tui/patch-diff.ts";

export const VIEW_PREFERENCE_PATH = join(DATA_DIR, "view.json");

export async function loadViewPreference(file: string): Promise<DiffView | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value !== "object" || value === null || !("view" in value)) return undefined;
    return value.view === "unified" || value.view === "split" ? value.view : undefined;
  } catch {
    return undefined;
  }
}

/** Replace atomically so a failed write never destroys the previous choice. */
export async function saveViewPreference(file: string, view: DiffView): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify({ view }) + "\n");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
