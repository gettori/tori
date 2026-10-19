import type { Shortcut } from "./pick";

// macOS reports a shortcut as modifier symbols then the key; elsewhere as "Alt+Shift+C".
const SYMBOLS: Record<string, [string, string]> = {
  "\u2303": ["Ctrl", "Control"],
  "\u2325": ["Option", "Alt"],
  "\u21e7": ["Shift", "Shift"],
  "\u2318": ["Cmd", "Meta"],
};

const ARIA: Record<string, string> = { Ctrl: "Control", Command: "Meta", MacCtrl: "Control" };

export function readShortcut(raw: string | undefined): Shortcut | null {
  if (!raw) return null;
  if (raw.includes("+")) {
    const keys = raw.split("+");
    return { label: raw, aria: keys.map((k) => ARIA[k] ?? k).join("+") };
  }
  const chars = [...raw];
  const mods = chars.filter((c) => c in SYMBOLS).map((c) => SYMBOLS[c]);
  const key = chars.filter((c) => !(c in SYMBOLS)).join("");
  return {
    label: [...mods.map((m) => m[0]), key].join("+"),
    aria: [...mods.map((m) => m[1]), key].join("+"),
  };
}

export async function pickShortcut(): Promise<Shortcut | null> {
  const commands = await chrome.commands.getAll();
  return readShortcut(commands.find((c) => c.name === "pick")?.shortcut);
}
