import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Tracker } from "./src/tracker.ts";

/**
 * pi-diff — `/diff` command.
 *
 * Shows per-turn, per-session and (when git is available) git-scope changes
 * in a fullscreen TUI: file tree on the left, diff content on the right,
 * unified/split layouts toggled with Tab.
 *
 * Architecture is ported from opencode's diff stack; see AGENTS.md for the
 * mapping between opencode source files and the modules in src/.
 */
export default function (pi: ExtensionAPI) {
  const tracker = new Tracker(pi);

  pi.on("session_start", async (_event, ctx) => {
    // Rebuild in-memory turn-diff state from persisted custom entries on the
    // active branch (session reload / resume / branch switch).
    await tracker.restoreFromSession(ctx.sessionManager);
    // Purge stale snapshot caches (30-day LRU, see AGENTS.md).
    await tracker.cleanupCaches();
  });

  pi.on("turn_end", async (_event, _ctx) => {
    // Finalize the turn: compute patches for every file registered through
    // the single change-recording entry point (`Tracker.recordFileChange`)
    // and persist them as a `pi-diff.turn` custom entry.
    await tracker.finalizeTurn();
  });

  pi.registerCommand("diff", {
    description: "View per-turn / session / git changes",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI === false) {
        ctx.ui?.notify("pi-diff requires the interactive TUI", "error");
        return;
      }
      // Open the fullscreen TUI: scope selector first (last turn / turn list /
      // session total / git scopes), then the file-tree + diff screen.
      // Implementation: src/tui/ — see AGENTS.md.
      // TODO: ctx.ui.custom() with ScopeSelector, then DiffScreen.
      ctx.ui?.notify("pi-diff: TUI not implemented yet", "info");
    },
  });
}
