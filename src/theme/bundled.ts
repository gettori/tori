// Registry of themes shipped with Sway. Each is a palette of primitives that
// roles.ts expands into the full role set; nothing here is a VS Code theme.
import catppuccinMocha from "./palettes/catppuccin-mocha.json";
import rosePineDawn from "./palettes/rose-pine-dawn.json";
import swayDark from "./palettes/sway-dark.json";
import swayLight from "./palettes/sway-light.json";
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
  { id: "sway-dark", label: "Sway Dark", appearance: "dark", selectable: true, palette: swayDark as Palette },
  { id: "sway-light", label: "Sway Light", appearance: "light", selectable: true, palette: swayLight as Palette },
  // Ports. Each keeps its source theme's own hues but adopts Sway's fixed
  // families: the champagne gold brand, the session status indicators, and the
  // agent marks are not the port's to repaint (see adr_premium_design_system).
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", appearance: "dark", selectable: true, palette: catppuccinMocha as Palette },
  { id: "tokyo-night", label: "Tokyo Night", appearance: "dark", selectable: true, palette: tokyoNight as Palette },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", appearance: "light", selectable: true, palette: rosePineDawn as Palette },
];

export const DEFAULT_THEME_ID = "sway-dark";

// Ids persisted by the VS Code-theme era. Resolved here so an existing install
// keeps the theme it chose the moment this ships; rewriting the stored settings
// (and dropping appearance.importPath) is the migration's job, not the
// registry's. Without this, a Light+ user silently lands on dark.
const LEGACY_IDS = new Map([
  ["dark-plus", "sway-dark"],
  ["light-plus", "sway-light"],
  ["import", "sway-dark"],
]);

export function listThemes(): BundledTheme[] {
  return THEMES;
}

/** Themes the picker may offer. */
export function listSelectableThemes(): BundledTheme[] {
  return THEMES.filter((t) => t.selectable);
}

export function getBundledTheme(id: string): BundledTheme | undefined {
  const canonical = LEGACY_IDS.get(id) ?? id;
  return THEMES.find((t) => t.id === canonical);
}
