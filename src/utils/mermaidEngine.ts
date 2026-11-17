// The heavy half of diagram rendering, reached only through Diagram.tsx's
// dynamic import so none of mermaid (or its d3/dagre tail) lands in the eager
// bundle. The boundary test pins that.
import mermaid from "mermaid";
import { mix } from "../theme/roles";

// Mermaid's `base` theme derives every colour it draws from a handful of seeds,
// so the token layer only has to answer those. Opaque roles only: mermaid does
// colour maths on these, and a washed stop compounds into an unreadable fill.
const SEEDS: Record<string, string> = {
  background: "--canvas-default",
  primaryColor: "--canvas-card",
  primaryTextColor: "--fg-default",
  primaryBorderColor: "--fg-subtle",
  secondaryColor: "--canvas-head",
  tertiaryColor: "--canvas-input",
  lineColor: "--fg-muted",
  textColor: "--fg-default",
  // Not derivable from the others: left alone, a subgraph's own title comes out
  // of mermaid's warm-white default rather than off the token layer.
  titleColor: "--fg-default",
};

// Parts of a diagram as percent of the text mixed into its ground, so one
// ladder holds on every theme and every diagram kind.
const LADDER: Record<string, number> = {
  primaryColor: 3,
  primaryBorderColor: 20,
  clusterBorder: 20,
  lineColor: 50,
  titleColor: 60,
  actorBkg: 3,
  actorBorder: 20,
  actorLineColor: 20,
  signalColor: 50,
  labelBoxBkgColor: 3,
  labelBoxBorderColor: 20,
  activationBkgColor: 5,
  activationBorderColor: 20,
  noteBkgColor: 5,
  noteBorderColor: 20,
  attributeBackgroundColorEven: 3,
  rowEven: 3,
  pieOuterStrokeColor: 20,
};
const INKED = [
  "primaryTextColor",
  "actorTextColor",
  "signalTextColor",
  "labelTextColor",
  "loopTextColor",
  "noteTextColor",
  "pieTitleTextColor",
  "pieSectionTextColor",
  "pieLegendTextColor",
];
const GROUNDED = ["clusterBkg", "edgeLabelBackground", "attributeBackgroundColorOdd", "rowOdd", "pieStrokeColor"];
// Slices climb in steps so neighbours part, and stop at 45 so the ink stays
// readable on the strongest one.
const SLICES = [10, 17, 24, 31, 38, 45];
const ARROW = 85;
const EDGE_TEXT = 60;
const TEXT_PX = 13;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function readTokens(): { vars: Record<string, string>; css: string; font: string | undefined } {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const [key, token] of Object.entries(SEEDS)) {
    // A missing token is left out rather than defaulted: mermaid's own default
    // renders, an empty string throws inside its colour maths.
    const value = cs.getPropertyValue(token).trim();
    if (value) vars[key] = value;
  }
  let css = "";
  const ground = vars.background;
  const ink = vars.textColor;
  // A theme that hands over something other than hex keeps the plain seeds.
  if (ground && ink && HEX.test(ground) && HEX.test(ink)) {
    const at = (percent: number) => mix(ground, ink, percent / 100);
    for (const [key, percent] of Object.entries(LADDER)) vars[key] = at(percent);
    for (const key of INKED) vars[key] = ink;
    for (const key of GROUNDED) vars[key] = ground;
    for (let i = 0; i < 12; i++) vars[`pie${i + 1}`] = at(SLICES[i % SLICES.length]);
    vars.pieStrokeWidth = "1px";
    vars.pieOuterStrokeWidth = "1px";
    // Mermaid has no seed for these, and `themeCSS` is scoped by the diagram's
    // id, so it outranks the rules mermaid writes.
    css = [
      `.marker, .marker.cross { fill: ${at(ARROW)}; stroke: ${at(ARROW)}; }`,
      `.edgeLabel p { color: ${at(EDGE_TEXT)}; }`,
      `.node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 0.75px; }`,
    ].join("\n");
  }
  return { vars, css, font: cs.getPropertyValue("--tori-font-ui").trim() || undefined };
}

/** Re-seed mermaid from the token layer. Called before every render rather than
 *  once, so a theme switch repaints diagrams the way it repaints everything. */
export function configure(): void {
  const { vars, css, font } = readTokens();
  mermaid.initialize({
    startOnLoad: false,
    // `strict` runs mermaid's own DOMPurify pass over the SVG it hands back and
    // refuses `click` bindings. That pass is what lets the result reach
    // innerHTML: our sanitizer would strip the <style> its colours live in.
    securityLevel: "strict",
    // Without this a failed parse injects mermaid's own error graphic into the
    // document. The caller renders the source instead.
    suppressErrorRendering: true,
    theme: "base",
    darkMode: document.documentElement.dataset.theme !== "light",
    fontFamily: font,
    themeVariables: {
      ...vars,
      fontSize: `${TEXT_PX}px`,
      pieTitleTextSize: `${TEXT_PX + 2}px`,
      pieSectionTextSize: `${TEXT_PX}px`,
      pieLegendTextSize: `${TEXT_PX}px`,
    },
    // The sequence diagram copies this, not the theme's size, over its own text.
    fontSize: TEXT_PX,
    themeCSS: css,
  });
}

let seq = 0;

/** The diagram as SVG, or null when the source is not a diagram yet: a fence
 *  mid-stream, or one that never parses. Callers show the source on null. */
export async function render(code: string): Promise<string | null> {
  try {
    if (!(await mermaid.parse(code, { suppressErrors: true }))) return null;
    const { svg } = await mermaid.render(`tori-mermaid-${seq++}`, code);
    return svg;
  } catch {
    return null;
  }
}
