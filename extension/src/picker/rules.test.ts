import { describe, it, expect } from "vite-plus/test";
import { matchRules, shrinkStyles, type Env, type RuleLike } from "./rules";

const TABS_CSS = `@import "./base.css";
/* Tabs { not a rule } */
.tabs {
  display: flex;
}

@media (min-width: 600px) {
  .tabs { gap: 8px; }
}
/* The header, with a
   comment that spans lines; */
.tabs-header,
.tabs-footer {
  content: "}";
  gap: 24px;

  /* } */
}
`;

const style = (cssText: string, names: string[]): RuleLike["style"] =>
  Object.assign(Object.fromEntries(names.map((n, i) => [i, n])), { cssText, length: names.length });

const rule = (selectorText: string, cssText: string, names: string[]): RuleLike => ({
  cssText: "",
  selectorText,
  style: style(cssText, names),
});

const TABS_RULES: RuleLike[] = [
  { cssText: "", media: { mediaText: "" } },
  rule(".tabs", "display: flex;", ["display"]),
  {
    cssText: "",
    media: { mediaText: "(min-width: 600px)" },
    cssRules: [rule(".tabs", "gap: 8px;", ["column-gap", "row-gap"])],
  },
  rule(".tabs-header, .tabs-footer", 'content: "}"; gap: 24px;', ["content", "row-gap", "column-gap"]),
];

const env = (classes: string[]): Env => ({
  matches: (selector) => classes.some((c) => selector === `.${c}`),
  media: () => true,
  supports: () => true,
});

const tabs = () => ({ cssRules: TABS_RULES, where: "/w/app/src/settings/tabs.css", text: TABS_CSS, exact: true });

describe("matchRules", () => {
  it("places a multi-line, commented rule by its lines in the sheet", () => {
    const { rules } = matchRules([tabs()], env(["tabs-header"]));
    expect(rules).toEqual([
      {
        selector: ".tabs-header",
        declarations: 'content: "}"; gap: 24px;',
        location: "/w/app/src/settings/tabs.css:12-18",
      },
    ]);
  });
});

describe("shrinkStyles", () => {
  it("keeps only what the matched rules set, at its computed value", () => {
    const { properties } = matchRules([tabs()], env(["tabs", "tabs-header"]));
    const computed: Record<string, string> = {
      display: "flex",
      "column-gap": "24px",
      "row-gap": "24px",
      content: '"}"',
      color: "red",
    };
    expect(shrinkStyles(properties, (name) => computed[name], 40)).toEqual({
      content: '"}"',
      "row-gap": "24px",
      "column-gap": "24px",
      display: "flex",
    });
    expect(Object.keys(shrinkStyles(properties, (name) => computed[name], 2))).toHaveLength(2);
  });
});
