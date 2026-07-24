import { describe, expect, it } from "vitest";
import {
  CONTRAST_RULES,
  checkPalette,
  composite,
  contrastRatio,
  formatReport,
  parseColor,
  ratioOn,
} from "./contrast";
import { listThemes } from "./bundled";
import swayDark from "./palettes/sway-dark.json";
import swayLight from "./palettes/sway-light.json";
import { ROLES } from "./roles";
import type { Palette } from "./schema";

const dark = swayDark as Palette;
const light = swayLight as Palette;
// Every bundled theme, read from the registry rather than listed: a port added
// without a gate run is exactly what this is here to make impossible.
const PALETTES: [string, Palette][] = listThemes().map((t) => [t.id, t.palette]);

/** A palette with one primitive replaced, for the negative probes. */
function planted(base: Palette, key: string, value: string): Palette {
  return { ...base, colors: { ...base.colors, [key]: value } };
}

describe("contrast maths", () => {
  it("parses hex and rgba(), and rejects a box-shadow value", () => {
    expect(parseColor("#fff")).toEqual({ rgb: [255, 255, 255], a: 1 });
    expect(parseColor("#2ea043")).toEqual({ rgb: [46, 160, 67], a: 1 });
    expect(parseColor("rgba(200, 215, 255, 0.08)")).toEqual({ rgb: [200, 215, 255], a: 0.08 });
    expect(parseColor("0 4px 12px rgba(0, 0, 0, 0.45)")).toBeNull();
  });

  // The two anchors every implementation is checked against: pure black on pure
  // white is 21, and anything on itself is 1.
  it("agrees with the WCAG reference values", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([46, 160, 67], [46, 160, 67])).toBeCloseTo(1, 5);
  });

  // A wash has no contrast of its own: what a reader sees is the composite, so
  // measuring the wash's own channels would report a colour never on screen.
  it("composites a translucent foreground before measuring", () => {
    expect(composite({ rgb: [255, 255, 255], a: 0.5 }, [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
    expect(ratioOn("rgba(255, 255, 255, 1)", "#000000")).toBeCloseTo(21, 5);
    // The same white at 50% over black is far dimmer than the opaque one.
    expect(ratioOn("rgba(255, 255, 255, 0.5)", "#000000")!).toBeLessThan(6);
  });

  // This is the number the whole gate exists for: VS Code's Light+ shipped an
  // ANSI green at 2.56 on white, which is what a test runner prints PASS in.
  it("reproduces the Light+ ANSI green measurement", () => {
    expect(ratioOn("#00BC00", "#ffffff")!).toBeCloseTo(2.56, 2);
  });
});

describe("the rule table", () => {
  // A role with no rule must be an error rather than a skip. A gate that
  // silently ignores what it was not told about passes the day someone adds a
  // role, which is the exact failure it exists to prevent.
  it("declares exactly the roles that exist", () => {
    const ruled = new Set(Object.keys(CONTRAST_RULES));
    const declared = new Set(ROLES.map((r) => r.id));
    expect([...declared].filter((id) => !ruled.has(id))).toEqual([]);
    expect([...ruled].filter((id) => !declared.has(id))).toEqual([]);
  });

  it("gives a reason for every role it does not measure", () => {
    const silent = ROLES.filter((r) => {
      const rule = CONTRAST_RULES[r.id];
      return !rule.fg && !rule.surface && !rule.why;
    });
    expect(silent.map((r) => r.id)).toEqual([]);
  });
});

describe("the bundled palettes", () => {
  it.each(PALETTES)("%s passes the gate", (_id, palette) => {
    expect(formatReport(checkPalette(palette))).toEqual([]);
  });

  // Deleting a surface declaration must FAIL the gate, not quietly drop the
  // pairs that referenced it: a skipped measurement reads exactly like a passing
  // one in the output.
  it("fails when a surface stops being declared as one", () => {
    const rules = { ...CONTRAST_RULES, "canvas.card": { why: "no longer a surface" } };
    const report = checkPalette(dark, rules);
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.problems.join("\n")).toContain("canvas.card, which is not declared as a surface");
  });

  it("fails when a role loses its rule entirely", () => {
    const rules = { ...CONTRAST_RULES };
    delete rules["fg.default"];
    const report = checkPalette(dark, rules);
    expect(report.problems.join("\n")).toContain("role fg.default has no contrast rule");
  });

  it("fails on Light+'s original ANSI green", () => {
    const report = checkPalette(planted(light, "ansiGreen", "#00BC00"));
    expect(report.failures.map((f) => f.role)).toContain("ansi.green");
    const green = report.failures.find((f) => f.role === "ansi.green")!;
    expect(green.ratio).toBeLessThan(3);
  });

  // gold-600 is the value the brand moved OFF, measured at 2.95 on the panel
  // head and 2.76 on the selection. Both misses must still be caught, or the
  // gate would wave the regression straight back in.
  it("fails on gold-600 as the light brand, on both of its historic misses", () => {
    const report = checkPalette(planted(light, "brand", "#c9a227"));
    const surfaces = report.failures
      .filter((f) => f.role === "brand.default")
      .map((f) => f.surface);
    expect(surfaces).toContain("canvas.head");
    expect(surfaces).toContain("accent.subtle");
  });
});
