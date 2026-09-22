// Modal editing, held in a compartment so it can be switched on and off in a
// live buffer.
//
// Three things about `@replit/codemirror-vim` decide the shape of this file:
//
//   * **It intercepts keys through a `keydown` DOM handler on a ViewPlugin, not
//     through a keymap**, and when it consumes one it calls `stopPropagation()`
//     as well as `preventDefault()` (`dist/index.cjs:1480-1527`). So a key vim
//     claims is dead everywhere: not just in CodeMirror's other keymaps, but in
//     Tori's window-level hotkey dispatcher too. What saves the app's own
//     bindings is that `vimKeyFromEvent` turns Cmd into `M-` and vim binds
//     nothing with it, so ⌘S, ⌘⌥D and the rest are never claimed in the first
//     place. `vimMode.test.tsx` asserts that rather than trusting it.
//
//   * **Its `vim()` must come before the other keymaps.** Its own README says
//     so, and the reason is the handler ordering above; `defaultKeymap`'s
//     Mac Emacs bindings (Ctrl-A, Ctrl-E, Ctrl-D...) collide with vim's Ctrl
//     commands, and in normal mode vim is the one that should win.
//
//   * **It hardcodes `#ff9696` for the block cursor** and styles its status
//     panel with nothing but a font and some padding. Both are `EditorView`
//     themes, so the rules below have to outrank them rather than merely follow
//     them; see `vimTheme`.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";

/**
 * Theme the block cursor and the status line from tokens.
 *
 * Two things make these selectors what they are, and getting either wrong fails
 * silently with the package's `#ff9696` still on screen:
 *
 *   * **The block cursor is not in `.cm-content`.** `BlockCursorPlugin` appends
 *     its layer to `view.scrollDOM` (`dist/index.cjs:1163`), a *sibling* of the
 *     content, so a `.cm-content .cm-fat-cursor` rule matches nothing at all.
 *     `.cm-vimCursorLayer` is that layer, and using it also buys the extra
 *     specificity the next point needs.
 *
 *   * **The package's rules are `EditorView.theme` too**
 *     (`dist/index.cjs:1217-1235`), scoped under the editor's generated class
 *     exactly as these are. A rule written at the same depth as theirs would
 *     tie, and the winner would come down to which stylesheet the browser
 *     mounted last. Every rule here is one class deeper than the one it
 *     replaces, so it wins by the rules rather than by luck.
 *
 * `!important` throughout the colour rules because the cursor's own `color` is
 * an *inline* style, copied off the measured text (`dist/index.cjs:1144`), and
 * nothing without it can touch an inline style.
 *
 * The status panel needs none of this: the package styles it through
 * `baseTheme`, which is designed to lose to a theme.
 */
/** The class `BlockCursorPlugin` puts on its layer. Named here and asserted
 *  against the real DOM in `vimMode.test.tsx`, so a rename on either side fails
 *  a test rather than quietly leaving the rules below matching nothing. */
export const CURSOR_LAYER = "cm-vimCursorLayer";

const vimTheme = EditorView.theme({
  // Their `.cm-fat-cursor { background: #ff9696 }`, which is the one colour in
  // the editor that would have read identically in a light and a dark theme.
  [`.${CURSOR_LAYER} .cm-fat-cursor`]: {
    background: "var(--brand-default)",
    // The character under a block cursor is on the block, not on the page, so
    // it needs the colour that pairs with it - otherwise a dark keyword sits on
    // a dark block and the caret reads as a hole. `brand.on` on `brand.default`
    // is a pairing `contrast.test.ts` already measures in every bundled palette.
    color: "var(--brand-on) !important",
  },
  // An unfocused editor shows the block as an outline with the character back
  // in its own colour. `color` is restated rather than left to the package: its
  // transparent rule and the one above are both `!important`, and without this
  // the two would tie on specificity and settle it by stylesheet order.
  [`&:not(.cm-focused) .${CURSOR_LAYER} .cm-fat-cursor`]: {
    background: "none",
    outline: "solid 1px var(--brand-default)",
    color: "transparent !important",
  },
  ".cm-vim-panel": {
    backgroundColor: "var(--canvas-head)",
    color: "var(--fg-muted)",
    // The same family and size the content uses, so a pending `d2` lines up
    // with the text it is about to act on.
    fontFamily: 'var(--editor-font-family, "SF Mono", Menlo, Monaco, monospace)',
    fontSize: "var(--editor-font-size, 13px)",
  },
  // The `:` and `/` prompts are an input inside that panel. The package clears
  // its border and background but says nothing about its colour, so it would
  // render in the browser default rather than the theme's.
  ".cm-vim-panel input": { color: "var(--fg-default)" },
});

/**
 * The extension for a given setting, empty when vim is off.
 *
 * `status: true` asks for the status line, which is not decoration: a pending
 * `d2` or a half-typed `:w` is invisible without it, and modal editing where
 * you cannot see the mode is modal editing you have to guess at.
 */
// Built once. `vim()` returns a fresh array each call, and its status-panel
// entry is a fresh `showPanel.of(...)` with it; CodeMirror compares facet inputs
// by identity, so calling it per swap would tear the status line down and
// rebuild it on every tab switch. Everything inside is a module-level singleton
// in the package already, so one instance across every buffer is what it expects.
const VIM_ON: Extension = [vim({ status: true }), vimTheme];

export function vimExtension(on: boolean): Extension {
  return on ? VIM_ON : [];
}
