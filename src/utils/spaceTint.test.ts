import { describe, it, expect } from "vite-plus/test";
import {
  SPACE_COLORS, resolveColor, fallbackColor, spaceHue, spaceHueRgb, rgbTriple, applySpaceTint,
} from "./spaceTint";

/** A stand-in for `<html>`, so the writer is tested without a document. */
function target() {
  const props = new Map<string, string>();
  return {
    props,
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => void props.delete(name),
    } as unknown as CSSStyleDeclaration,
  };
}

describe("spaceTint", () => {
  it("exposes uniquely named, uniquely coloured swatches", () => {
    expect(SPACE_COLORS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(SPACE_COLORS.map((c) => c.name)).size).toBe(SPACE_COLORS.length);
    expect(new Set(SPACE_COLORS.map((c) => c.hex)).size).toBe(SPACE_COLORS.length);
  });

  it("stores opaque hues only, so the shell can mix its own strength", () => {
    // An alpha baked into a swatch would double up with the shell's mix and
    // make a space's wash invisible.
    for (const c of SPACE_COLORS) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("resolves a known swatch, and misses gracefully", () => {
    expect(resolveColor("Teal")).toBe(SPACE_COLORS.find((c) => c.name === "Teal")!.hex);
    expect(resolveColor("NotAColour")).toBeUndefined();
    expect(resolveColor("")).toBeUndefined();
    expect(resolveColor(null)).toBeUndefined();
  });

  it("derives a stable hue per name, and spreads across the set", () => {
    expect(fallbackColor("personal")).toBe(fallbackColor("personal"));
    const names = ["personal", "work", "initech", "hooli", "side", "labs", "docs", "ops"];
    expect(new Set(names.map(fallbackColor)).size).toBeGreaterThan(4);
  });

  it("prefers a chosen swatch and falls back to the derived hue", () => {
    expect(spaceHue("personal", "Teal")).toBe(resolveColor("Teal"));
    expect(spaceHue("personal", null)).toBe(fallbackColor("personal"));
    // A swatch that no longer exists must not blank the window.
    expect(spaceHue("personal", "Retired")).toBe(fallbackColor("personal"));
  });

  it("writes only its own key, and hands it back when there is no space", () => {
    const hue = SPACE_COLORS[0].hex;
    const el = target();
    applySpaceTint(hue, el);
    expect(el.props.get("--space-tint-rgb")).toBe(rgbTriple(hue));
    expect(el.props.size).toBe(1);

    // Clearing REMOVES the property rather than writing a default: an inline
    // value on <html> outranks the token layer, so leaving one behind would pin
    // a hue above every theme and no palette could dislodge it.
    applySpaceTint(null, el);
    expect(el.props.has("--space-tint-rgb")).toBe(false);
  });

  it("emits a bare channel triple, which is what CSS composes an alpha with", () => {
    // Not a colour: `rgb(var(--x) / 14%)` needs three numbers, and a hex here
    // would make every wash in the app an invalid declaration.
    expect(rgbTriple("#d9a468")).toBe("217 164 104");
    expect(rgbTriple("#fff")).toBe("255 255 255");
    expect(spaceHueRgb("personal", "Teal")).toMatch(/^\d+ \d+ \d+$/);
  });

  it("never disturbs another writer's inline properties", () => {
    // <html> is shared with the theme resolver and the settings store; the
    // contract is that each writer touches only its own keys.
    const el = target();
    el.props.set("--ui-scale", "1.2");
    el.props.set("--canvas-default", "owned-by-the-resolver");
    applySpaceTint(SPACE_COLORS[1].hex, el);
    applySpaceTint(null, el);
    expect(el.props.get("--ui-scale")).toBe("1.2");
    expect(el.props.get("--canvas-default")).toBe("owned-by-the-resolver");
  });
});
