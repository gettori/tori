// Paint a resolved role map onto <html>.
//
// KEY OWNERSHIP (see adr_theme_palette_roles). Three writers set inline custom
// properties on the document element, and inline props outrank every rule in the
// token layer including :root[data-theme="light"]. So each writer owns a
// disjoint key set, only ever overwrites its own keys, and never clears the
// element's style wholesale:
//
//   - this module owns exactly the role cssVars, and nothing else;
//   - settingsStore.applySettings owns --ui-* and --editor-font-*;
//   - the themes watcher writes through this module and owns nothing of its own.
import { ROLES } from "./roles";
import type { Appearance } from "./schema";

/** The exact key set this module owns. */
const OWNED = ROLES.map((r) => r.cssVar);

/** The slice of CSSStyleDeclaration this module needs. Declared so the paint
 *  step can be exercised without a DOM: the test stack runs in node. */
export type StyleTarget = {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
};

/** Write the owned key set to `style`, and nothing else.
 *
 *  Every owned key is either written or explicitly removed. Removing matters:
 *  it hands the role back to the token layer's fallback instead of leaving the
 *  previous theme's value stranded above it. Keys outside OWNED are never
 *  touched, which is what keeps --ui-scale and --editor-font-family alive
 *  across a theme switch. */
export function paintRoles(style: StyleTarget, resolved: Record<string, string>) {
  for (const cssVar of OWNED) {
    const value = resolved[cssVar];
    if (value) style.setProperty(cssVar, value);
    else style.removeProperty(cssVar);
  }
}

/** Paint the resolved roles onto <html> and set light/dark for the token layer. */
export function applyResolved(resolved: Record<string, string>, appearance: Appearance | null) {
  const root = document.documentElement;
  paintRoles(root.style, resolved);
  root.dataset.theme = appearance === "light" ? "light" : "dark";
}
