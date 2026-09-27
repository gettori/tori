// The contrast gate: is this palette legible?
//
// Structural validation (schema.ts) cannot answer that. A palette can name every
// key, hold nothing but valid hex, and still be white on white. Contrast is the
// one property of a theme that has to be measured rather than looked at: the
// 2.5-to-3.0 band is invisible to the eye on a good monitor, which is how
// VS Code's Light+ shipped an ANSI green at 2.56 on white while looking fine to
// everyone who reviewed it. That colour is what test runners print PASS in.
//
// So every role declares, once, what it has to clear and what it sits on. The
// declaration is mandatory: a role with no entry is an error, not a skip, and an
// entry naming a surface that no longer exists is an error too. A gate that
// silently ignores what it was not told about is a gate that passes the day
// someone adds a role.
//
// Pure and DOM-free on purpose: vitest runs in `node`, the guard script runs in
// plain node, and Phase 7 runs this same module over user themes at load time.
import { ROLES, ROLE_BY_ID, buildRoleValues } from "./roles";
import type { Palette } from "./schema";

// ---- Colour maths (WCAG 2.1 relative luminance) ----

export type Rgb = [number, number, number];

/** Parse `#rgb`/`#rrggbb`/`#rrggbbaa` or `rgb()`/`rgba()` into channels plus
 *  alpha. Returns null for anything that is not a single colour, e.g. a
 *  `box-shadow` value. */
export function parseColor(value: string): { rgb: Rgb; a: number } | null {
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
  if (hex) {
    let body = hex[1];
    if (body.length === 3) body = body.split("").map((c) => c + c).join("");
    const at = (i: number) => parseInt(body.slice(i, i + 2), 16);
    return { rgb: [at(0), at(2), at(4)], a: body.length === 8 ? at(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!fn) return null;
  const parts = fn[1].split(",").map((s) => Number(s.trim()));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return { rgb: [parts[0], parts[1], parts[2]], a: parts.length > 3 ? parts[3] : 1 };
}

/** Flatten a translucent colour onto an opaque one. A wash has no contrast of
 *  its own: what a reader sees is the composite, so measuring the wash's own
 *  channels would report a colour that is never on screen. */
export function composite(fg: { rgb: Rgb; a: number }, bg: Rgb): Rgb {
  return fg.rgb.map((c, i) => c * fg.a + bg[i] * (1 - fg.a)) as Rgb;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The ratio a reader actually experiences: `fg` composited over `bg`, then
 *  measured against it. Returns null when either value is not a colour. */
export function ratioOn(fgValue: string, bgValue: string): number | null {
  const fg = parseColor(fgValue);
  const bg = parseColor(bgValue);
  if (!fg || !bg) return null;
  // A surface is itself opaque by declaration; if it is not, there is nothing
  // meaningful to composite onto and the pair is unmeasurable.
  if (bg.a < 1) return null;
  return contrastRatio(composite(fg, bg.rgb), bg.rgb);
}

// ---- Thresholds ----

/** WCAG 2.1 AA for normal-size text. */
export const TEXT_MIN = 4.5;
/** WCAG 2.1 AA for non-text: UI components and meaningful graphics (1.4.11). */
export const GRAPHIC_MIN = 3.0;

/** Deliberately recessive text - timestamps, hints, comments, inactive tabs -
 *  held to the graphic floor rather than to 4.5. This tier is a documented
 *  trade-off, not a WCAG category: the design wants these to read as secondary,
 *  and pushing them to 4.5 would flatten the hierarchy the whole UI leans on.
 *  What it is NOT is a place to park a role that simply failed. */
export const MUTED_MIN = GRAPHIC_MIN;

export type Tier = "text" | "muted" | "graphic";

export const TIER_MIN: Record<Tier, number> = {
  text: TEXT_MIN,
  muted: MUTED_MIN,
  graphic: GRAPHIC_MIN,
};

// ---- The rule table ----

export type ContrastRule = {
  /** What this role must clear when drawn ON something, and on what. Surfaces
   *  are role ids, and each must be a role declaring `surface: true`. */
  fg?: { tier: Tier; on: string[] };
  /** True when other roles are drawn on this one. A role can be both: the brand
   *  gold is text on the canvas and a fill under `brand.on`. */
  surface?: boolean;
  /** Required when the role is neither a foreground nor a surface. Says why
   *  there is nothing to measure, so "not gated" is always a stated position
   *  rather than an omission. */
  why?: string;
};

const CANVASES = ["canvas.default", "canvas.card", "canvas.head", "canvas.input"];
/** The editor and the terminal both paint the work card, so syntax and the ANSI
 *  ramp are measured against exactly one surface. */
const CODE_SURFACE = ["canvas.card"];

const text = (on: string[]): ContrastRule => ({ fg: { tier: "text", on } });
const muted = (on: string[]): ContrastRule => ({ fg: { tier: "muted", on } });
const graphic = (on: string[]): ContrastRule => ({ fg: { tier: "graphic", on } });
const surface = (): ContrastRule => ({ surface: true });
const exempt = (why: string): ContrastRule => ({ why });

/** One entry per role in ROLES, checked for completeness by `checkPalette`. */
export const CONTRAST_RULES: Record<string, ContrastRule> = {
  // `brand.wash` joins the list because the chat prompt bubble paints it and
  // sets `fg.default` on it. Nothing else is drawn there: the rewind button is
  // positioned outside the bubble and sits on the transcript, and inline code
  // brings its own `neutral.hover` fill, both of which are measured already.
  // `blocking.surface` is on all three lists because the two cards that wear it
  // are full of ordinary text: the prompt's question and its disclosure, the
  // card's title, the Other label, the hint, the subagent badge. It is a step
  // off `canvas.card` rather than an alias of it, so a pair measured only
  // against the canvases would go unmeasured the moment the tier lifted.
  "fg.default": text([...CANVASES, "neutral.hover", "brand.wash", "blocking.surface", "done.selected"]),
  "fg.muted": text([...CANVASES, "neutral.hover", "blocking.surface", "done.wash", "done.selected"]),
  "fg.subtle": muted([...CANVASES, "blocking.surface", "done.wash"]),
  // Not parked here after failing: it is designed to sit under every floor.
  "fg.watermark": exempt(
    "watermark text stands in for absent content (placeholders, ghost hints); it is meant to " +
      "recede below the muted floor, and the real content it makes room for arrives at full " +
      "contrast the moment it exists",
  ),
  "fg.onEmphasis": text(["success.emphasis", "attention.emphasis", "danger.emphasis"]),

  "canvas.default": surface(),
  "canvas.card": surface(),
  "canvas.head": surface(),
  "canvas.input": surface(),

  // Dividers are decoration. WCAG 1.4.11 governs the parts of a control that
  // identify it or show its state; a hairline between two panes identifies
  // nothing, and every control here is identified by its own fill and label.
  "border.default": exempt("a divider between regions, not part of any control's identity"),
  "border.strong": exempt("a divider between regions, not part of any control's identity"),
  "border.rail": exempt("the branch-graph rail is a spatial guide read alongside the labelled rows it joins"),

  // Scrollbars follow the platform's own convention: a large-target position
  // indicator that stays out of the way until reached for.
  "scrollbar.thumb": exempt("a position indicator following the platform's own low-contrast convention"),
  "scrollbar.thumbHover": exempt("as scrollbar.thumb, one step stronger on hover"),

  "accent.fg": text(CANVASES),
  "accent.subtle": surface(),

  "neutral.hover": surface(),
  "neutral.subtle": surface(),

  "danger.fg": text(CANVASES),
  "danger.emphasis": surface(),
  "attention.fg": text(CANVASES),
  "attention.emphasis": surface(),
  "success.fg": text(CANVASES),
  "success.emphasis": surface(),
  "info.fg": text(CANVASES),

  "diff.added": text(["canvas.default", "canvas.card"]),
  "diff.modified": text(["canvas.default", "canvas.card"]),
  "diff.deleted": text(["canvas.default", "canvas.card"]),
  "diff.addedWord": surface(),
  "diff.deletedWord": surface(),

  "diag.error": text(["canvas.default", "canvas.card"]),
  "diag.warning": text(["canvas.default", "canvas.card"]),
  "diag.info": text(["canvas.default", "canvas.card"]),
  "diag.hint": muted(["canvas.default", "canvas.card"]),

  // Brand marks rather than text: a mark only has to be identifiable.
  "agent.claude": graphic(["canvas.default", "canvas.card", "canvas.head"]),

  "scrim.default": exempt("a scrim exists to dim what is behind it; it carries no foreground of its own"),
  "scrim.soft": exempt("as scrim.default, one step lighter"),
  "scrim.strong": exempt("as scrim.default, heavy enough that the app behind a first-run modal reads as absent"),

  "status.progress": graphic(["canvas.default", "canvas.card", "canvas.head"]),
  "status.needsYou": graphic(["canvas.default", "canvas.card", "canvas.head"]),
  "status.idle": graphic(["canvas.default", "canvas.card", "canvas.head"]),
  "status.running": graphic(["canvas.default", "canvas.card", "canvas.head"]),

  "progress.subtle": surface(),
  "progress.border": exempt("a frame reinforcing a state already carried by a dot, badge or label"),
  "progress.onSubtle": text(["progress.subtle", ...CANVASES]),
  "needsYou.subtle": surface(),
  "needsYou.border": exempt("as progress.border"),
  "needsYou.onSubtle": text(["needsYou.subtle", ...CANVASES]),
  "danger.subtle": surface(),
  "danger.border": exempt("as progress.border"),
  "danger.onSubtle": text(["danger.subtle", ...CANVASES]),

  // `accent.subtle` is in the list because the brand gold IS drawn on a selected
  // row, and that pairing is where it has historically been weakest: gold-600
  // measured 2.95 on the panel head and 2.76 on the selection, which is why the
  // brand moved to gold-700.
  // `canvas.input` joined the list when the checkbox and radio moved their
  // checked state onto the brand: the control's own fill is the input surface,
  // so the ring, the dot and the filled box are all drawn there. Measured 5.95
  // to 7.13 across the bundled palettes, but it was unmeasured until declared,
  // which is [[lesson_a_new_surface_leaves_its_text_unmeasured]] a second time.
  "brand.default": {
    fg: { tier: "text", on: ["canvas.default", "canvas.card", "canvas.head", "canvas.input", "accent.subtle"] },
    surface: true,
  },
  "brand.strong": text(["canvas.default", "canvas.card", "canvas.head"]),
  "brand.subtle": surface(),
  "brand.wash": surface(),
  "brand.bar": graphic(["canvas.default", "canvas.card", "canvas.head"]),
  "brand.ring": graphic(["canvas.default", "canvas.card", "canvas.input"]),
  "brand.on": text(["brand.default"]),

  // A done row's label and its pull request line sit on the wash at rest and
  // on the stronger wash when selected. The bar edges the selected wash.
  "done.wash": surface(),
  "done.selected": surface(),
  "done.bar": graphic(["canvas.default", "done.selected"]),

  // The blocking tier sits ON the chat pane, which is `canvas.card`, and carries
  // its own text. The border is measured against both sides it separates: the
  // outer edge is what identifies the card against the transcript, the inner one
  // is what keeps the frame visible against its own fill.
  "blocking.surface": surface(),
  "blocking.border": graphic(["canvas.card", "blocking.surface"]),
  "blocking.fg": text(["blocking.surface"]),
  "blocking.accent": text(["blocking.surface"]),

  "ansi.cursor": graphic(CODE_SURFACE),
  "ansi.selection": surface(),
  // Slot 0 is the ramp's floor by definition, and ANSI slots are used as fills
  // as often as they are used as text (block drawing, status bars, `setab 0`).
  // Raising it to 3:1 on a dark theme would mean a terminal that renders every
  // standard palette wrong, which is a worse failure than the one it fixes.
  "ansi.black": exempt("ANSI slot 0 is the ramp's floor and is used as a fill as much as a foreground"),
  "ansi.red": graphic(CODE_SURFACE),
  "ansi.green": graphic(CODE_SURFACE),
  "ansi.yellow": graphic(CODE_SURFACE),
  "ansi.blue": graphic(CODE_SURFACE),
  "ansi.magenta": graphic(CODE_SURFACE),
  "ansi.cyan": graphic(CODE_SURFACE),
  "ansi.white": graphic(CODE_SURFACE),
  "ansi.brightBlack": graphic(CODE_SURFACE),
  "ansi.brightRed": graphic(CODE_SURFACE),
  "ansi.brightGreen": graphic(CODE_SURFACE),
  "ansi.brightYellow": graphic(CODE_SURFACE),
  "ansi.brightBlue": graphic(CODE_SURFACE),
  "ansi.brightMagenta": graphic(CODE_SURFACE),
  "ansi.brightCyan": graphic(CODE_SURFACE),
  "ansi.brightWhite": graphic(CODE_SURFACE),

  "shadow.sm": exempt("a box-shadow value, not a colour"),
  "shadow.md": exempt("a box-shadow value, not a colour"),
  "shadow.lg": exempt("a box-shadow value, not a colour"),

  // The same hue with no alpha, which is never painted at full strength: the
  // shell mixes it down to 14% (4% in light) against the canvas, and
  // `shell.glow` above is that mix, measured as the surface it actually is.
  // Measuring the raw stop would gate a colour nothing ever renders.
  "shell.glowRgb": exempt("a bare channel triple, not a colour. The shell mixes its own alpha from it, and what that produces is a wash over canvas.default rather than a surface of its own"),
  "shell.cardShadow": exempt("a box-shadow value, not a colour"),

  "tree.rowHover": surface(),
  "tree.rowActive": surface(),

  "tab.activeBg": surface(),
  "tab.activeFg": text(["tab.activeBg"]),
  "tab.hoverBg": surface(),
  "tab.inactiveFg": muted(["canvas.head", "tab.hoverBg"]),
  "tab.dirty": graphic(["tab.activeBg", "canvas.head"]),

  "activity.touched": graphic(["canvas.card", "tree.rowHover"]),
  "activity.editing": graphic(["canvas.card", "tree.rowHover"]),

  "scale.red": graphic(["canvas.card", "tree.rowHover"]),
  "scale.green": graphic(["canvas.card", "tree.rowHover"]),
  "scale.blue": graphic(["canvas.card", "tree.rowHover"]),
  "scale.yellow": graphic(["canvas.card", "tree.rowHover"]),
  "scale.slate": graphic(["canvas.card", "tree.rowHover"]),
  "scale.orange": graphic(["canvas.card", "tree.rowHover"]),
  "scale.purple": graphic(["canvas.card", "tree.rowHover"]),
  "scale.pink": graphic(["canvas.card", "tree.rowHover"]),
  "scale.silver": graphic(["canvas.card", "tree.rowHover"]),
  "scale.steel": graphic(["canvas.card", "tree.rowHover"]),
  "scale.graphite": graphic(["canvas.card", "tree.rowHover"]),

  "syntax.keyword": text(CODE_SURFACE),
  "syntax.control": text(CODE_SURFACE),
  "syntax.operator": text(CODE_SURFACE),
  "syntax.string": text(CODE_SURFACE),
  "syntax.escape": text(CODE_SURFACE),
  "syntax.regexp": text(CODE_SURFACE),
  "syntax.comment": muted(CODE_SURFACE),
  "syntax.number": text(CODE_SURFACE),
  "syntax.constant": text(CODE_SURFACE),
  "syntax.function": text(CODE_SURFACE),
  "syntax.method": text(CODE_SURFACE),
  "syntax.type": text(CODE_SURFACE),
  "syntax.class": text(CODE_SURFACE),
  "syntax.namespace": text(CODE_SURFACE),
  "syntax.variable": text(CODE_SURFACE),
  "syntax.property": text(CODE_SURFACE),
  "syntax.parameter": text(CODE_SURFACE),
  "syntax.tag": text(CODE_SURFACE),
  "syntax.attribute": text(CODE_SURFACE),
  "syntax.punctuation": muted(CODE_SURFACE),
};

// ---- The gate ----

export type ContrastFailure = {
  role: string;
  cssVar: string;
  surface: string;
  tier: Tier;
  ratio: number;
  required: number;
};

export type ContrastReport = {
  paletteId: string;
  /** Roles that failed their declared floor. */
  failures: ContrastFailure[];
  /** Table problems: a role with no rule, a rule for no role, a surface that is
   *  not declared as one, a pair that could not be measured. Structural, so
   *  these fail the gate as hard as a bad ratio does. */
  problems: string[];
};

/** Measure one palette against a rule table, `CONTRAST_RULES` by default.
 *
 *  The table is a parameter so a caller can gate against its own rules without
 *  mutating the shared one: tests probe a missing surface that way, and Phase 7
 *  can hold a user theme to a table it chooses. */
export function checkPalette(palette: Palette, rules = CONTRAST_RULES): ContrastReport {
  const values = buildRoleValues(palette);
  const failures: ContrastFailure[] = [];
  const problems: string[] = [];

  for (const id of Object.keys(rules)) {
    if (!ROLE_BY_ID.has(id)) problems.push(`contrast rule "${id}" names no role in ROLES`);
  }

  for (const role of ROLES) {
    const rule = rules[role.id];
    if (!rule) {
      problems.push(`role ${role.id} has no contrast rule; declare its surface, or say why it has none`);
      continue;
    }
    if (!rule.fg && !rule.surface && !rule.why) {
      problems.push(`role ${role.id} is neither a foreground nor a surface and gives no reason`);
      continue;
    }
    if (!rule.fg) continue;

    if (rule.fg.on.length === 0) {
      problems.push(`role ${role.id} declares a ${rule.fg.tier} floor against no surface`);
      continue;
    }
    for (const surfaceId of rule.fg.on) {
      const surfaceRule = rules[surfaceId];
      if (!surfaceRule?.surface) {
        problems.push(`role ${role.id} is measured on ${surfaceId}, which is not declared as a surface`);
        continue;
      }
      const ratio = ratioOn(values[role.id], values[surfaceId]);
      if (ratio === null) {
        problems.push(
          `role ${role.id} on ${surfaceId} could not be measured ` +
            `("${values[role.id]}" on "${values[surfaceId]}")`,
        );
        continue;
      }
      const required = TIER_MIN[rule.fg.tier];
      if (ratio < required) {
        failures.push({
          role: role.id,
          cssVar: role.cssVar,
          surface: surfaceId,
          tier: rule.fg.tier,
          ratio,
          required,
        });
      }
    }
  }

  return { paletteId: palette.id, failures, problems };
}

/** One line per finding, for a test message or the guard's stderr. */
export function formatReport(report: ContrastReport): string[] {
  return [
    ...report.problems.map((p) => `${report.paletteId}: ${p}`),
    ...report.failures.map(
      (f) =>
        `${report.paletteId}: ${f.role} (${f.cssVar}) on ${f.surface} ` +
        `is ${f.ratio.toFixed(2)}, needs ${f.required.toFixed(1)} (${f.tier})`,
    ),
  ];
}
