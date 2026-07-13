// Registry of themes shipped with Sway. Both are selectable now that the chrome
// is token-driven (light values resolve via :root[data-theme="light"]).
import darkPlus from "./themes/dark-plus.json";
import lightPlus from "./themes/light-plus.json";
import { type RawTheme } from "./vscodeMap";

export type BundledTheme = {
  id: string;
  label: string;
  kind: "dark" | "light";
  selectable: boolean;
  raw: RawTheme;
};

const THEMES: BundledTheme[] = [
  { id: "dark-plus", label: "Dark+", kind: "dark", selectable: true, raw: darkPlus as unknown as RawTheme },
  { id: "light-plus", label: "Light+", kind: "light", selectable: true, raw: lightPlus as unknown as RawTheme },
];

export const DEFAULT_THEME_ID = "dark-plus";

export function listThemes(): BundledTheme[] {
  return THEMES;
}

/** Themes the picker may offer (light gated off during the migration). */
export function listSelectableThemes(): BundledTheme[] {
  return THEMES.filter((t) => t.selectable);
}

export function getBundledTheme(id: string): BundledTheme | undefined {
  return THEMES.find((t) => t.id === id);
}
