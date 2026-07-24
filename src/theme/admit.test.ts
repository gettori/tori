import { afterEach, describe, expect, it } from "vitest";
import { admit } from "./admit";
import type { AdmittedPalette } from "./admit";
import { listThemes } from "./bundled";
import { admitLoaded, publishUserThemes } from "./userThemes";
import { getTheme, listSelectableThemes, setTheme } from ".";
import type { Palette } from "./schema";

const BUNDLED = listThemes();
const dark = BUNDLED[0].palette;

/** A palette with one primitive replaced. */
function planted(base: Palette, key: string, value: string): Palette {
  return { ...base, id: "user-theme", label: "User Theme", colors: { ...base.colors, [key]: value } };
}

describe("admit", () => {
  it.each(BUNDLED.map((t) => [t.id, t.palette] as const))("admits %s", (id, palette) => {
    const admission = admit(palette, id);
    expect(admission.ok ? [] : admission.problems).toEqual([]);
  });

  // The type is the enforcement: `admit` is the only producer, so a caller
  // cannot hand the paint path a palette that skipped the gate.
  it("does not let a raw palette pass as admitted", () => {
    // @ts-expect-error a Palette is not an AdmittedPalette
    const forged: AdmittedPalette = dark;
    expect(forged).toBeTruthy();
  });

  it("refuses a structurally broken palette, naming the key", () => {
    const broken = { ...dark, colors: { ...dark.colors } } as Palette;
    delete (broken.colors as Record<string, unknown>).canvas;
    const admission = admit(broken, "/themes/x.json");
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.problems.join("\n")).toContain("colors.canvas is missing");
    expect(admission.problems[0]).toContain("/themes/x.json");
  });

  // Order matters. A missing key makes every derived value `undefined`-laced,
  // so running the gate first would bury one real problem under a hundred
  // unmeasurable pairs.
  it("reports only the structural problem when a palette is incomplete", () => {
    const broken = { ...dark, colors: { ...dark.colors } } as Palette;
    delete (broken.colors as Record<string, unknown>).canvas;
    const admission = admit(broken, "x");
    if (admission.ok) throw new Error("expected a refusal");
    expect(admission.problems.every((p) => p.includes("colors.canvas"))).toBe(true);
  });

  it("refuses an illegible palette, naming the failing role", () => {
    const invisible = planted(dark, "text", dark.colors.canvas);
    const admission = admit(invisible, "/themes/invisible.json");
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.problems.join("\n")).toContain("fg.default");
    expect(admission.problems.join("\n")).toContain("canvas.default");
  });
});

describe("the user-theme path", () => {
  // The point of the phase: one door. Feeding every bundled palette through the
  // loader's own code path proves the two sources differ in where the JSON came
  // from and in nothing else.
  it("admits all five bundled palettes when they arrive as user themes", () => {
    const payload = {
      themes: BUNDLED.map((t) => ({
        // Renamed, because a bundled id is refused as a user theme by design.
        palette: { ...t.palette, id: `user-${t.id}` } as Palette,
        source: `/themes/${t.id}.json`,
      })),
      errors: [],
    };
    const { themes, problems } = admitLoaded(payload);
    expect(problems).toEqual([]);
    expect(themes.map((t) => t.id)).toEqual(BUNDLED.map((t) => `user-${t.id}`));
    expect(themes.every((t) => t.problems.length === 0)).toBe(true);
  });

  it("refuses a user theme claiming a bundled id", () => {
    const { themes, problems } = admitLoaded({
      themes: [{ palette: dark, source: "/themes/mine.json" }],
      errors: [],
    });
    expect(themes).toEqual([]);
    expect(problems.join("\n")).toContain("is a bundled theme");
  });

  // Refused, but kept: the picker filters on `problems`, while `getTheme` can
  // still find it so selecting it says why rather than "no such theme".
  it("keeps an illegible user theme in the list, carrying its problems", () => {
    const { themes, problems } = admitLoaded({
      themes: [{ palette: planted(dark, "text", dark.colors.canvas), source: "/themes/bad.json" }],
      errors: [],
    });
    expect(themes).toHaveLength(1);
    expect(themes[0].problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("/themes/bad.json");
  });

  it("passes the loader's own errors through", () => {
    const { problems } = admitLoaded({ themes: [], errors: ["/themes/broken.json: expected value"] });
    expect(problems).toEqual(["/themes/broken.json: expected value"]);
  });
});

// The claim this phase has to earn: nothing reaches `applyResolved` without
// passing the gate. vitest runs in `node` with no DOM, so painting throws on
// `document`. That makes the probe unusually direct - a refusal RETURNS, a paint
// THROWS, and the positive control below proves the paint path is really there
// rather than the whole thing being inert.
describe("selecting a theme", () => {
  const invisible = planted(dark, "text", dark.colors.canvas);

  afterEach(() => publishUserThemes({ themes: [], errors: [] }));

  it("paints a legible theme (the positive control: it reaches the DOM and throws)", () => {
    expect(() => setTheme("sway-dark")).toThrow(/document/);
  });

  it("refuses an illegible user theme without painting anything", () => {
    publishUserThemes({ themes: [{ palette: invisible, source: "/themes/bad.json" }], errors: [] });
    const problems = setTheme("user-theme");
    expect(problems.join("\n")).toContain("fg.default");
    expect(problems.join("\n")).toContain("cannot apply theme");
  });

  // Refused, so the picker must not offer it - but `getTheme` still finds it, so
  // the refusal above can say what is wrong rather than "no such theme".
  it("hides a refused theme from the picker but keeps it findable", () => {
    publishUserThemes({ themes: [{ palette: invisible, source: "/themes/bad.json" }], errors: [] });
    expect(listSelectableThemes().map((t) => t.id)).not.toContain("user-theme");
    expect(getTheme("user-theme")?.source).toBe("/themes/bad.json");
  });

  it("offers an admitted user theme, labelled with its file", () => {
    publishUserThemes({
      themes: [{ palette: { ...dark, id: "mine", label: "Mine" }, source: "/themes/mine.json" }],
      errors: [],
    });
    const mine = listSelectableThemes().find((t) => t.id === "mine");
    expect(mine?.source).toBe("/themes/mine.json");
  });

  // A deleted file (or a typo in settings.json) is the one case that DOES fall
  // back rather than staying put: an app with no theme at all is worse than a
  // named error plus the default.
  it("falls back to the default for an id nothing provides", () => {
    // It paints, which is the fallback happening. The named error that comes
    // with it is returned only after the paint, so on a real DOM both are
    // observable and here only the first is.
    expect(() => setTheme("no-such-theme")).toThrow(/document/);
  });
});
