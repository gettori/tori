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
    expect(tc.colors["editor.background"]).toBe("#1a1a1a");
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
  it("maps Dark+ to the exact current dark chrome tokens (dark stays identical)", () => {
    const resolved = resolveTheme(distillVsCodeTheme(DARK));
    expect(resolved).toMatchObject({
      "--bg": "#1a1a1a",
      "--pane-bg": "#1e1e1e",
      "--pane-head-bg": "#252526",
      "--border": "#2d2d2d",
      "--text": "#d4d4d4",
      "--text-dim": "#808080",
      "--accent": "#4a9eff",
      "--sel": "#094771",
      "--hover": "#2a2d2e",
      "--input-bg": "#1a1a1a",
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
});
