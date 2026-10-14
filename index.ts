import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { Tracker } from "./src/tracker.ts";

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

  pi.on("session_start", (_event, ctx) => {
    // Rebuild in-memory turn-diff state from persisted custom entries on the
    // active branch (session reload / resume / branch switch), then purge
    // stale snapshot caches (30-day LRU, see AGENTS.md).
    tracker.restoreFromSession(ctx.sessionManager);
    void tracker.cleanupCaches();
  });

  pi.on("before_agent_start", () => {
    // Turn start: bump the turn counter and take the workspace baseline.
    void tracker.onTurnStart();
  });

  pi.on("tool_call", (event) => {
    const e = event as ToolCallEvent;
    if (SHELL_TOOLS.has(e.toolName)) {
      // Shell boundary (before): record the workspace marker.
      void tracker.onBashStart(e.toolCallId);
    } else if (FILE_TOOLS.has(e.toolName)) {
      // edit/write (before execution, so disk still holds the old side):
      // register the target file through the single entry point.
      const path = (e.input as { path?: string }).path;
      if (typeof path === "string") void tracker.recordFileChange(path, { fromToolEvent: true });
    }
  });

  pi.on("tool_result", (event) => {
    const e = event as { toolName: string; toolCallId: string };
    if (SHELL_TOOLS.has(e.toolName)) {
      // Shell boundary (after): scan for files the command changed.
      void tracker.onBashEnd(e.toolCallId);
    }
  });

  pi.on("agent_settled", () => {
    // End of the user-prompt run: compute patches for every registered file
    // and persist them as a self-contained `pi-diff.turn` custom entry.
    void tracker.finalizeTurn();
  });

  pi.registerCommand("diff", {
    description: "View per-turn / session / git changes",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui?.notify("pi-diff requires the interactive TUI", "error");
        return;
      }
      // Open the fullscreen TUI: scope selector first (last turn / turn list /
      // session total / git scopes), then the file-tree + diff screen.
      // Implementation: src/tui/ — see AGENTS.md (phase 3).
      ctx.ui?.notify("pi-diff: TUI not implemented yet (phase 3)", "info");
    },
  });
}
