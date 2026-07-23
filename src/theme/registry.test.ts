import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID, getBundledTheme, listSelectableThemes } from "./bundled";
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
  it("offers both Sway themes", () => {
    expect(listSelectableThemes().map((t) => t.id)).toEqual(["sway-dark", "sway-light"]);
    expect(listSelectableThemes().map((t) => t.label)).toEqual(["Sway Dark", "Sway Light"]);
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
    expect(props.get("--bg")).toBe("#15171c");
    expect(props.get("--syn-keyword")).toBe("#569cd6");

    paintRoles(target, lightRoles);
    expect(props.get("--bg")).toBe("#ffffff");
    expect(props.get("--syn-keyword")).toBe("#0000ff");
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
    expect(props.get("--accent")).toBe("#4a9eff");

    const partial = { ...lightRoles };
    delete partial["--accent"];
    paintRoles(target, partial);

    expect(props.has("--accent")).toBe(false);
  });
});
