import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME_ID, getBundledTheme, listSelectableBundled } from "./bundled";
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
  it("offers the two Tori themes, then the ports in alphabetical order", () => {
    const ids = listSelectableBundled().map((t) => t.id);
    // Tori's own two lead the registry; the picker sorts by label on its own.
    expect(ids.slice(0, 2)).toEqual(["tori-dark", "tori-light"]);
    expect(ids.slice(2)).toEqual([...ids.slice(2)].sort());
    expect(ids).toHaveLength(22);
    expect(new Set(ids).size).toBe(22);
  });

  it("defaults to Tori Dark", () => {
    expect(getBundledTheme(DEFAULT_THEME_ID)?.id).toBe("tori-dark");
  });

  // Without this an existing Light+ install silently lands on dark the moment
  // the VS Code registry is replaced.
  it.each([
    ["dark-plus", "tori-dark"],
    ["light-plus", "tori-light"],
    ["import", "tori-dark"],
  ])("resolves the legacy id %s to %s", (legacy, canonical) => {
    expect(getBundledTheme(legacy)?.id).toBe(canonical);
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

  // The pre-rename names, written out. They used to be derived through the
  // rename table, so a stale fixture could not read as a missed call site while
  // the codemod was still runnable; both the table and the codemod are retired
  // now, so these are simply historical strings that nothing in the app emits.
  it("keeps the kind from a v1 selection and discards the v1 token map", () => {
    const store = fakeStore({
      "tori.theme.selected.v1": JSON.stringify({ kind: "light", bundledId: "light-plus" }),
      "tori.theme.v1": JSON.stringify({
        "--text": "#1f2328", // now --fg-default
        "--bg": "#ffffff", // now --canvas-default
      }),
    });

    const { kind, tokens } = readCache(store);

    expect(kind).toBe("light");
    expect(tokens).toEqual({});
  });

  it("clears both v1 keys, so the next boot reads only v2", () => {
    const store = fakeStore({
      "tori.theme.selected.v1": JSON.stringify({ kind: "light" }),
      "tori.theme.v1": "{}",
    });

    dropLegacy(store);

    expect(Object.keys(store.seed)).toEqual([]);
    expect(readCache(store).kind).toBeNull();
  });

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

  it("prefers v2 once it exists, under the new names", () => {
    const store = fakeStore({
      "tori.theme.selected.v2": JSON.stringify({ kind: "dark", bundledId: "tori-dark" }),
      "tori.theme.selected.v1": JSON.stringify({ kind: "light" }),
      "tori.theme.v2": JSON.stringify({ "--fg-default": "#e6e6e6" }),
    });

    const { kind, tokens } = readCache(store);

    expect(kind).toBe("dark");
    expect(tokens).toEqual({ "--fg-default": "#e6e6e6" });
  });
});
