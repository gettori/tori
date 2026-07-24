// Public theme API. A theme is a palette of primitives; roles.ts expands it into
// the semantic role set, which is painted onto <html> as inline custom
// properties. The token layer (styles/tokens.css) is the pre-theme fallback.
import { emit, THEME_APPLIED } from "../utils/events";
import { admit } from "./admit";
import type { AdmittedPalette } from "./admit";
import { applyResolved } from "./resolver";
import { buildRoles, ROLE_BY_CSS_VAR } from "./roles";
import type { Appearance, Palette } from "./schema";
import { DEFAULT_THEME_ID, getBundledTheme, listSelectableBundled } from "./bundled";
import { listUserThemes } from "./userThemes";

export { listThemes, DEFAULT_THEME_ID } from "./bundled";
export type { BundledTheme } from "./bundled";
export { listUserThemes, reloadUserThemes } from "./userThemes";
export type { UserTheme } from "./userThemes";

// v2 because the cached token map is keyed by cssVar and Phase 4 renamed every
// one of them. A v1 map is not stale data, it is data in a namespace nothing
// reads: painting it would leave every current name unset, which is the flash
// this cache exists to prevent. So the v1 map is discarded, never migrated.
//
// The *selection* is different. It holds only `{ kind, bundledId }`, neither of
// which is a token name, so it survives the rename intact and is read once from
// v1. That is what keeps the first boot after the upgrade correct: `kind` sets
// data-theme, the token layer paints the right block, and the discarded map
// costs nothing because tokens.css already carries those values.
const LS_TOKENS = "sway.theme.v2"; // resolved { --var: value }, for FOUC-free boot
const LS_SELECTED = "sway.theme.selected.v2";
const LS_LEGACY = ["sway.theme.v1", "sway.theme.selected.v1"] as const;

type Selected = { kind: Appearance | null; bundledId?: string };

/** Just enough of `Storage` to read the cache. Named so the boot path can be
 *  tested without a DOM: vitest runs in node, and the v1 handoff is the one part
 *  of this file that has to be provably right on an upgrade. */
export type CacheStore = Pick<Storage, "getItem" | "removeItem">;

/** Pure core: what a boot should paint, given whatever is in storage. */
export function readCache(store: CacheStore): { kind: Appearance | null; tokens: Record<string, string> } {
  let kind: Appearance | null = null;
  let tokens: Record<string, string> = {};
  try {
    const raw = store.getItem(LS_SELECTED) ?? store.getItem(LS_LEGACY[1]);
    kind = (JSON.parse(raw || "null") as Selected | null)?.kind ?? null;
  } catch {
    // ignore
  }
  try {
    // v2 only. A v1 map is keyed by names nothing reads any more.
    const cached: Record<string, string> = JSON.parse(store.getItem(LS_TOKENS) || "{}");
    // Filtered to the owned key set rather than trusted wholesale. These land as
    // inline props on <html>, which outrank every rule in the token layer, so a
    // stray key from an older build would be pinned where no theme could
    // dislodge it. Storage is the one input here that a future version of this
    // app wrote, and the ownership contract is what makes that safe.
    for (const [name, value] of Object.entries(cached)) {
      if (value && ROLE_BY_CSS_VAR.has(name)) tokens[name] = value;
    }
  } catch {
    // ignore
  }
  return { kind, tokens };
}

/** Both v1 keys go once the selection has been read out of them. The next
 *  `persist()` writes the v2 pair, so this runs before any theme is applied. */
export function dropLegacy(store: CacheStore) {
  try {
    for (const key of LS_LEGACY) store.removeItem(key);
  } catch {
    // ignore
  }
}

function persist(sel: Selected, resolved: Record<string, string>) {
  try {
    localStorage.setItem(LS_SELECTED, JSON.stringify(sel));
    localStorage.setItem(LS_TOKENS, JSON.stringify(resolved));
  } catch {
    // ignore quota
  }
}

/** Paint an ADMITTED palette. The parameter type is the enforcement: `admit()`
 *  is the only producer of an `AdmittedPalette`, so a theme that has not been
 *  validated and gated cannot reach this function, whatever the caller intends. */
function apply(palette: AdmittedPalette, appearance: Appearance | null, sel: Selected) {
  const resolved = buildRoles(palette);
  applyResolved(resolved, appearance);
  persist({ ...sel, kind: appearance ?? sel.kind }, resolved);
  emit(THEME_APPLIED);
}

/** Synchronous: paint the last-known theme before first render, so the UI never
 *  flashes. Reads only the cached resolved tokens + kind; the token layer owns
 *  any fallback, so a first-ever boot with no cache still paints from CSS. */
export function applyCachedTheme() {
  const { kind, tokens } = readCache(localStorage);
  if (kind) document.documentElement.dataset.theme = kind === "light" ? "light" : "dark";
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(tokens)) {
    if (value) style.setProperty(name, value);
  }
  dropLegacy(localStorage);
}

/** A theme the picker can offer, from either source. `source` is `"bundled"` or
 *  the absolute path of the file that defined it. */
export type ThemeChoice = {
  id: string;
  label: string;
  appearance: Appearance;
  palette: Palette;
  source: string;
};

/** Every theme that may be offered: the bundled set, then the user themes that
 *  passed the gate. A refused user theme is deliberately absent - the picker
 *  must not offer a theme that selecting would refuse. */
export function listSelectableThemes(): ThemeChoice[] {
  return [
    ...listSelectableBundled().map((t) => ({
      id: t.id,
      label: t.label,
      appearance: t.appearance,
      palette: t.palette,
      source: "bundled",
    })),
    ...listUserThemes()
      .filter((t) => t.problems.length === 0)
      .map((t) => ({ id: t.id, label: t.label, appearance: t.appearance, palette: t.palette, source: t.source })),
  ];
}

/** Look up a theme by id across both sources. Unlike `listSelectableThemes`
 *  this DOES return a user theme the gate refused, so `setTheme` can say why it
 *  will not paint it rather than the much less useful "no such theme". */
export function getTheme(id: string): ThemeChoice | undefined {
  const bundled = getBundledTheme(id);
  if (bundled) {
    return {
      id: bundled.id,
      label: bundled.label,
      appearance: bundled.appearance,
      palette: bundled.palette,
      source: "bundled",
    };
  }
  const user = listUserThemes().find((t) => t.id === id);
  if (!user) return undefined;
  return { id: user.id, label: user.label, appearance: user.appearance, palette: user.palette, source: user.source };
}

/** Select a theme by id, from either source. Returns the problems worth showing
 *  the user; empty means the theme was painted.
 *
 *  The two failure modes are deliberately different:
 *
 *  - an id nothing provides (a deleted file, a typo in settings.json) falls back
 *    to the default, because the alternative is an app with no theme at all;
 *  - a theme that exists but fails the gate paints NOTHING, so the app stays on
 *    whatever it was showing. Replacing a legible theme with the default over an
 *    edit the user is still making would be a worse answer than saying so. */
export function setTheme(id: string): string[] {
  const choice = getTheme(id);
  if (!choice) {
    const fallback = getTheme(DEFAULT_THEME_ID);
    if (!fallback) return [`theme "${id}" is not installed, and neither is the default`];
    const admission = admit(fallback.palette, fallback.id);
    if (!admission.ok) return admission.problems;
    apply(admission.palette, fallback.appearance, { kind: fallback.appearance, bundledId: fallback.id });
    return [`theme "${id}" is not installed; using ${fallback.label}`];
  }

  const admission = admit(choice.palette, choice.source === "bundled" ? choice.id : choice.source);
  // Prefixed so this reads differently from the same refusal reported when the
  // folder was scanned: that one says the file is unusable, this one says the
  // theme you just asked for is the reason nothing changed.
  if (!admission.ok) return admission.problems.map((p) => `cannot apply theme "${choice.id}": ${p}`);
  apply(admission.palette, choice.appearance, { kind: choice.appearance, bundledId: choice.id });
  return [];
}
