/**
 * Main fullscreen diff screen (ctx.ui.custom(), non-overlay).
 *
 * Layout:
 *   ┌────────────── header: scope title · "N files changed" · key hints ─────┐
 *   │ file tree (left)          │  diff content (right)                     │
 *   │  ├ dir/ (collapsible)     │  unified view (default) -- Tab toggles    │
 *   │  │ ├ M file.ts            │  split view (old | new side by side)      │
 *   │  │ ├ A new.ts             │                                           │
 *
 * Keys: up/down navigate, h/l (or left/right) move focus between panes,
 * Tab toggle unified/split, Esc/q exit. Renders from FilePatch[] only —
 * works identically for turn/session (persisted) and git (live) scopes.
 */
export class DiffScreen {
  // TODO: implement with pi-tui Box/HStack/ScrollView + theme tokens
  // (success/error/muted for +/-/context rows). Binary and tooLarge files
  // render a placeholder line instead of hunks.
}
