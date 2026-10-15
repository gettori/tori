// The menu bar's layout, built from `COMMANDS` so a label or a shortcut cannot
// say something the palette and the Cmd+/ sheet do not. Rust adds the app menu
// and Help around it (see `app_menu.rs`).
import { COMMANDS, type Command } from "./commands";

type SystemItem = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "fullscreen" | "minimize" | "maximize";

export type MenuEntry =
  | { kind: "command"; id: string; label: string; accelerator?: string }
  | { kind: "system"; item: SystemItem }
  | { kind: "separator" };

export type MenuSpec = { title: string; items: MenuEntry[] };

const system = (item: SystemItem): MenuEntry => ({ kind: "system", item });
const SEPARATOR: MenuEntry = { kind: "separator" };

const LAYOUT: [string, (string | MenuEntry)[]][] = [
  [
    "File",
    [
      "editor-new-scratch",
      "omnibox",
      SEPARATOR,
      "editor-save",
      "editor-save-as",
      SEPARATOR,
      "reopen-closed-tab",
      "close-tab",
    ],
  ],
  [
    "Edit",
    [
      system("undo"),
      system("redo"),
      SEPARATOR,
      system("cut"),
      system("copy"),
      system("paste"),
      system("selectAll"),
      SEPARATOR,
      "project-search",
    ],
  ],
  [
    "View",
    [
      "toggle-sidebar",
      "toggle-terminal",
      "toggle-editor",
      "toggle-filetree",
      "toggle-dock",
      SEPARATOR,
      "autopilot-view",
      SEPARATOR,
      "zoom-in",
      "zoom-out",
      "zoom-reset",
      SEPARATOR,
      system("fullscreen"),
    ],
  ],
  [
    "Go",
    [
      "nav-back",
      "nav-forward",
      SEPARATOR,
      "review-inbox",
      "command-palette",
      SEPARATOR,
      "lsp-definition",
      "lsp-references",
    ],
  ],
  ["Session", ["stop-chat", "next-waiting", "since-you-looked", "autopilot-popup"]],
  ["Window", [system("minimize"), system("maximize"), SEPARATOR, "split-pane-right", "split-pane-down", "close-pane"]],
];

const ACCELERATOR_KEYS: Record<string, string> = {
  "\u2318": "CmdOrCtrl",
  "\u21e7": "Shift",
  "\u2325": "Alt",
  "\u2303": "Ctrl",
  "\u2212": "-",
};

// A native accelerator takes its key before the webview sees it, wherever focus
// is, so only a `global` key, which already fires everywhere, can be one. The
// others would be taken from the terminal, the composer or CodeMirror.
function accelerator(c: Command): string | undefined {
  if (c.scope !== "global" || !c.keys) return undefined;
  return c.keys.map((k) => ACCELERATOR_KEYS[k] ?? k).join("+");
}

export function menuSpec(): MenuSpec[] {
  return LAYOUT.map(([title, slots]) => ({
    title,
    items: slots.map((slot) => {
      if (typeof slot !== "string") return slot;
      const c = COMMANDS.find((c) => c.id === slot);
      if (!c?.run) throw new Error(`menu bar lists ${slot}, which has nothing to run`);
      return { kind: "command", id: c.id, label: c.label, accelerator: accelerator(c) };
    }),
  }));
}
