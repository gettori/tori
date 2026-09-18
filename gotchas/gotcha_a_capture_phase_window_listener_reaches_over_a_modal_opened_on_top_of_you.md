---
summary: a capture phase window keydown listener steals Escape from a modal opened over it, put the handler on the panel instead
status: current
updated: 2026-08-11
source: "Settings redesign: horizontal tab strip with per-tab search counts (personal/tori, branch `settings`, issue #91); Phase 2 self-review; `src/panels/Settings/Settings.tsx` (`onPanelKeyDown`); commit 782c8d2"
---

# A capture-phase `window` listener reaches over a modal opened on top of you

Do NOT copy `ShortcutSheet`'s Escape handling (a `window` keydown listener in the **capture** phase, with `stopPropagation`) into a modal that something else can open over. ⌘K reaches the command palette over an open Settings panel, and the palette closes on its own bubble-phase handler at `Omnibox.tsx:512`: a capture-phase listener on the panel underneath fires first, swallows the keystroke, and clears the *search box* instead. The palette appears stuck. `ShortcutSheet` gets away with it because nothing opens over it, and its reason for reaching for `window` at all is a focused xterm swallowing keydown before it bubbles (see [[gotcha_a_focused_xterm_swallows_keydown_before_window]]) — a dialog with a real focus trap does not have that problem, because every keystroke already originates inside it. Put the handler on the panel element. Why: the two modals are both "portaled overlay with Escape to close", so the pattern looks like the thing to copy, and the collision only appears with both open at once.
