// Palette schema, the file format a theme author writes.
//
// A palette carries PRIMITIVES only: flat hex strings, no expressions, no
// references to other keys. Everything derived (alpha washes, shadow stacks,
// the semantic role names the UI consumes) is computed in roles.ts. That split
// is deliberate: a user-authored file that cannot express computation cannot
// become an evaluator or an injection surface, and it keeps derivation in one
// reviewable place instead of duplicated per theme.
//
// See adr_theme_palette_roles for the role taxonomy this feeds.

export const PALETTE_SCHEMA_VERSION = 1;

/** `#rgb`, `#rrggbb`, or `#rrggbbaa`. */
export type Hex = string;

export const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Whether the OS should draw native scrollbars/controls light or dark. This is
 *  metadata only: it selects no colour, it just tells the shell which way the
 *  theme leans, and drives the `data-theme` attribute the token layer falls back
 *  to before a theme is resolved. */
export type Appearance = "dark" | "light";

/** The primitive set. One flat group per surface family so an author can fill it
 *  top to bottom; roles.ts is the only thing that reads it. */
export type PaletteColors = {
  // ---- Surfaces ----
  /** The desk: the tinted shell behind everything. */
  canvas: Hex;
  /** The raised work-card holding terminal/editor content. */
  card: Hex;
  /** Raised head / panel title bars. */
  head: Hex;
  /** Text input fields. */
  input: Hex;
  /** Row/control hover fill. */
  hover: Hex;

  // ---- Lines ----
  /** Base for the primary divider. Dark themes wash it to a faint cool hairline;
   *  light themes use it solid, because an 8%-alpha line over white is nothing. */
  borderTint: Hex;
  /** Base for the heavier line treatments: the strong divider and the two
   *  scrollbar-thumb stops. Separate from `borderTint` because light's primary
   *  divider is a light gray while its heavier lines are washes of near-black. */
  lineTint: Hex;
  /** The branch/worktree graph rail. OPAQUE by necessity: the rail and each
   *  row's elbow share pixels, so a translucent stroke would double its alpha
   *  there. Author the flat composite of the hairline over the canvas. */
  rail: Hex;

  // ---- Text ----
  text: Hex;
  textMuted: Hex;
  textSubtle: Hex;
  /** Text/icon on a filled emphasis surface. */
  textOnEmphasis: Hex;

  // ---- Accent ----
  accent: Hex;
  /** Selection background. */
  accentSubtle: Hex;

  // ---- Feedback ----
  danger: Hex;
  /** Filled danger surface. Separate from `danger` because one stop cannot be
   *  both readable AS text on the canvas and dark enough to carry white text:
   *  Tori Dark's danger reads at 5.6 on the canvas but only 3.2 under a white
   *  button label. Same reason `attentionStrong` has always been separate. */
  dangerStrong: Hex;
  attention: Hex;
  /** Filled attention surface. See `dangerStrong`. */
  attentionStrong: Hex;
  success: Hex;
  /** Filled success surface. See `dangerStrong`. */
  successStrong: Hex;
  info: Hex;
  /** Neutral low-contrast badge fill, washed by alpha. */
  fillTint: Hex;

  // ---- VCS / diff ----
  diffAdded: Hex;
  diffModified: Hex;
  diffDeleted: Hex;

  // ---- Diagnostics ----
  diagError: Hex;
  diagWarning: Hex;
  diagInfo: Hex;
  diagHint: Hex;

  // ---- Agent marks (third-party brand hues; theme adjusts lightness only) ----
  agentClaude: Hex;

  // ---- Overlays ----
  /** Modal scrim base, washed by alpha. */
  scrimTint: Hex;
  /** Elevation shadow base, washed by alpha. */
  shadowTint: Hex;
  /** The space tint behind the transparent sidebar/topbar, washed by alpha. */
  glowTint: Hex;

  // ---- Session status indicators ----
  statusProgress: Hex;
  statusNeedsYou: Hex;
  statusIdle: Hex;
  statusRunning: Hex;

  // ---- Brand ----
  brand: Hex;
  brandStrong: Hex;
  /** Base for the brand's alpha washes (pill fill, focus ring). */
  brandTint: Hex;
  /** Text/icon on a filled brand surface. */
  brandOn: Hex;

  // ---- Terminal ANSI ----
  ansiCursor: Hex;
  /** Base for the terminal selection wash. */
  ansiSelectionTint: Hex;
  ansiBlack: Hex;
  ansiRed: Hex;
  ansiGreen: Hex;
  ansiYellow: Hex;
  ansiBlue: Hex;
  ansiMagenta: Hex;
  ansiCyan: Hex;
  ansiWhite: Hex;
  ansiBrightBlack: Hex;
  ansiBrightRed: Hex;
  ansiBrightGreen: Hex;
  ansiBrightYellow: Hex;
  ansiBrightBlue: Hex;
  ansiBrightMagenta: Hex;
  ansiBrightCyan: Hex;
  ansiBrightWhite: Hex;

  // ---- Icon scale ----
  //
  // The 11 hues the file-icon set resolves against. Seti ships one hex per file
  // type (406 of them, but only 11 distinct), so the generator emits a hue NAME
  // and the theme supplies the value: that is what lets the file tree follow the
  // theme instead of staying on seti's dark variant over a light canvas.
  scaleRed: Hex;
  scaleGreen: Hex;
  scaleBlue: Hex;
  scaleYellow: Hex;
  scaleSlate: Hex;
  scaleOrange: Hex;
  scalePurple: Hex;
  scalePink: Hex;
  scaleSilver: Hex;
  scaleSteel: Hex;
  scaleGraphite: Hex;

  // ---- Syntax ----
  //
  // Every category is authored rather than derived. A theme's syntax ramp is the
  // part authors most want to control, and a derived sibling ("parameter is
  // variable, 20% toward the foreground") is a rule that reads as a bug the
  // first time a port wants those two the same distance apart in a different
  // hue. The cost is real: this is 20 of the palette's 78 keys, and every port
  // in Phase 6 pays it.
  synKeyword: Hex;
  synControl: Hex;
  synOperator: Hex;
  synString: Hex;
  synEscape: Hex;
  synRegexp: Hex;
  synComment: Hex;
  synNumber: Hex;
  synConstant: Hex;
  synFunction: Hex;
  synMethod: Hex;
  synType: Hex;
  synClass: Hex;
  synNamespace: Hex;
  synVariable: Hex;
  synProperty: Hex;
  synParameter: Hex;
  synTag: Hex;
  synAttribute: Hex;
  synPunctuation: Hex;
};

export type Palette = {
  schemaVersion: number;
  id: string;
  label: string;
  appearance: Appearance;
  colors: PaletteColors;
};

/** Every key roles.ts requires, in authoring order. Exported so the validator
 *  and the guard can check completeness without duplicating the list. */
export const PALETTE_KEYS: (keyof PaletteColors)[] = [
  "canvas", "card", "head", "input", "hover",
  "borderTint", "lineTint", "rail",
  "text", "textMuted", "textSubtle", "textOnEmphasis",
  "accent", "accentSubtle",
  "danger", "dangerStrong", "attention", "attentionStrong", "success", "successStrong", "info", "fillTint",
  "diffAdded", "diffModified", "diffDeleted",
  "diagError", "diagWarning", "diagInfo", "diagHint",
  "agentClaude",
  "scrimTint", "shadowTint", "glowTint",
  "statusProgress", "statusNeedsYou", "statusIdle", "statusRunning",
  "brand", "brandStrong", "brandTint", "brandOn",
  "ansiCursor", "ansiSelectionTint",
  "ansiBlack", "ansiRed", "ansiGreen", "ansiYellow",
  "ansiBlue", "ansiMagenta", "ansiCyan", "ansiWhite",
  "ansiBrightBlack", "ansiBrightRed", "ansiBrightGreen", "ansiBrightYellow",
  "ansiBrightBlue", "ansiBrightMagenta", "ansiBrightCyan", "ansiBrightWhite",
  "scaleRed", "scaleGreen", "scaleBlue", "scaleYellow", "scaleSlate", "scaleOrange",
  "scalePurple", "scalePink", "scaleSilver", "scaleSteel", "scaleGraphite",
  "synKeyword", "synControl", "synOperator",
  "synString", "synEscape", "synRegexp",
  "synComment", "synNumber", "synConstant",
  "synFunction", "synMethod",
  "synType", "synClass", "synNamespace",
  "synVariable", "synProperty", "synParameter",
  "synTag", "synAttribute", "synPunctuation",
];

/** Structural validation. Returns the problems found, empty when the palette is
 *  usable. Legibility is NOT checked here: a palette can be structurally perfect
 *  and still be white-on-white, which is what the contrast gate is for. */
export function validatePalette(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return ["palette is not an object"];
  const p = value as Partial<Palette>;

  if (p.schemaVersion !== PALETTE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${PALETTE_SCHEMA_VERSION}, got ${String(p.schemaVersion)}`);
  }
  if (!p.id) problems.push("id is required");
  if (!p.label) problems.push("label is required");
  if (p.appearance !== "dark" && p.appearance !== "light") {
    problems.push(`appearance must be "dark" or "light", got ${String(p.appearance)}`);
  }

  const colors = p.colors;
  if (typeof colors !== "object" || colors === null) {
    problems.push("colors is required");
    return problems;
  }
  for (const key of PALETTE_KEYS) {
    const v = (colors as Record<string, unknown>)[key];
    if (typeof v !== "string") problems.push(`colors.${key} is missing`);
    else if (!HEX_RE.test(v)) problems.push(`colors.${key} is not a hex colour: ${v}`);
  }
  for (const key of Object.keys(colors)) {
    if (!(PALETTE_KEYS as string[]).includes(key)) problems.push(`colors.${key} is not a known palette key`);
  }
  return problems;
}
