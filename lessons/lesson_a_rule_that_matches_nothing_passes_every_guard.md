---
summary: a CSS rule written against the wrong sibling matched nothing, yet the token guard passed since var() there resolves
status: current
updated: 2026-08-12
source: "Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phase 8; commit 14b389b; `src/panels/Editor/vimMode.ts`, `vimMode.test.tsx`"
---

# A CSS rule that matches nothing passes every guard you have

## What happened

Vim mode's block cursor had to be themed, because `@replit/codemirror-vim` hardcodes `#ff9696` — the one colour in the editor that would have read identically in a light and a dark theme, which is exactly the failure [[concept_contrast_gate]] and the token guard exist to prevent.

The theme was written against `.cm-content .cm-fat-cursor`. `BlockCursorPlugin` appends its layer to `view.scrollDOM` (`dist/index.cjs:1163`), a **sibling** of the content. Every rule matched nothing. The block cursor would have shipped pink in all five palettes.

Nothing complained:

- `tsc` was clean — it is a string in an object.
- All tests passed — none of them rendered a block cursor, and jsdom cannot measure one anyway (`coordsAtPos` needs `getClientRects`).
- **`node scripts/check-tokens.mjs` passed**, and would have passed forever. It resolves every `var(--x)` in `src/` against the role registry. `var(--brand-default)` in a rule that matches nothing still resolves perfectly.

It was caught by reading the package's source during self-review, not by any signal the repo produces.

## Why

The token guard checks **names**, and a name is all it can check. Whether a selector reaches an element is a fact about the runtime DOM, which no static scan of `src/` can see. The same blind spot already had a documented instance — [[gotcha_codemirror_lint_ships_hardcoded_colours_the_token_guard_cannot_see]] — but that one is about a dependency's colours being *invisible* to the guard. This is worse: the override was written, it was visible, it was verified, and it was inert.

Every guard in this repo that closes such a gap works the same way, and that is the pattern: **check 6** proves every seti hue the generated mapping emits has a `scale.*` role; **check 7**, added in this same wave, proves every role semantic tokens paint with has a `--syntax-*` role. Both take a name the code will actually produce and prove the other side answers to it. Neither can prove a selector matches.

## What to do next time

When a style targets an element **a dependency creates**, do not write the selector from memory or from the rendered page. Two steps:

1. **Read the package source for where the element is mounted**, not just what it is called. `.cm-content` versus `scrollDOM` is one line in a constructor and it decides whether the whole rule exists.
2. **Derive both sides from one exported constant, and assert it against the real DOM.** `vimMode.ts` exports `CURSOR_LAYER = "cm-vimCursorLayer"`, builds its selectors from it, and `vimMode.test.tsx` mounts a view and asserts the package's own element carries that class — and that it is *not* inside `contentDOM`. A rename on either side now fails a test. The element's construction needs no layout, so jsdom can see it even though it can never render the cursor.

Generalises past CSS: any assertion that is only about spelling needs a companion that is about reachability. A guard that cannot fail on the bug you are about to write is not protecting you from it.

## Related

- [[lesson_a_gate_that_cannot_fail_is_not_a_gate]] — the same shape one layer out, in test assertions rather than selectors. Its axe instance is the sharpest yet: `link-in-text-block` and `scrollable-region-focusable` are *in* the tag set, are enabled, run on every assertion, and can never match under jsdom, so they read as coverage while being incapable of a result. Both are now disabled by name.
- [[lesson_a_test_can_pass_because_its_fixture_stopped_parsing]] — the same shape in the test layer: a green signal that means nothing.
- [[concept_design_token_system]] — the six-then-seven-check guard and what each check can and cannot see.
- [[concept_contrast_gate]] — the other half of "measured, not reviewed".
- [[component_cm6_editor]] — where vim mode lives.
- [[gotcha_codemirror_lint_ships_hardcoded_colours_the_token_guard_cannot_see]]
