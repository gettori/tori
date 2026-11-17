import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME_ID, getBundledTheme, listSelectableBundled, listThemes } from "./bundled";
import { readCache, type CacheStore } from ".";
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
  it("offers only Tori's two themes, dark first", () => {
    const ids = listSelectableBundled().map((t) => t.id);
    expect(ids).toEqual(["tori-dark", "tori-light"]);
  });

  it("defaults to Tori Dark", () => {
    expect(getBundledTheme(DEFAULT_THEME_ID)?.id).toBe("tori-dark");
  });

  it("credits every bundled theme with a description, a contributor and a license", () => {
    for (const t of listThemes()) {
      expect(t.palette.description, `${t.id}.description`).toBeTruthy();
      expect(t.palette.contributor, `${t.id}.contributor`).toBeTruthy();
      expect(t.palette.license, `${t.id}.license`).toBeTruthy();
    }
  });

  it("returns undefined for an unknown id, so callers can fall back", () => {
    expect(getBundledTheme("no-such-theme")).toBeUndefined();
  });
});

describe("painting a theme switch", () => {
  const darkRoles = buildRoles(getBundledTheme("tori-dark")!.palette);
  const lightRoles = buildRoles(getBundledTheme("tori-light")!.palette);

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
    target.setProperty("--editor-font-family", "Iosevka");

    paintRoles(target, darkRoles);
    paintRoles(target, lightRoles);

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

describe("the boot cache", () => {
  function fakeStore(seed: Record<string, string>): CacheStore {
    return { getItem: (k) => (k in seed ? seed[k] : null) };
  }

  // These land as inline props on <html>, above every rule in the token layer.
  // A key a future build wrote would otherwise be pinned there permanently.
  it("paints only owned keys, dropping anything else the cache holds", () => {
    const store = fakeStore({
      "tori.theme.v2": JSON.stringify({
        "--fg-default": "#e6e6e6",
        "--ui-line-height": "1.6",
        "--some-future-role": "#ff00ff",
      }),
    });

    expect(readCache(store).tokens).toEqual({ "--fg-default": "#e6e6e6" });
  });

  it("reads the kind and the tokens from the cache", () => {
    const store = fakeStore({
      "tori.theme.selected.v2": JSON.stringify({ kind: "dark", bundledId: "tori-dark" }),
      "tori.theme.v2": JSON.stringify({ "--fg-default": "#e6e6e6" }),
    });

    const { kind, tokens } = readCache(store);

    expect(kind).toBe("dark");
    expect(tokens).toEqual({ "--fg-default": "#e6e6e6" });
  });
});
