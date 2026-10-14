/**
 * First screen of /diff: scope selector.
 *
 * Items (hidden when the cwd is not a git repo, per scope decision):
 *   - "Last turn"
 *   - "Turn N" list (each: turn number, time, file count)
 *   - "Session total" (all turns on current branch, merged)
 *   - git: "Unstaged changes"
 *   - git: "Uncommitted changes" (vs HEAD)
 *   - git: "Branch vs main"
 *
 * Built with pi-tui SelectList inside ctx.ui.custom(). Resolves with the
 * chosen scope, or null on Esc.
 */
export class ScopeSelector {
  // TODO: implement as a pi-tui component (see AGENTS.md TUI section).
}
