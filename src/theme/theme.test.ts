import { readFileSync } from "node:fs";
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

// The light theme is only complete if every semantic token has a light value.
// A token defined for dark alone does not fail loudly: it silently keeps its
// dark value in light mode, which is exactly how a "light" UI ends up with dark
// remnants. Reading the stylesheet as text (rather than in a browser) keeps
// this a unit test while still checking the real source of truth.
describe("token layer", () => {
  const css = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

  /** Custom-property names declared inside the block introduced by `marker`. */
  function declared(marker: string): Set<string> {
    const start = css.indexOf(marker);
    expect(start, `tokens.css should contain "${marker}"`).toBeGreaterThan(-1);
    let depth = 0;
    let i = css.indexOf("{", start);
    const open = i;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    const body = css.slice(open + 1, i);
    return new Set([...body.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
  }

  it("defines a light value for every semantic token dark defines", () => {
    const dark = declared("---- Semantic tokens, dark");
    const light = declared("---- Semantic tokens, light");
    const missing = [...dark].filter((token) => !light.has(token));
    expect(missing, `light theme is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("overrides the Dark+ syntax defaults for light", () => {
    // The :root defaults are Dark+; without a light override an unthemed boot
    // in light mode paints dark-theme syntax onto a white editor.
    const light = declared("---- Semantic tokens, light");
    for (const [cssVar] of SYN_MAP) {
      expect(light.has(cssVar), `${cssVar} should have a light value`).toBe(true);
    }
  });

  it("gives the terminal a full 16-slot ANSI ramp in both themes", () => {
    const slots = [
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "bright-black", "bright-red", "bright-green", "bright-yellow",
      "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
    ];
    for (const marker of ["---- Semantic tokens, dark", "---- Semantic tokens, light"]) {
      const tokens = declared(marker);
      for (const slot of slots) {
        expect(tokens.has(`--term-${slot}`), `${marker}: --term-${slot}`).toBe(true);
      }
    }
  });
});
