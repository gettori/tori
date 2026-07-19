import { describe, it, expect } from "vitest";
import { distillVsCodeTheme } from "./distill";
import { resolveTheme } from "./resolver";
import { MAP, SYN_MAP, type RawTheme } from "./vscodeMap";
import { listThemes, listSelectableThemes } from "./bundled";
import darkPlus from "./themes/dark-plus.json";
import lightPlus from "./themes/light-plus.json";

const DARK = darkPlus as unknown as RawTheme;
const LIGHT = lightPlus as unknown as RawTheme;

describe("distillVsCodeTheme", () => {
  it("extracts colors and all seven syntax categories from bundled Dark+", () => {
    const tc = distillVsCodeTheme(DARK);
    expect(tc.kind).toBe("dark");
    expect(tc.colors["editor.background"]).toBe("#0e141b");
    expect(tc.syntax).toEqual({
      keyword: "#569cd6",
      string: "#ce9178",
      comment: "#6a9955",
      number: "#b5cea8",
      function: "#dcdcaa",
      type: "#4ec9b0",
      variable: "#9cdcfe",
    });
  });

  it("resolves a syntax category via the shortest scope prefix", () => {
    // no exact "string", only "string.quoted.double" -> matched by prefix
    const raw: RawTheme = {
      type: "dark",
      tokenColors: [{ scope: ["string.quoted.double", "string.template"], settings: { foreground: "#abcdef" } }],
    };
    expect(distillVsCodeTheme(raw).syntax.string).toBe("#abcdef");
  });
});

describe("resolveTheme", () => {
  it("maps the default dark theme to the cool-navy chrome tokens", () => {
    const resolved = resolveTheme(distillVsCodeTheme(DARK));
    expect(resolved).toMatchObject({
      "--bg": "#0e141b",
      "--pane-bg": "#111720",
      "--pane-head-bg": "#1b232e",
      "--border": "#232c38",
      "--text": "#e6e9f0",
      "--text-dim": "#8b929e",
      "--accent": "#4a9eff",
      "--sel": "#094771",
      "--hover": "#212b37",
      "--input-bg": "#1b232e",
    });
  });

  it("sets every semantic token (no var left undefined) for Dark+", () => {
    const resolved = resolveTheme(distillVsCodeTheme(DARK));
    for (const [cssVar] of [...MAP, ...SYN_MAP]) {
      expect(resolved[cssVar], `${cssVar} should be set`).toBeTruthy();
    }
  });

  it("Light+ resolves to a distinct (light) palette", () => {
    const resolved = resolveTheme(distillVsCodeTheme(LIGHT));
    expect(resolved["--bg"]).toBe("#ffffff");
    expect(resolved["--text"]).toBe("#1e1e1e");
    expect(resolved["--syn-keyword"]).toBe("#0000ff");
  });
});

describe("bundled themes", () => {
  it("ships and offers both dark and light (light un-gated)", () => {
    expect(listThemes().map((t) => t.id).sort()).toEqual(["dark-plus", "light-plus"]);
    expect(listSelectableThemes().map((t) => t.id).sort()).toEqual(["dark-plus", "light-plus"]);
  });

  it("Light+ carries a full syntax ramp, so light never falls back to Dark+ colors", () => {
    const syntax = distillVsCodeTheme(LIGHT).syntax;
    for (const [, category] of SYN_MAP) {
      expect(syntax[category], `Light+ should define ${category}`).toBeTruthy();
    }
  });
});

// tokens.css's own structure (every dark token having a light value, the light
// syntax override, the 16-slot ANSI ramps) is asserted by
// scripts/check-tokens.mjs rather than here: vitest stubs CSS imports to the
// empty string, and that script already reads the file and already gates
// `pnpm test`. One guard, one place.
