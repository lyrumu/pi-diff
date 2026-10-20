import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./snapshot.ts";
import type { DiffView } from "./tui/patch-diff.ts";
import type { Language } from "./language.ts";

export const VIEW_PREFERENCE_PATH = join(DATA_DIR, "view.json");
export const LANGUAGE_PREFERENCE_PATH = join(DATA_DIR, "language.json");

export async function loadViewPreference(file: string): Promise<DiffView | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value !== "object" || value === null || !("view" in value)) return undefined;
    return value.view === "unified" || value.view === "split" ? value.view : undefined;
  } catch {
    return undefined;
  }
}

export async function saveViewPreference(file: string, view: DiffView): Promise<void> {
  await savePreference(file, { view });
}

export async function loadLanguagePreference(file: string): Promise<Language> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value === "object" && value !== null && "language" in value && value.language === "zh-CN") return "zh-CN";
  } catch {}
  return "en";
}

export async function saveLanguagePreference(file: string, language: Language): Promise<void> {
  await savePreference(file, { language });
}

/** Replace atomically so a failed write never destroys the previous choice. */
async function savePreference(file: string, value: { view: DiffView } | { language: Language }): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify(value) + "\n");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
