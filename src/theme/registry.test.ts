import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID, getBundledTheme, listSelectableThemes } from "./bundled";
import { RENAME } from "./__baseline__/rename";
import { dropLegacy, readCache, type CacheStore } from ".";
import { paintRoles, type StyleTarget } from "./resolver";
import { buildRoles, ROLES } from "./roles";

/** A CSSStyleDeclaration stand-in, so the paint step is testable in node. */
function fakeStyle() {
  const props = new Map<string, string>();
  const target: StyleTarget = {
    setProperty: (name, value) => void props.set(name, value),
    removeProperty: (name) => void props.delete(name),
  };
  return { target, props };
}

describe("bundled registry", () => {
  it("offers the two Sway themes and the three ports", () => {
    expect(listSelectableThemes().map((t) => t.id)).toEqual([
      "sway-dark",
      "sway-light",
      "catppuccin-mocha",
      "tokyo-night",
      "rose-pine-dawn",
    ]);
    // Sway's own two lead, so the picker's first entries are the ones the app
    // was designed against.
    expect(listSelectableThemes().slice(0, 2).map((t) => t.label)).toEqual(["Sway Dark", "Sway Light"]);
  });

  it("defaults to Sway Dark", () => {
    expect(getBundledTheme(DEFAULT_THEME_ID)?.id).toBe("sway-dark");
  });

  // Without this an existing Light+ install silently lands on dark the moment
  // the VS Code registry is replaced.
  it.each([
    ["dark-plus", "sway-dark"],
    ["light-plus", "sway-light"],
    ["import", "sway-dark"],
  ])("resolves the legacy id %s to %s", (legacy, canonical) => {
    expect(getBundledTheme(legacy)?.id).toBe(canonical);
  });

  it("returns undefined for an unknown id, so callers can fall back", () => {
    expect(getBundledTheme("no-such-theme")).toBeUndefined();
  });
});

describe("painting a theme switch", () => {
  const darkRoles = buildRoles(getBundledTheme("sway-dark")!.palette);
  const lightRoles = buildRoles(getBundledTheme("sway-light")!.palette);

  it("repaints every role when switching themes", () => {
    const { target, props } = fakeStyle();
    paintRoles(target, darkRoles);
    expect(props.get("--canvas-default")).toBe("#15171c");
    expect(props.get("--syntax-keyword")).toBe("#569cd6");

    paintRoles(target, lightRoles);
    expect(props.get("--canvas-default")).toBe("#ffffff");
    expect(props.get("--syntax-keyword")).toBe("#0000ff");
    expect(props.size).toBe(ROLES.length);
  });

  // The key-ownership contract: inline props on <html> outrank the token layer,
  // so a resolver that wrote outside its own key set would silently destroy the
  // settings store's values.
  it("leaves keys it does not own untouched", () => {
    const { target, props } = fakeStyle();
    target.setProperty("--ui-density", "0.85");
    target.setProperty("--editor-font-family", "Iosevka");

    paintRoles(target, darkRoles);
    paintRoles(target, lightRoles);

    expect(props.get("--ui-density")).toBe("0.85");
    expect(props.get("--editor-font-family")).toBe("Iosevka");
  });

  // A fallback written for an absent key would be pinned above the token layer
  // where no theme could dislodge it, which is the bug this replaces.
  it("removes an owned key the theme omits instead of stranding the old value", () => {
    const { target, props } = fakeStyle();
    paintRoles(target, darkRoles);
    expect(props.get("--accent-fg")).toBe("#4a9eff");

    const partial = { ...lightRoles };
    delete partial["--accent-fg"];
    paintRoles(target, partial);

    expect(props.has("--accent-fg")).toBe(false);
  });
});

// The upgrade path. The cached token map is namespaced by cssVar and every one
// of those names changed, so v1 maps are dropped; the selection is not, so a
// Light install still boots light on the very first launch after the rename
// rather than flashing the dark fallback.
describe("the v1 to v2 cache handoff", () => {
  function fakeStore(seed: Record<string, string>): CacheStore & { seed: Record<string, string> } {
    return {
      seed,
      getItem: (k) => (k in seed ? seed[k] : null),
      removeItem: (k) => void delete seed[k],
    };
  }

  /** The pre-rename name for a current one, looked up rather than written out.
   *  A v1 fixture spelled literally is indistinguishable from a call site the
   *  codemod missed, so the next run would "fix" it and leave this asserting
   *  nothing. Deriving it means the fixture holds no old-name literal at all. */
  const legacy = (current: string) => Object.keys(RENAME).find((old) => RENAME[old] === current)!;

  it("keeps the kind from a v1 selection and discards the v1 token map", () => {
    const store = fakeStore({
      "sway.theme.selected.v1": JSON.stringify({ kind: "light", bundledId: "light-plus" }),
      "sway.theme.v1": JSON.stringify({
        [legacy("--fg-default")]: "#1f2328",
        [legacy("--canvas-default")]: "#ffffff",
      }),
    });

    const { kind, tokens } = readCache(store);

    expect(kind).toBe("light");
    expect(tokens).toEqual({});
  });

  it("clears both v1 keys, so the next boot reads only v2", () => {
    const store = fakeStore({
      "sway.theme.selected.v1": JSON.stringify({ kind: "light" }),
      "sway.theme.v1": "{}",
    });

    dropLegacy(store);

    expect(Object.keys(store.seed)).toEqual([]);
    expect(readCache(store).kind).toBeNull();
  });

  // These land as inline props on <html>, above every rule in the token layer.
  // A key a future build wrote would otherwise be pinned there permanently.
  it("paints only owned keys, dropping anything else the cache holds", () => {
    const store = fakeStore({
      "sway.theme.v2": JSON.stringify({
        "--fg-default": "#e6e6e6",
        "--ui-density": "0.5",
        "--some-future-role": "#ff00ff",
      }),
    });

    expect(readCache(store).tokens).toEqual({ "--fg-default": "#e6e6e6" });
  });

  it("prefers v2 once it exists, under the new names", () => {
    const store = fakeStore({
      "sway.theme.selected.v2": JSON.stringify({ kind: "dark", bundledId: "sway-dark" }),
      "sway.theme.selected.v1": JSON.stringify({ kind: "light" }),
      "sway.theme.v2": JSON.stringify({ "--fg-default": "#e6e6e6" }),
    });

    const { kind, tokens } = readCache(store);

    expect(kind).toBe("dark");
    expect(tokens).toEqual({ "--fg-default": "#e6e6e6" });
  });
});
