// The role generator: one palette of primitives in, the full semantic role set
// out. This is the only place colour derivation lives.
//
// Every role carries a stable `id` (the taxonomy, e.g. `canvas.card`) and a
// `cssVar` (what CSS actually reads, e.g. `--canvas-card`). The two are
// independent on purpose: the migration that introduced this generator could
// keep emitting the old token names while the engine went live, then flip only
// the `cssVar` column in one commit. The split still earns its keep, because a
// contrast rule, a palette, and the ADR all name roles by `id` and none of them
// has to move when a CSS name does.
//
// See adr_theme_palette_roles for the taxonomy and the <html> key-ownership
// contract this generator's consumers must honour.
import type { Appearance, Palette, PaletteColors } from "./schema";

// ---- Derivation helpers ----

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` to channels. */
function channels(hex: string): [number, number, number, number] {
  let body = hex.replace("#", "");
  if (body.length === 3) body = body.split("").map((c) => c + c).join("");
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  const a = body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}

/**
 * Wash `hex` to opacity `a`.
 *
 * At `a === 1` this returns the hex unchanged rather than an opaque `rgba()`.
 * That matters: it lets one role read `alpha(tint, x)` across every theme while
 * a light theme opts out of the wash entirely (its primary divider is a solid
 * gray, because an 8%-alpha hairline over white is nothing at all).
 */
export function alpha(hex: string, a: number): string {
  if (a >= 1) return hex;
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * `hex` as a bare space-separated channel triple, for CSS to compose its own
 * alpha with: `rgb(var(--x) / 14%)`.
 *
 * This exists because an alpha baked into a role cannot be varied by the thing
 * consuming it, and the shell's wash needs exactly that - one hue, mixed at a
 * strength the theme chooses and re-tinted per space. `color-mix()` would be
 * the modern way to do it, but it must resolve its arguments at parse time in
 * some engines, and a `color-mix()` fed from a `var()` silently drops the whole
 * declaration when it does not - taking every other layer of the shorthand with
 * it. A substituted channel list has no such failure mode: by the time the
 * value is parsed it is an ordinary `rgb()`.
 */
export function rgbTriple(hex: string): string {
  const [r, g, b] = channels(hex);
  return `${r} ${g} ${b}`;
}

/**
 * Blend `amount` of `top` over `bottom`, returning an opaque hex.
 *
 * Used for roles that must be flat rather than translucent: anything where two
 * strokes overlap would otherwise double its alpha and render that segment
 * brighter than the rest. (The graph rail is exactly that shape but is NOT
 * derived here: measured against the current values, no single blend amount
 * reproduces its dark stop on all three channels, so it stays an authored
 * primitive. The derived tree and tab families in the next phase use this.)
 */
export function mix(bottom: string, top: string, amount: number): string {
  const [br, bg, bb] = channels(bottom);
  const [tr, tg, tb] = channels(top);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * amount);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(ch(br, tr))}${hex(ch(bg, tg))}${hex(ch(bb, tb))}`;
}

/** Pick a per-appearance value. The escape hatch for roles whose two themes
 *  genuinely differ in kind, not just in stop: light shadows are softer, light
 *  scrims are thinner, light borders are solid. */
export function variants(appearance: Appearance) {
  return <T,>(choices: { dark: T; light: T }): T => choices[appearance];
}

// ---- The role table ----

export type Role = {
  /** Stable taxonomy name. Never changes. */
  id: string;
  /** The custom property CSS reads. Flips to the new namespace in Phase 4. */
  cssVar: string;
  /** Family, for grouping in the styleguide and in the contrast gate. */
  group: string;
};

/** Declared once, in taxonomy order. `buildRoles` is checked against this, so a
 *  role that is declared but never produced (or vice versa) is a hard error. */
export const ROLES: Role[] = [
  { id: "fg.default", cssVar: "--fg-default", group: "fg" },
  { id: "fg.muted", cssVar: "--fg-muted", group: "fg" },
  { id: "fg.subtle", cssVar: "--fg-subtle", group: "fg" },
  { id: "fg.watermark", cssVar: "--fg-watermark", group: "fg" },
  { id: "fg.onEmphasis", cssVar: "--fg-on-emphasis", group: "fg" },

  { id: "canvas.default", cssVar: "--canvas-default", group: "canvas" },
  { id: "canvas.card", cssVar: "--canvas-card", group: "canvas" },
  { id: "canvas.head", cssVar: "--canvas-head", group: "canvas" },
  { id: "canvas.input", cssVar: "--canvas-input", group: "canvas" },

  { id: "border.default", cssVar: "--border-default", group: "border" },
  { id: "border.strong", cssVar: "--border-strong", group: "border" },
  { id: "border.rail", cssVar: "--border-rail", group: "border" },

  { id: "scrollbar.thumb", cssVar: "--scrollbar-thumb", group: "scrollbar" },
  { id: "scrollbar.thumbHover", cssVar: "--scrollbar-thumb-hover", group: "scrollbar" },

  { id: "accent.fg", cssVar: "--accent-fg", group: "accent" },
  { id: "accent.subtle", cssVar: "--accent-subtle", group: "accent" },

  { id: "neutral.hover", cssVar: "--neutral-hover", group: "neutral" },
  { id: "neutral.subtle", cssVar: "--neutral-subtle", group: "neutral" },

  { id: "danger.fg", cssVar: "--danger-fg", group: "danger" },
  { id: "danger.emphasis", cssVar: "--danger-emphasis", group: "danger" },
  { id: "attention.fg", cssVar: "--attention-fg", group: "attention" },
  { id: "attention.emphasis", cssVar: "--attention-emphasis", group: "attention" },
  { id: "success.fg", cssVar: "--success-fg", group: "success" },
  { id: "success.emphasis", cssVar: "--success-emphasis", group: "success" },
  { id: "info.fg", cssVar: "--info-fg", group: "info" },

  { id: "diff.added", cssVar: "--diff-added", group: "diff" },
  { id: "diff.modified", cssVar: "--diff-modified", group: "diff" },
  { id: "diff.deleted", cssVar: "--diff-deleted", group: "diff" },
  { id: "diff.addedWord", cssVar: "--diff-added-word", group: "diff" },
  { id: "diff.deletedWord", cssVar: "--diff-deleted-word", group: "diff" },

  { id: "diag.error", cssVar: "--diag-error", group: "diag" },
  { id: "diag.warning", cssVar: "--diag-warning", group: "diag" },
  { id: "diag.info", cssVar: "--diag-info", group: "diag" },
  { id: "diag.hint", cssVar: "--diag-hint", group: "diag" },

  { id: "agent.claude", cssVar: "--agent-claude", group: "agent" },

  { id: "scrim.default", cssVar: "--scrim-default", group: "scrim" },
  { id: "scrim.soft", cssVar: "--scrim-soft", group: "scrim" },
  { id: "scrim.strong", cssVar: "--scrim-strong", group: "scrim" },

  { id: "status.progress", cssVar: "--status-progress", group: "status" },
  { id: "status.needsYou", cssVar: "--status-needs-you", group: "status" },
  { id: "status.idle", cssVar: "--status-idle", group: "status" },
  { id: "status.running", cssVar: "--status-running", group: "status" },

  { id: "progress.subtle", cssVar: "--progress-subtle", group: "progress" },
  { id: "progress.border", cssVar: "--progress-border", group: "progress" },
  { id: "progress.onSubtle", cssVar: "--progress-on-subtle", group: "progress" },
  { id: "needsYou.subtle", cssVar: "--needs-you-subtle", group: "needsYou" },
  { id: "needsYou.border", cssVar: "--needs-you-border", group: "needsYou" },
  { id: "needsYou.onSubtle", cssVar: "--needs-you-on-subtle", group: "needsYou" },
  { id: "danger.subtle", cssVar: "--danger-subtle", group: "danger" },
  { id: "danger.border", cssVar: "--danger-border", group: "danger" },
  { id: "danger.onSubtle", cssVar: "--danger-on-subtle", group: "danger" },

  { id: "brand.default", cssVar: "--brand-default", group: "brand" },
  { id: "brand.strong", cssVar: "--brand-strong", group: "brand" },
  { id: "brand.subtle", cssVar: "--brand-subtle", group: "brand" },
  { id: "brand.wash", cssVar: "--brand-wash", group: "brand" },
  { id: "brand.bar", cssVar: "--brand-bar", group: "brand" },
  { id: "brand.ring", cssVar: "--brand-ring", group: "brand" },
  { id: "brand.on", cssVar: "--brand-on", group: "brand" },

  { id: "done.wash", cssVar: "--done-wash", group: "done" },
  { id: "done.selected", cssVar: "--done-selected", group: "done" },
  { id: "done.bar", cssVar: "--done-bar", group: "done" },

  { id: "blocking.surface", cssVar: "--blocking-surface", group: "blocking" },
  { id: "blocking.border", cssVar: "--blocking-border", group: "blocking" },
  { id: "blocking.fg", cssVar: "--blocking-fg", group: "blocking" },
  { id: "blocking.accent", cssVar: "--blocking-accent", group: "blocking" },

  { id: "ansi.cursor", cssVar: "--ansi-cursor", group: "ansi" },
  { id: "ansi.selection", cssVar: "--ansi-selection", group: "ansi" },
  { id: "ansi.black", cssVar: "--ansi-black", group: "ansi" },
  { id: "ansi.red", cssVar: "--ansi-red", group: "ansi" },
  { id: "ansi.green", cssVar: "--ansi-green", group: "ansi" },
  { id: "ansi.yellow", cssVar: "--ansi-yellow", group: "ansi" },
  { id: "ansi.blue", cssVar: "--ansi-blue", group: "ansi" },
  { id: "ansi.magenta", cssVar: "--ansi-magenta", group: "ansi" },
  { id: "ansi.cyan", cssVar: "--ansi-cyan", group: "ansi" },
  { id: "ansi.white", cssVar: "--ansi-white", group: "ansi" },
  { id: "ansi.brightBlack", cssVar: "--ansi-bright-black", group: "ansi" },
  { id: "ansi.brightRed", cssVar: "--ansi-bright-red", group: "ansi" },
  { id: "ansi.brightGreen", cssVar: "--ansi-bright-green", group: "ansi" },
  { id: "ansi.brightYellow", cssVar: "--ansi-bright-yellow", group: "ansi" },
  { id: "ansi.brightBlue", cssVar: "--ansi-bright-blue", group: "ansi" },
  { id: "ansi.brightMagenta", cssVar: "--ansi-bright-magenta", group: "ansi" },
  { id: "ansi.brightCyan", cssVar: "--ansi-bright-cyan", group: "ansi" },
  { id: "ansi.brightWhite", cssVar: "--ansi-bright-white", group: "ansi" },

  { id: "shadow.sm", cssVar: "--shadow-sm", group: "shadow" },
  { id: "shadow.md", cssVar: "--shadow-md", group: "shadow" },
  { id: "shadow.lg", cssVar: "--shadow-lg", group: "shadow" },

  { id: "shell.glowRgb", cssVar: "--shell-glow-rgb", group: "shell" },
  { id: "shell.cardShadow", cssVar: "--shell-card-shadow", group: "shell" },

  { id: "tree.rowHover", cssVar: "--tree-row-hover", group: "tree" },
  { id: "tree.rowActive", cssVar: "--tree-row-active", group: "tree" },

  { id: "tab.activeBg", cssVar: "--tab-active-bg", group: "tab" },
  { id: "tab.activeFg", cssVar: "--tab-active-fg", group: "tab" },
  { id: "tab.hoverBg", cssVar: "--tab-hover-bg", group: "tab" },
  { id: "tab.inactiveFg", cssVar: "--tab-inactive-fg", group: "tab" },
  { id: "tab.dirty", cssVar: "--tab-dirty", group: "tab" },

  { id: "activity.touched", cssVar: "--activity-touched", group: "activity" },
  { id: "activity.editing", cssVar: "--activity-editing", group: "activity" },

  { id: "scale.red", cssVar: "--scale-red", group: "scale" },
  { id: "scale.green", cssVar: "--scale-green", group: "scale" },
  { id: "scale.blue", cssVar: "--scale-blue", group: "scale" },
  { id: "scale.yellow", cssVar: "--scale-yellow", group: "scale" },
  { id: "scale.slate", cssVar: "--scale-slate", group: "scale" },
  { id: "scale.orange", cssVar: "--scale-orange", group: "scale" },
  { id: "scale.purple", cssVar: "--scale-purple", group: "scale" },
  { id: "scale.pink", cssVar: "--scale-pink", group: "scale" },
  { id: "scale.silver", cssVar: "--scale-silver", group: "scale" },
  { id: "scale.steel", cssVar: "--scale-steel", group: "scale" },
  { id: "scale.graphite", cssVar: "--scale-graphite", group: "scale" },

  { id: "syntax.keyword", cssVar: "--syntax-keyword", group: "syntax" },
  { id: "syntax.control", cssVar: "--syntax-control", group: "syntax" },
  { id: "syntax.operator", cssVar: "--syntax-operator", group: "syntax" },
  { id: "syntax.string", cssVar: "--syntax-string", group: "syntax" },
  { id: "syntax.escape", cssVar: "--syntax-escape", group: "syntax" },
  { id: "syntax.regexp", cssVar: "--syntax-regexp", group: "syntax" },
  { id: "syntax.comment", cssVar: "--syntax-comment", group: "syntax" },
  { id: "syntax.number", cssVar: "--syntax-number", group: "syntax" },
  { id: "syntax.constant", cssVar: "--syntax-constant", group: "syntax" },
  { id: "syntax.function", cssVar: "--syntax-function", group: "syntax" },
  { id: "syntax.method", cssVar: "--syntax-method", group: "syntax" },
  { id: "syntax.type", cssVar: "--syntax-type", group: "syntax" },
  { id: "syntax.class", cssVar: "--syntax-class", group: "syntax" },
  { id: "syntax.namespace", cssVar: "--syntax-namespace", group: "syntax" },
  { id: "syntax.variable", cssVar: "--syntax-variable", group: "syntax" },
  { id: "syntax.property", cssVar: "--syntax-property", group: "syntax" },
  { id: "syntax.parameter", cssVar: "--syntax-parameter", group: "syntax" },
  { id: "syntax.tag", cssVar: "--syntax-tag", group: "syntax" },
  { id: "syntax.attribute", cssVar: "--syntax-attribute", group: "syntax" },
  { id: "syntax.punctuation", cssVar: "--syntax-punctuation", group: "syntax" },
];

export const ROLE_BY_ID = new Map(ROLES.map((r) => [r.id, r]));
export const ROLE_BY_CSS_VAR = new Map(ROLES.map((r) => [r.cssVar, r]));

// ---- Generation ----

/** Expand a palette into `{ roleId: value }`. */
export function buildRoleValues(palette: Palette): Record<string, string> {
  const p: PaletteColors = palette.colors;
  const v = variants(palette.appearance);

  return {
    "fg.default": p.text,
    "fg.muted": p.textMuted,
    "fg.subtle": p.textSubtle,
    // A step below subtle, for text that stands in for absent content:
    // placeholders, ghost hints, empty-state furniture. Derived as a wash of
    // subtle rather than authored per palette, so every theme's watermark sits
    // the same distance under its own subtle and no palette can forget it. A
    // wash, not a flat mix, because placeholders live on several surfaces
    // (canvas, card, input) and one flat stop cannot recede on all of them.
    // Light needs the heavier hand: the same wash over white all but vanishes.
    "fg.watermark": alpha(p.textSubtle, v({ dark: 0.55, light: 0.65 })),
    "fg.onEmphasis": p.textOnEmphasis,

    "canvas.default": p.canvas,
    "canvas.card": p.card,
    "canvas.head": p.head,
    "canvas.input": p.input,

    // Dark washes its hairline to 8%; light uses the stop solid.
    "border.default": alpha(p.borderTint, v({ dark: 0.08, light: 1 })),
    "border.strong": alpha(p.lineTint, 0.13),
    "border.rail": p.rail,

    "scrollbar.thumb": alpha(p.lineTint, v({ dark: 0.11, light: 0.14 })),
    "scrollbar.thumbHover": alpha(p.lineTint, v({ dark: 0.2, light: 0.26 })),

    "accent.fg": p.accent,
    "accent.subtle": p.accentSubtle,

    "neutral.hover": p.hover,
    "neutral.subtle": alpha(p.fillTint, v({ dark: 0.12, light: 0.06 })),

    // The `.fg` stop is read AS text on the canvas; the `.emphasis` stop is a
    // fill that carries `fg.onEmphasis`. One value cannot do both: Tori Dark's
    // danger reads at 5.6 on the canvas and 3.2 under a white label.
    "danger.fg": p.danger,
    "danger.emphasis": p.dangerStrong,
    "attention.fg": p.attention,
    "attention.emphasis": p.attentionStrong,
    "success.fg": p.success,
    "success.emphasis": p.successStrong,
    "info.fg": p.info,

    "diff.added": p.diffAdded,
    "diff.modified": p.diffModified,
    "diff.deleted": p.diffDeleted,
    // Word highlights are washes of the line colour they sit on, so the two can
    // never drift apart. Light needs a heavier wash: this faint over white is
    // invisible.
    "diff.addedWord": alpha(p.diffAdded, v({ dark: 0.32, light: 0.24 })),
    "diff.deletedWord": alpha(p.diffDeleted, v({ dark: 0.32, light: 0.22 })),

    "diag.error": p.diagError,
    "diag.warning": p.diagWarning,
    "diag.info": p.diagInfo,
    "diag.hint": p.diagHint,

    "agent.claude": p.agentClaude,

    "scrim.default": alpha(p.scrimTint, v({ dark: 0.45, light: 0.3 })),
    "scrim.soft": alpha(p.scrimTint, v({ dark: 0.35, light: 0.22 })),
    "scrim.strong": alpha(p.scrimTint, v({ dark: 0.72, light: 0.5 })),

    "status.progress": p.statusProgress,
    "status.needsYou": p.statusNeedsYou,
    "status.idle": p.statusIdle,
    "status.running": p.statusRunning,

    // Opaque mixes into `card`, as `brand.wash` explains, and so the gate can
    // measure text on them. The text stop pulls the hue toward the theme's own
    // text: lighter on dark, darker on light, legible on its tint and canvases.
    "progress.subtle": mix(p.card, p.statusProgress, v({ dark: 0.12, light: 0.07 })),
    "progress.border": alpha(p.statusProgress, v({ dark: 0.42, light: 0.35 })),
    "progress.onSubtle": mix(p.statusProgress, p.text, 0.4),
    "needsYou.subtle": mix(p.card, p.statusNeedsYou, v({ dark: 0.12, light: 0.07 })),
    "needsYou.border": alpha(p.statusNeedsYou, v({ dark: 0.45, light: 0.4 })),
    "needsYou.onSubtle": mix(p.statusNeedsYou, p.text, 0.4),
    "danger.subtle": mix(p.card, p.danger, v({ dark: 0.12, light: 0.07 })),
    "danger.border": alpha(p.danger, v({ dark: 0.5, light: 0.42 })),
    "danger.onSubtle": mix(p.danger, p.text, 0.4),

    "brand.default": p.brand,
    "brand.strong": p.brandStrong,
    // brandTint is its own primitive rather than a reuse of the brand stop, and
    // in Tori Dark it is deliberately NOT --tori-gold-500: the wash it replaces
    // was rgba(201, 150, 83, ...) while gold-500 is #c19653, i.e. 193. That
    // 8-point gap in red predates this migration and is preserved on purpose, so
    // the pill fill and focus ring render exactly as before. Change it only as a
    // deliberate design call, not as a "fix" to make it match gold-500.
    "brand.subtle": alpha(p.brandTint, v({ dark: 0.16, light: 0.14 })),
    // The faintest brand-tinted *surface*, for a fill that should read as warm
    // rather than as gold. `brand.subtle` is a wash meant to be seen as brand
    // colour; this is a card that merely remembers the brand, and at these
    // amounts the result is a near-neutral (Tori Dark lands on #272628).
    //
    // Mixed into `card`, not layered over the canvas, and opaque for two
    // reasons. It has to stay a surface: a translucent brand wash on the
    // transcript would be a hue with no elevation, and the whole point is that
    // the surface it paints sits a step above the pane. And an alpha fill would
    // double where two of them touch, which is exactly the case `mix` exists
    // for. Light mixes one point lower because its brandTint is a dark brown
    // going onto a near-white card, so the same amount reads stronger.
    "brand.wash": mix(p.card, p.brandTint, v({ dark: 0.07, light: 0.06 })),
    "brand.bar": p.brand,
    // A focus ring is a WCAG 2.4.11 indicator, so it is measured, not judged by
    // eye. At the wash this used to carry (dark 0.5, light 0.4) it sat at 2.5
    // and 1.7 against the surfaces it is drawn on, i.e. a focus signal that only
    // reads if you already know where focus is.
    "brand.ring": alpha(p.brandTint, v({ dark: 0.6, light: 0.77 })),
    "brand.on": p.brandOn,

    // Teal from `info`: green is the open pull request's glyph, and `ansiCyan`
    // is not teal in every palette. Mixed into `canvas`, which the sidebar sits
    // on, and opaque so the gate can measure the label drawn on it.
    "done.wash": mix(p.canvas, p.info, v({ dark: 0.08, light: 0.06 })),
    "done.selected": mix(p.canvas, p.info, v({ dark: 0.16, light: 0.1 })),
    "done.bar": p.info,

    // The blocking tier: the one look for a surface that has stopped the turn
    // and is waiting on the user. Two of them exist (the permission prompt and
    // the question card) and they were separately spelled `brand-default` over
    // `canvas-card`, so nothing stopped them drifting and neither could be
    // restyled without moving the brand everywhere else too.
    //
    // The fill is a warmer step ABOVE the chat pane, which is itself `card`, so
    // until now a blocking card was identified by a gold hairline and nothing
    // else. Mixed and opaque for the reason `brand.wash` documents: it has to
    // read as a surface with elevation, and an alpha fill doubles wherever two
    // of them touch.
    //
    // The amounts are a CEILING the palettes set, not a look that was chosen.
    // Every step off `card` moves the surface toward the text drawn on it, and
    // the card is full of recessive labels (a hint, a preview, "from a
    // subagent"). Measured across all five bundled palettes: past 0.04 dark,
    // `fg.subtle` falls under its 3.0 floor on Tori Dark, and past 0.07 light,
    // `fg.muted` falls under 4.5 on Rose Pine Dawn. So the fill yields and the
    // hierarchy inside the card stays. The gate holds the line from here:
    // `fg.default`, `fg.muted` and `fg.subtle` all name this surface now, which
    // they did not while it was `canvas.card` under another name.
    "blocking.surface": mix(p.card, p.brandTint, v({ dark: 0.04, light: 0.07 })),
    "blocking.border": p.brand,
    "blocking.fg": p.text,
    // The one coloured word inside: inline code in the prompt's question, the
    // card's own emphasis. `brand.strong`, not `brand.default`, because it is
    // read as text on a lifted surface rather than as a frame around one.
    "blocking.accent": p.brandStrong,

    "ansi.cursor": p.ansiCursor,
    "ansi.selection": alpha(p.ansiSelectionTint, v({ dark: 0.4, light: 0.25 })),
    "ansi.black": p.ansiBlack,
    "ansi.red": p.ansiRed,
    "ansi.green": p.ansiGreen,
    "ansi.yellow": p.ansiYellow,
    "ansi.blue": p.ansiBlue,
    "ansi.magenta": p.ansiMagenta,
    "ansi.cyan": p.ansiCyan,
    "ansi.white": p.ansiWhite,
    "ansi.brightBlack": p.ansiBrightBlack,
    "ansi.brightRed": p.ansiBrightRed,
    "ansi.brightGreen": p.ansiBrightGreen,
    "ansi.brightYellow": p.ansiBrightYellow,
    "ansi.brightBlue": p.ansiBrightBlue,
    "ansi.brightMagenta": p.ansiBrightMagenta,
    "ansi.brightCyan": p.ansiBrightCyan,
    "ansi.brightWhite": p.ansiBrightWhite,

    // Light elevation is softer AND thinner: a dark ring reads as grime on a
    // bright surface.
    "shadow.sm": `0 1px 2px ${alpha(p.shadowTint, v({ dark: 0.4, light: 0.08 }))}`,
    "shadow.md": `0 4px 12px ${alpha(p.shadowTint, v({ dark: 0.45, light: 0.12 }))}`,
    "shadow.lg": `0 12px 32px ${alpha(p.shadowTint, v({ dark: 0.55, light: 0.18 }))}`,

    // The same hue as a bare channel triple, so the shell can mix its own
    // alpha. A space that carries a colour overrides the TRIPLE and inherits
    // the strength, which is what keeps a per-space wash from washing light
    // mode out: the theme still decides how strong a hue reads on its canvas,
    // and the space only decides which hue.
    "shell.glowRgb": rgbTriple(p.glowTint),
    // The one floating work-card. Dark carries the depth in opacity, light in
    // spread, so the geometry differs and not just the stop.
    "shell.cardShadow": v({
      dark: `0 4px 24px ${alpha(p.shadowTint, 0.4)}`,
      light: `0 12px 32px ${alpha(p.shadowTint, 0.12)}`,
    }),

    // Tree and tab start as aliases of the chrome roles they replace, so this
    // phase changes no pixel. The point is not a new look, it is that a theme
    // can now restyle tree selection or the tab bar WITHOUT moving every focus
    // ring in the app - which is what reusing accent and brand for row state
    // made impossible. A role that is currently equal to another is not
    // redundant if the two are free to diverge.
    "tree.rowHover": p.hover,
    "tree.rowActive": p.accentSubtle,

    "tab.activeBg": p.hover,
    "tab.activeFg": p.text,
    "tab.hoverBg": p.hover,
    "tab.inactiveFg": p.textMuted,
    "tab.dirty": p.brand,

    // Its own family rather than a member of tree and again of tab: "the agent
    // touched this file" and "the agent is writing it right now" are one claim
    // rendered on two surfaces, and duplicating them would let a theme make the
    // tree and the tab bar disagree about the same file.
    "activity.touched": p.accent,
    "activity.editing": p.brand,

    "scale.red": p.scaleRed,
    "scale.green": p.scaleGreen,
    "scale.blue": p.scaleBlue,
    "scale.yellow": p.scaleYellow,
    "scale.slate": p.scaleSlate,
    "scale.orange": p.scaleOrange,
    "scale.purple": p.scalePurple,
    "scale.pink": p.scalePink,
    "scale.silver": p.scaleSilver,
    "scale.steel": p.scaleSteel,
    "scale.graphite": p.scaleGraphite,

    // Passed through one for one. Syntax is the one family with no derivation:
    // see the note in schema.ts on why every category is authored.
    "syntax.keyword": p.synKeyword,
    "syntax.control": p.synControl,
    "syntax.operator": p.synOperator,
    "syntax.string": p.synString,
    "syntax.escape": p.synEscape,
    "syntax.regexp": p.synRegexp,
    "syntax.comment": p.synComment,
    "syntax.number": p.synNumber,
    "syntax.constant": p.synConstant,
    "syntax.function": p.synFunction,
    "syntax.method": p.synMethod,
    "syntax.type": p.synType,
    "syntax.class": p.synClass,
    "syntax.namespace": p.synNamespace,
    "syntax.variable": p.synVariable,
    "syntax.property": p.synProperty,
    "syntax.parameter": p.synParameter,
    "syntax.tag": p.synTag,
    "syntax.attribute": p.synAttribute,
    "syntax.punctuation": p.synPunctuation,
  };
}

/** Expand a palette into `{ cssVar: value }`, ready to paint onto <html> or to
 *  emit into the token layer. Throws if the role table and the generator have
 *  drifted apart, because a silently missing role is a token that keeps its
 *  previous theme's value. */
export function buildRoles(palette: Palette): Record<string, string> {
  const values = buildRoleValues(palette);
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const role of ROLES) {
    const value = values[role.id];
    if (typeof value !== "string" || value.length === 0) missing.push(role.id);
    else out[role.cssVar] = value;
  }
  const extra = Object.keys(values).filter((id) => !ROLE_BY_ID.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `roles.ts is inconsistent for "${palette.id}": ` +
        `${missing.length} declared but not produced (${missing.join(", ")}), ` +
        `${extra.length} produced but not declared (${extra.join(", ")})`,
    );
  }
  return out;
}
