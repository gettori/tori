// The Phase 4 namespace flip, written out in full.
//
// Every entry is `old cssVar -> new cssVar`. The new name is the role's `id`
// spelled as a custom property (`family.memberName` -> `--family-member-name`),
// per adr_theme_palette_roles, but it is listed literally rather than derived at
// runtime: a codemod that rewrites ~1000 call sites should be auditable in a
// diff, not the output of a regex that nobody read.
//
// This table lives next to tokens-baseline.json because it exists to translate
// it. The baseline is keyed by the OLD names by construction - it was frozen
// before any rename - so proving the flip is purely nominal means checking, per
// pair, that `newMap[RENAME[old]] === baseline[old]`. The two files are
// therefore exactly as permanent as each other.
//
// 28 of the 75 roles keep their name; they are listed anyway, so "every role is
// accounted for" is a property of the table rather than of the reader's memory.
export const RENAME: Record<string, string> = {
  // fg
  "--text": "--fg-default",
  "--text-dim": "--fg-muted",
  "--text-faint": "--fg-subtle",
  "--on-solid": "--fg-on-emphasis",

  // canvas
  "--bg": "--canvas-default",
  "--pane-bg": "--canvas-card",
  "--pane-head-bg": "--canvas-head",
  "--input-bg": "--canvas-input",

  // border
  "--border": "--border-default",
  "--border-strong": "--border-strong",
  "--graph-rail": "--border-rail",

  // scrollbar
  "--scrollbar-thumb": "--scrollbar-thumb",
  "--scrollbar-thumb-hover": "--scrollbar-thumb-hover",

  // accent
  "--accent": "--accent-fg",
  "--sel": "--accent-subtle",

  // neutral
  "--hover": "--neutral-hover",
  "--fill-subtle": "--neutral-subtle",

  // danger / attention / success / info
  "--danger": "--danger-fg",
  "--warn": "--attention-fg",
  "--warn-strong": "--attention-emphasis",
  "--success": "--success-fg",
  "--info": "--info-fg",

  // diff
  "--diff-added": "--diff-added",
  "--diff-modified": "--diff-modified",
  "--diff-deleted": "--diff-deleted",
  "--diff-added-word": "--diff-added-word",
  "--diff-deleted-word": "--diff-deleted-word",

  // diag
  "--diag-error": "--diag-error",
  "--diag-warning": "--diag-warning",
  "--diag-info": "--diag-info",
  "--diag-hint": "--diag-hint",

  // agent
  "--agent-claude": "--agent-claude",
  "--agent-pi": "--agent-pi",

  // scrim
  "--scrim": "--scrim-default",
  "--scrim-soft": "--scrim-soft",

  // status
  "--status-progress": "--status-progress",
  "--status-needs-you": "--status-needs-you",
  "--status-idle": "--status-idle",
  "--status-running": "--status-running",

  // brand
  "--brand": "--brand-default",
  "--brand-strong": "--brand-strong",
  "--brand-subtle": "--brand-subtle",
  "--brand-bar": "--brand-bar",
  "--brand-ring": "--brand-ring",
  "--brand-on": "--brand-on",

  // ansi (was --term-*, which named the consumer rather than the concept: the
  // same 16 slots now also feed the editor's ANSI-coloured output)
  "--term-cursor": "--ansi-cursor",
  "--term-selection": "--ansi-selection",
  "--term-black": "--ansi-black",
  "--term-red": "--ansi-red",
  "--term-green": "--ansi-green",
  "--term-yellow": "--ansi-yellow",
  "--term-blue": "--ansi-blue",
  "--term-magenta": "--ansi-magenta",
  "--term-cyan": "--ansi-cyan",
  "--term-white": "--ansi-white",
  "--term-bright-black": "--ansi-bright-black",
  "--term-bright-red": "--ansi-bright-red",
  "--term-bright-green": "--ansi-bright-green",
  "--term-bright-yellow": "--ansi-bright-yellow",
  "--term-bright-blue": "--ansi-bright-blue",
  "--term-bright-magenta": "--ansi-bright-magenta",
  "--term-bright-cyan": "--ansi-bright-cyan",
  "--term-bright-white": "--ansi-bright-white",

  // shadow / shell
  "--shadow-sm": "--shadow-sm",
  "--shadow-md": "--shadow-md",
  "--shadow-lg": "--shadow-lg",
  "--shell-glow": "--shell-glow",
  "--work-card-shadow": "--shell-card-shadow",

  // syntax
  "--syn-keyword": "--syntax-keyword",
  "--syn-string": "--syntax-string",
  "--syn-comment": "--syntax-comment",
  "--syn-number": "--syntax-number",
  "--syn-function": "--syntax-function",
  "--syn-type": "--syntax-type",
  "--syn-variable": "--syntax-variable",
};
