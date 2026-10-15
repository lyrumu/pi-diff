import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { Tracker } from "./src/tracker.ts";
import { Git } from "./src/git.ts";
import type { FilePatch } from "./src/diff-engine.ts";
import { GIT_SCOPES, cycleScope, type DiffScope } from "./src/tui/scopes.ts";
import { DiffScreen, FULLSCREEN_OPTIONS } from "./src/tui/diff-screen.ts";
import { loadViewPreference, saveViewPreference, VIEW_PREFERENCE_PATH } from "./src/preferences.ts";
import { hasUnavailableTurnDiffs } from "./src/store.ts";

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FILE_TOOLS = new Set(["edit", "write"]);

/**
 * pi-diff — `/diff` command.
 *
 * Shows per-turn, per-session and (when git is available) git-scope changes
 * in a fullscreen TUI: file tree on the left, diff content on the right,
 * unified/split layouts toggled with Tab.
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
    description: "查看每轮、会话累计和 Git 改动",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui?.notify("pi-diff 需要在交互式 TUI 中使用", "error");
        return;
      }
      try {
        // pi resolves idle only after awaited agent_settled handlers complete.
        await ctx.waitForIdle();
        tracker.restoreFromSession(ctx.sessionManager);
        const turns = tracker.turns();
        const gitAvailable = await Git.isAvailable(ctx.cwd);
        const unavailableHistory = hasUnavailableTurnDiffs(ctx.sessionManager.getBranch());
        let scope: DiffScope = { kind: "turn", turn: turns.at(-1)?.turn };
        const initialView = await loadViewPreference(VIEW_PREFERENCE_PATH);
        let view = initialView;
        let request = 0;
        let closed = false;
        const scopeTitle = (source: DiffScope): string => source.kind === "turn"
          ? source.turn === undefined ? "Last turn" : `Last turn · Turn ${source.turn}`
          : source.kind === "session" ? "Session total" : GIT_SCOPES.find((item) => item.mode === source.mode)!.label;
        const loadScope = async (source: DiffScope) => {
          let files: readonly FilePatch[];
          let emptyMessage: string | undefined;
          if (source.kind === "turn") {
            const turnNumber = source.turn;
            files = turns.find((turn) => turn.turn === turnNumber)?.patches ?? [];
            emptyMessage = turnNumber === undefined ? (unavailableHistory ? "旧会话没有有效的改动记录，无法展示当时变化" : "没有轮次记录；仅记录插件启用后的任务") : "本轮没有文件改动";
          } else if (source.kind === "session") {
            files = await tracker.sessionPatches();
            emptyMessage = unavailableHistory ? "没有可用的历史改动，无法展示完整累计" : "当前会话没有累计改动";
          } else files = await Git.diff(ctx.cwd, source.mode);
          return { title: scopeTitle(source), files, emptyMessage, notice: source.kind !== "git" && unavailableHistory ? "历史记录不完整" : undefined };
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
              onViewChange: (next) => { view = next; },
              onScopeChange: (direction) => { void changeScope(direction); },
            });
            const changeScope = async (direction: 1 | -1) => {
              scope = cycleScope(scope, direction, turns, gitAvailable);
              const target = scope;
              const id = ++request;
              screen.setData(scopeTitle(target), [], { emptyMessage: "正在加载改动…" });
              try {
                const data = await loadScope(target);
                if (!closed && id === request) screen.setData(data.title, data.files, data);
              } catch (error) {
                if (!closed && id === request) screen.setData(scopeTitle(target), [], { emptyMessage: `加载失败：${error instanceof Error ? error.message : String(error)}` });
              }
            };
            return screen;
          }, FULLSCREEN_OPTIONS);
        } finally {
          closed = true;
          request++;
          if (view && view !== initialView) await saveViewPreference(VIEW_PREFERENCE_PATH, view);
        }
      } catch (error) {
        ctx.ui.notify(`pi-diff: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
