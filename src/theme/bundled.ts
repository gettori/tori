// Registry of themes shipped with Tori. Each is a palette of primitives that
// roles.ts expands into the full role set; nothing here is a VS Code theme.
import atomOneLight from "./palettes/atom-one-light.json";
import ayuDark from "./palettes/ayu-dark.json";
import ayuLight from "./palettes/ayu-light.json";
import catppuccinFrappe from "./palettes/catppuccin-frappe.json";
import catppuccinLatte from "./palettes/catppuccin-latte.json";
import catppuccinMacchiato from "./palettes/catppuccin-macchiato.json";
import catppuccinMocha from "./palettes/catppuccin-mocha.json";
import dracula from "./palettes/dracula.json";
import githubDark from "./palettes/github-dark.json";
import githubLight from "./palettes/github-light.json";
import nightOwl from "./palettes/night-owl.json";
import nord from "./palettes/nord.json";
import oneDarkPro from "./palettes/one-dark-pro.json";
import quietLight from "./palettes/quiet-light.json";
import rosePineDawn from "./palettes/rose-pine-dawn.json";
import shadesOfPurple from "./palettes/shades-of-purple.json";
import solarizedLight from "./palettes/solarized-light.json";
import synthwave84 from "./palettes/synthwave-84.json";
import tokyoNight from "./palettes/tokyo-night.json";
import toriDark from "./palettes/tori-dark.json";
import toriLight from "./palettes/tori-light.json";
import type { Appearance, Palette } from "./schema";

export type BundledTheme = {
  id: string;
  label: string;
  appearance: Appearance;
  selectable: boolean;
  palette: Palette;
};

/** A port's registry entry, read off the palette itself so the two cannot
 *  disagree about an id, a label or which way the theme leans. */
const port = (json: unknown): BundledTheme => {
  const palette = json as Palette;
  return {
    id: palette.id,
    label: palette.label,
    appearance: palette.appearance,
    selectable: true,
    palette,
  };
};

const THEMES: BundledTheme[] = [
  { id: "tori-dark", label: "Tori Dark", appearance: "dark", selectable: true, palette: toriDark as Palette },
  { id: "tori-light", label: "Tori Light", appearance: "light", selectable: true, palette: toriLight as Palette },
  // Ports. Each keeps its source theme's own hues but adopts Tori's fixed
  // families: the champagne gold brand, the session status indicators, and the
  // agent marks are not the port's to repaint (see adr_premium_design_system).
  // Where a source colour missed the contrast gate it was moved the least that
  // clears it, which is why a light port reads darker than its original.
  port(atomOneLight),
  port(ayuDark),
  port(ayuLight),
  port(catppuccinFrappe),
  port(catppuccinLatte),
  port(catppuccinMacchiato),
  port(catppuccinMocha),
  port(dracula),
  port(githubDark),
  port(githubLight),
  port(nightOwl),
  port(nord),
  port(oneDarkPro),
  port(quietLight),
  port(rosePineDawn),
  port(shadesOfPurple),
  port(solarizedLight),
  port(synthwave84),
  port(tokyoNight),
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
