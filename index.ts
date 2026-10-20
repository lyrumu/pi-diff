import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { Tracker } from "./src/tracker.ts";
import { Git } from "./src/git.ts";
import type { FilePatch } from "./src/diff-engine.ts";
import { cycleScope, type DiffScope } from "./src/tui/scopes.ts";
import { DiffScreen, FULLSCREEN_OPTIONS } from "./src/tui/diff-screen.ts";
import { loadViewPreference, saveViewPreference, VIEW_PREFERENCE_PATH, loadLanguagePreference, saveLanguagePreference, LANGUAGE_PREFERENCE_PATH } from "./src/preferences.ts";
import { messages, type Language, type LocalizedText } from "./src/language.ts";
import { hasUnavailableTurnDiffs } from "./src/store.ts";

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FILE_TOOLS = new Set(["edit", "write"]);

/**
 * pi-diff — `/diff` command.
 *
 * Shows per-turn, per-session and (when git is available) git-scope changes
 * in a fullscreen TUI: file tree on the left, diff content on the right,
 * unified/split layouts toggled with v/V; l/L switches the display language.
 *
 * Architecture is ported from opencode's diff stack; see AGENTS.md for the
 * mapping between opencode source files and the modules in src/.
 *
 * Turn boundary (deviation D2, user-confirmed): pi's `turn_end` fires once
 * per LLM loop iteration, so finalize is hooked to `agent_settled` (once per
 * user-prompt run) to preserve opencode's turn semantics.
 */
export default function (pi: ExtensionAPI) {
  const tracker = new Tracker(pi);

  pi.on("session_start", async (_event, ctx) => {
    // Rebuild in-memory turn-diff state from persisted custom entries on the
    // active branch (session reload / resume / branch switch), then purge
    // stale snapshot caches (30-day LRU, see AGENTS.md).
    tracker.restoreFromSession(ctx.sessionManager);
    await tracker.cleanupCaches();
  });

  pi.on("session_tree", (_event, ctx) => {
    tracker.restoreFromSession(ctx.sessionManager);
  });

  pi.on("before_agent_start", async () => {
    // Turn start: bump the turn counter and take the workspace baseline.
    await tracker.onTurnStart();
  });

  pi.on("tool_call", async (event) => {
    const e = event as ToolCallEvent;
    if (SHELL_TOOLS.has(e.toolName)) {
      // Shell boundary (before): record the workspace marker.
      await tracker.onBashStart(e.toolCallId);
    } else if (FILE_TOOLS.has(e.toolName)) {
      // edit/write (before execution, so disk still holds the old side):
      // register the target file through the single entry point.
      const path = (e.input as { path?: string }).path;
      if (typeof path === "string") await tracker.recordFileChange(path, { fromToolEvent: true });
    }
  });

  pi.on("tool_result", async (event) => {
    const e = event as { toolName: string; toolCallId: string };
    if (SHELL_TOOLS.has(e.toolName)) {
      // Shell boundary (after): scan for files the command changed.
      await tracker.onBashEnd(e.toolCallId);
    }
  });

  pi.on("agent_settled", async () => {
    // End of the user-prompt run: compute patches for every registered file
    // and persist them as a self-contained `pi-diff.turn` custom entry.
    await tracker.finalizeTurn();
  });

  pi.registerCommand("diff", {
    description: "Review per-turn, session-wide and Git changes",
    handler: async (_args, ctx) => {
      const initialLanguage = await loadLanguagePreference(LANGUAGE_PREFERENCE_PATH);
      let language = initialLanguage;
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui?.notify(messages[language].requiresTui, "error");
        return;
      }
      try {
        // pi resolves idle only after awaited agent_settled handlers complete.
        await ctx.waitForIdle();
        tracker.restoreFromSession(ctx.sessionManager);
        const turns = tracker.turns();
        const gitAvailable = await Git.isAvailable(ctx.cwd);
        const unavailableHistory = hasUnavailableTurnDiffs(ctx.sessionManager.getBranch());
        let scope: DiffScope = gitAvailable ? { kind: "git", mode: "unstaged" } : { kind: "turn", turn: turns.at(-1)?.turn };
        const initialView = await loadViewPreference(VIEW_PREFERENCE_PATH);
        let view = initialView;
        let request = 0;
        let closed = false;
        const scopeTitle = (source: DiffScope): LocalizedText => (language) => source.kind === "turn"
          ? source.turn === undefined ? messages[language].lastTurn : messages[language].turn(source.turn)
          : source.kind === "session" ? messages[language].session : messages[language][source.mode];
        const loadScope = async (source: DiffScope) => {
          let files: readonly FilePatch[];
          let emptyMessage: LocalizedText | undefined;
          if (source.kind === "turn") {
            const turnNumber = source.turn;
            files = turns.find((turn) => turn.turn === turnNumber)?.patches ?? [];
            emptyMessage = (language) => messages[language][turnNumber === undefined ? (unavailableHistory ? "noHistory" : "noTurns") : "emptyTurn"];
          } else if (source.kind === "session") {
            files = await tracker.sessionPatches();
            emptyMessage = (language) => messages[language][unavailableHistory ? "unavailableTotal" : "emptySession"];
          } else files = await Git.diff(ctx.cwd, source.mode);
          return { title: scopeTitle(source), files, emptyMessage, notice: source.kind !== "git" && unavailableHistory ? (language: Language) => messages[language].incompleteHistory : undefined };
        };
        const initial = await loadScope(scope);
        try {
          await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
            const screen = new DiffScreen(tui, theme, initial.title, initial.files, () => {
              closed = true;
              request++;
              done();
            }, {
              view, emptyMessage: initial.emptyMessage, notice: initial.notice,
              language, onLanguageChange: (next) => { language = next; },
              onViewChange: (next) => { view = next; },
              onScopeChange: (direction) => { void changeScope(direction); },
            });
            const changeScope = async (direction: 1 | -1) => {
              scope = cycleScope(scope, direction, turns, gitAvailable);
              const target = scope;
              const id = ++request;
              screen.setData(scopeTitle(target), [], { emptyMessage: (language) => messages[language].loading });
              try {
                const data = await loadScope(target);
                if (!closed && id === request) screen.setData(data.title, data.files, data);
              } catch (error) {
                if (!closed && id === request) screen.setData(scopeTitle(target), [], { emptyMessage: (language) => messages[language].loadFailed(error instanceof Error ? error.message : String(error)) });
              }
            };
            return screen;
          }, FULLSCREEN_OPTIONS);
        } finally {
          closed = true;
          request++;
          await Promise.all([
            view && view !== initialView ? saveViewPreference(VIEW_PREFERENCE_PATH, view) : undefined,
            language !== initialLanguage ? saveLanguagePreference(LANGUAGE_PREFERENCE_PATH, language) : undefined,
          ]);
        }
      } catch (error) {
        ctx.ui.notify(messages[language].error(error instanceof Error ? error.message : String(error)), "error");
      }
    },
  });
}
