// The keyboard half of the command registry: which commands carry keys, and how
// a keydown finds one.
//
// The table itself lives in `./commands` - `BINDINGS` is the key-carrying subset
// of `COMMANDS`, derived rather than maintained, so a command cannot advertise a
// key in the Cmd+/ sheet that no dispatcher fires, and the palette and the sheet
// can never disagree about what a command is called.
//
// This module stays as lean as it was for a reason: `TerminalView` imports it to
// route keys past a focused xterm, so anything reachable from here is in the
// terminal's chunk. `commands.ts` imports only `./events`, which is what keeps
// that true now that the editor and git commands live in the same table.
import { COMMANDS, type Command, type CommandGroup, type CommandScope } from "./commands";

/** Where a binding is listed in the Cmd+/ sheet. */
export type BindingGroup = CommandGroup;
export type BindingScope = CommandScope;

export const GROUP_LABELS: Record<BindingGroup, string> = {
  navigate: "Navigate",
  view: "View",
  search: "Search",
  terminal: "Terminal",
  session: "Sessions",
  editor: "Editor",
  git: "Git",
  settings: "Settings",
  help: "Help",
};

/** A command that carries a key, so the dispatcher can match it. */
export type Binding = Command & {
  keys: string[];
  scope: BindingScope;
  match: (e: KeyboardEvent) => boolean;
};

/**
 * The key-carrying view of `COMMANDS`, in table order, which is the sheet's
 * display order within each group. `dispatchHotkey` and the Cmd+/ sheet both
 * read it, so a binding cannot be added, changed, or removed in one without the
 * other following - the drift that makes printed shortcut lists lie.
 */
export const BINDINGS: Binding[] = COMMANDS.filter(
  (c): c is Binding => !!c.keys && !!c.scope && !!c.match,
);

/** Bindings for the sheet, grouped in `GROUP_LABELS` order. A group with no
 *  key-carrying command (Editor, Git) drops out rather than showing empty. */
export function bindingsByGroup(): { group: BindingGroup; bindings: Binding[] }[] {
  return (Object.keys(GROUP_LABELS) as BindingGroup[])
    .map((group) => ({ group, bindings: BINDINGS.filter((b) => b.group === group) }))
    .filter((g) => g.bindings.length > 0);
}

function fire(e: KeyboardEvent, scopes: BindingScope[]): boolean {
  // A key the focused widget already handled must not double-fire an app
  // hotkey. CodeMirror preventDefaults every binding it runs, so without this
  // guard Cmd+/ in the editor toggles a comment AND opens the shortcut sheet.
  if (e.defaultPrevented) return false;
  const hit = BINDINGS.find((b) => scopes.includes(b.scope) && b.run && b.match(e));
  if (!hit) return false;
  hit.run!(e);
  return true;
}

/**
 * Match a terminal-safe hotkey and fire its side effect, returning whether it
 * was handled. Called by both App.tsx's window listener and TerminalView's
 * `attachCustomKeyEventHandler`, so these keep working while xterm has focus.
 */
export function dispatchHotkey(e: KeyboardEvent): boolean {
  return fire(e, ["global"]);
}

/**
 * The window-level superset: every binding `dispatchHotkey` handles, plus the
 * `window`-scoped ones that must NOT fire while the terminal has focus.
 */
export function dispatchWindowHotkey(e: KeyboardEvent): boolean {
  return fire(e, ["global", "window"]);
}
