import { describe, expect, it } from "vitest";
import baseline from "./__baseline__/tokens-baseline.json";
import swayDark from "./palettes/sway-dark.json";
import swayLight from "./palettes/sway-light.json";
import { alpha, buildRoles, mix, ROLES, variants } from "./roles";
import { PALETTE_KEYS, validatePalette, type Palette } from "./schema";

const dark = swayDark as Palette;
const light = swayLight as Palette;
const PALETTES: [string, Palette, Record<string, string>][] = [
  ["sway-dark", dark, baseline.dark],
  ["sway-light", light, baseline.light],
];

describe("derivation helpers", () => {
  it("alpha() washes a hex to an rgba() string", () => {
    expect(alpha("#c8d7ff", 0.08)).toBe("rgba(200, 215, 255, 0.08)");
    expect(alpha("#2ea043", 0.32)).toBe("rgba(46, 160, 67, 0.32)");
  });

  // A light theme opts out of the wash entirely rather than carrying a second
  // "solid or not" flag, so this identity is load-bearing, not a nicety.
  it("alpha() at 1 returns the hex untouched, not an opaque rgba()", () => {
    expect(alpha("#e0e0e0", 1)).toBe("#e0e0e0");
  });

  it("mix() blends toward the top colour and stays opaque", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#15171c", "#c8d7ff", 0)).toBe("#15171c");
    expect(mix("#15171c", "#c8d7ff", 1)).toBe("#c8d7ff");
  });

  it("variants() selects by appearance", () => {
    expect(variants("dark")({ dark: "d", light: "l" })).toBe("d");
    expect(variants("light")({ dark: "d", light: "l" })).toBe("l");
  });
});

describe("palettes", () => {
  it.each(PALETTES)("%s is structurally valid", (_id, palette) => {
    expect(validatePalette(palette)).toEqual([]);
  });

  it.each(PALETTES)("%s declares every palette key exactly once", (_id, palette) => {
    expect(Object.keys(palette.colors).sort()).toEqual([...PALETTE_KEYS].sort());
  });
});

describe("role table", () => {
  it("has unique ids and unique cssVars", () => {
    expect(new Set(ROLES.map((r) => r.id)).size).toBe(ROLES.length);
    expect(new Set(ROLES.map((r) => r.cssVar)).size).toBe(ROLES.length);
  });

  it.each(PALETTES)("%s produces a concrete value for every role", (_id, palette) => {
    const built = buildRoles(palette);
    expect(Object.keys(built)).toHaveLength(ROLES.length);
    for (const role of ROLES) {
      const value = built[role.cssVar];
      expect(value, role.id).toBeTypeOf("string");
      expect(value, role.id).not.toBe("");
      // A var() here would defer the value back to the token layer, which is
      // exactly the runtime-fallback coupling this generator replaces.
      expect(value, role.id).not.toContain("var(");
      expect(value, role.id).not.toContain("undefined");
    }
  });
});

// The proof that the new engine is behaviour-preserving. The baseline is a
// committed snapshot of the hand-written token layer, resolved through
// scripts/resolve-tokens.mjs, frozen BEFORE anything regenerates tokens.css - so
// this comparison is against the old world, not against the generator's own
// output.
describe("generated roles reproduce the frozen token layer", () => {
  it.each(PALETTES)("%s matches the baseline key by key", (_id, palette, expected) => {
    const built = buildRoles(palette);
    expect(Object.keys(built).sort()).toEqual(Object.keys(expected).sort());
    for (const [cssVar, want] of Object.entries(expected)) {
      expect(built[cssVar], cssVar).toBe(want);
    }
  });

  it("covers all 150 baseline entries across both themes", () => {
    expect(Object.keys(baseline.dark)).toHaveLength(75);
    expect(Object.keys(baseline.light)).toHaveLength(75);
    expect(ROLES).toHaveLength(75);
  });
});
