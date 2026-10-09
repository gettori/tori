// Registry of themes shipped with Tori. Each is a palette of primitives that
// roles.ts expands into the full role set; nothing here is a VS Code theme.
import type { Appearance, Palette } from "./schema";

export type BundledTheme = {
  id: string;
  label: string;
  appearance: Appearance;
  selectable: boolean;
  palette: Palette;
};

/** A theme's registry entry, read off the palette itself so the two cannot
 *  disagree about an id, a label or which way the theme leans. */
const entry = (json: unknown): BundledTheme => {
  const palette = json as Palette;
  return {
    id: palette.id,
    label: palette.label,
    appearance: palette.appearance,
    selectable: true,
    palette,
  };
};

const palettes = import.meta.glob<unknown>("../../src-tauri/packs/themes/*.json", {
  eager: true,
  import: "default",
});

const OWN = new Set(["tori-dark", "tori-light"]);

const ownFirst = (a: BundledTheme, b: BundledTheme) => Number(!OWN.has(a.id)) - Number(!OWN.has(b.id));

// Ports. Each keeps its source theme's own hues but adopts Tori's fixed
// families: the champagne gold brand, the session status indicators, and the
// agent marks are not the port's to repaint (see adr_premium_design_system).
// Where a source colour missed the contrast gate it was moved the least that
// clears it, which is why a light port reads darker than its original.
const THEMES: BundledTheme[] = Object.values(palettes).map(entry).sort(ownFirst);

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
