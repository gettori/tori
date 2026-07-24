import { describe, expect, it } from "vitest";
import baseline from "./__baseline__/tokens-baseline.json";
import { RENAME } from "./__baseline__/rename";
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
  // Since the Phase 4 flip the two maps no longer share key names, so the
  // comparison goes through RENAME per pair. That is the whole proof the rename
  // was nominal: the key set changed by exactly the table, and not one value
  // moved. Swap two targets in the table and this fails, because each pair is
  // checked against the baseline entry it claims to descend from rather than
  // against a set or a multiset of values (many roles share a value, so a
  // multiset comparison would wave a swap straight through).
  it.each(PALETTES)("%s matches the baseline pair by pair", (_id, palette, expected) => {
    const built = buildRoles(palette);
    // A superset, not an equality: phase 5 widened syntax and added the tree,
    // tab, and editor families, so the role set has grown past the frozen map.
    // What must still hold is that nothing the baseline covered has moved.
    for (const target of Object.values(RENAME)) expect(built, target).toHaveProperty(target);
    for (const [oldVar, want] of Object.entries(expected)) {
      const newVar = RENAME[oldVar];
      expect(newVar, `${oldVar} has no rename entry`).toBeTypeOf("string");
      expect(built[newVar], `${oldVar} -> ${newVar}`).toBe(want);
    }
  });

  it("covers all 150 baseline entries across both themes", () => {
    expect(Object.keys(baseline.dark)).toHaveLength(75);
    expect(Object.keys(baseline.light)).toHaveLength(75);
    expect(Object.keys(RENAME)).toHaveLength(75);
    // The role set only ever grows: every baseline role still exists, plus the
    // families added since. A shrink means a role was dropped rather than
    // renamed, which the pair check above would not catch on its own.
    expect(ROLES.length).toBeGreaterThanOrEqual(75);
  });

  it("renames every baseline key exactly once, onto a distinct name", () => {
    expect(Object.keys(RENAME).sort()).toEqual(Object.keys(baseline.dark).sort());
    expect(new Set(Object.values(RENAME)).size).toBe(Object.keys(RENAME).length);
  });
});

// Widening syntax is only worth anything if the categories are telling apart.
// These six are the ones a reader actually uses to parse a line at a glance,
// and VS Code's Dark+/Light+ (where this ramp started) collapses two of the
// pairs, so they are asserted rather than assumed.
describe("the syntax ramp is legible", () => {
  const MUST_DIFFER = [
    "--syntax-keyword",
    "--syntax-control",
    "--syntax-type",
    "--syntax-class",
    "--syntax-property",
    "--syntax-parameter",
  ];

  it.each(PALETTES)("%s gives each of the six its own value", (_id, palette) => {
    const built = buildRoles(palette);
    const values = MUST_DIFFER.map((name) => {
      expect(built, name).toHaveProperty(name);
      return built[name];
    });
    expect(new Set(values).size).toBe(MUST_DIFFER.length);
  });

  it.each(PALETTES)("%s covers all 20 syntax categories", (_id, palette) => {
    const built = buildRoles(palette);
    const syntax = ROLES.filter((r) => r.group === "syntax");
    expect(syntax).toHaveLength(20);
    for (const role of syntax) expect(built[role.cssVar], role.id).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// Adopting the tree/tab/activity roles must not restyle anything: they were
// introduced as aliases so the surfaces become themeable, not so they change.
// If one of these pairs ever diverges that is a design decision, and it should
// arrive as a failing test rather than as a surprise in a screenshot.
describe("the new surface roles start as exact aliases", () => {
  const ALIASES: [string, string][] = [
    ["--tree-row-hover", "--neutral-hover"],
    ["--tree-row-active", "--accent-subtle"],
    ["--tab-active-bg", "--neutral-hover"],
    ["--tab-hover-bg", "--neutral-hover"],
    ["--tab-active-fg", "--fg-default"],
    ["--tab-inactive-fg", "--fg-muted"],
    ["--tab-dirty", "--brand-default"],
    ["--activity-touched", "--accent-fg"],
    ["--activity-editing", "--brand-default"],
  ];

  it.each(PALETTES)("%s resolves each new role to the value it replaced", (_id, palette) => {
    const built = buildRoles(palette);
    for (const [added, replaced] of ALIASES) {
      expect(built[added], `${added} should still equal ${replaced}`).toBe(built[replaced]);
    }
  });
});

// The file tree used to be pinned to seti's dark-variant hexes, so icons stayed
// dark-canvas coloured over a light theme. The mapping now names a hue and the
// theme supplies the value, which is only worth anything if the two themes
// actually resolve those names differently.
describe("file-icon hues follow the theme", () => {
  const HUES = ROLES.filter((r) => r.group === "scale");

  it("declares all 11 seti hues", () => {
    expect(HUES).toHaveLength(11);
  });

  it("resolves every hue to a different value in each theme", () => {
    const darkBuilt = buildRoles(dark);
    const lightBuilt = buildRoles(light);
    for (const role of HUES) {
      expect(darkBuilt[role.cssVar], role.id).not.toBe(lightBuilt[role.cssVar]);
    }
  });
});
