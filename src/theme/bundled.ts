// Registry of themes shipped with Tori. Each is a palette of primitives that
// roles.ts expands into the full role set; nothing here is a VS Code theme.
import catppuccinMocha from "./palettes/catppuccin-mocha.json";
import rosePineDawn from "./palettes/rose-pine-dawn.json";
import toriDark from "./palettes/tori-dark.json";
import toriLight from "./palettes/tori-light.json";
import tokyoNight from "./palettes/tokyo-night.json";
import type { Appearance, Palette } from "./schema";

export type BundledTheme = {
  id: string;
  label: string;
  appearance: Appearance;
  selectable: boolean;
  palette: Palette;
};

const THEMES: BundledTheme[] = [
  { id: "tori-dark", label: "Tori Dark", appearance: "dark", selectable: true, palette: toriDark as Palette },
  { id: "tori-light", label: "Tori Light", appearance: "light", selectable: true, palette: toriLight as Palette },
  // Ports. Each keeps its source theme's own hues but adopts Tori's fixed
  // families: the champagne gold brand, the session status indicators, and the
  // agent marks are not the port's to repaint (see adr_premium_design_system).
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", appearance: "dark", selectable: true, palette: catppuccinMocha as Palette },
  { id: "tokyo-night", label: "Tokyo Night", appearance: "dark", selectable: true, palette: tokyoNight as Palette },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", appearance: "light", selectable: true, palette: rosePineDawn as Palette },
];

export const DEFAULT_THEME_ID = "tori-dark";

// Ids persisted by the VS Code-theme era. Resolved here so an existing install
// keeps the theme it chose the moment this ships; rewriting the stored settings
// (and dropping appearance.importPath) is the migration's job, not the
// registry's. Without this, a Light+ user silently lands on dark.
const LEGACY_IDS = new Map([
  ["dark-plus", "tori-dark"],
  ["light-plus", "tori-light"],
  ["import", "tori-dark"],
]);

export function listThemes(): BundledTheme[] {
  return THEMES;
}

/** Bundled themes the picker may offer. The picker's full list is
 *  `listSelectableThemes` in index.ts, which folds in the user themes. */
export function listSelectableBundled(): BundledTheme[] {
  return THEMES.filter((t) => t.selectable);
}

export function getBundledTheme(id: string): BundledTheme | undefined {
  const canonical = LEGACY_IDS.get(id) ?? id;
  return THEMES.find((t) => t.id === canonical);
}
