// From `globalThis` because the hotkey suite runs in node, where a test stubs
// `navigator` and re-imports to see the table as the other platform does.
const platform = globalThis.navigator?.platform ?? "";
const os = platform.startsWith("Mac") ? "mac" : platform.startsWith("Win") ? "windows" : "linux";

export const isMac = os === "mac";
export const isWindows = os === "windows";

export const OS_NAME = isMac ? "macOS" : isWindows ? "Windows" : "Linux";
export const FILE_MANAGER = isMac ? "Finder" : isWindows ? "File Explorer" : "File Manager";
export const THIS_MACHINE = isMac ? "this Mac" : "this computer";
export const TRASH = isWindows ? "Recycle Bin" : "Trash";

export const MOD_WORD = isMac ? "Cmd" : "Ctrl";
export const ALT_WORD = isMac ? "Option" : "Alt";

type Mods = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export function mod(e: Pick<Mods, "metaKey" | "ctrlKey">): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

export function otherMod(e: Pick<Mods, "metaKey" | "ctrlKey">): boolean {
  return isMac ? e.ctrlKey : e.metaKey;
}

export function modOnly(e: Mods): boolean {
  return mod(e) && !otherMod(e) && !e.altKey && !e.shiftKey;
}

export function keyLabel(key: string): string {
  switch (key) {
    case "Mod":
      return isMac ? "\u2318" : "Ctrl";
    case "Ctrl":
      return isMac ? "\u2303" : "Ctrl";
    case "Alt":
      return isMac ? "\u2325" : "Alt";
    case "Shift":
      return isMac ? "\u21e7" : "Shift";
    default:
      return key;
  }
}

export function chordLabel(keys: readonly string[]): string {
  return keys.map(keyLabel).join(isMac ? "" : "+");
}
