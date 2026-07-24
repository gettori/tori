// Public theme API. A theme is a palette of primitives; roles.ts expands it into
// the semantic role set, which is painted onto <html> as inline custom
// properties. The token layer (styles/tokens.css) is the pre-theme fallback.
import { emit, THEME_APPLIED } from "../utils/events";
import { applyResolved } from "./resolver";
import { buildRoles, ROLE_BY_CSS_VAR } from "./roles";
import type { Appearance } from "./schema";
import { DEFAULT_THEME_ID, getBundledTheme } from "./bundled";

export { listSelectableThemes, listThemes, DEFAULT_THEME_ID } from "./bundled";
export type { BundledTheme } from "./bundled";

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

function apply(resolved: Record<string, string>, appearance: Appearance | null, sel: Selected) {
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

/** Select a bundled theme by id. */
export function setTheme(id: string) {
  const theme = getBundledTheme(id) ?? getBundledTheme(DEFAULT_THEME_ID);
  if (!theme) return;
  apply(buildRoles(theme.palette), theme.appearance, { kind: theme.appearance, bundledId: theme.id });
}
