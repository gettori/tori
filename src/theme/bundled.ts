// Registry of themes shipped with Sway. Light+ exists but is not `selectable`
// yet: the picker only offers dark themes until the CSS-module migration
// completes and light mode is un-gated (see plan Phase 5e).
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
  { id: "light-plus", label: "Light+", kind: "light", selectable: false, raw: lightPlus as unknown as RawTheme },
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
