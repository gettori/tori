// The heavy half of diagram rendering, reached only through Diagram.tsx's
// dynamic import so none of mermaid (or its d3/dagre tail) lands in the eager
// bundle. The boundary test pins that.
import mermaid from "mermaid";

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

function readTokens(): { vars: Record<string, string>; font: string | undefined } {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const [key, token] of Object.entries(SEEDS)) {
    // A missing token is left out rather than defaulted: mermaid's own default
    // renders, an empty string throws inside its colour maths.
    const value = cs.getPropertyValue(token).trim();
    if (value) vars[key] = value;
  }
  return { vars, font: cs.getPropertyValue("--tori-font-ui").trim() || undefined };
}

/** Re-seed mermaid from the token layer. Called before every render rather than
 *  once, so a theme switch repaints diagrams the way it repaints everything. */
export function configure(): void {
  const { vars, font } = readTokens();
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
    themeVariables: vars,
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
