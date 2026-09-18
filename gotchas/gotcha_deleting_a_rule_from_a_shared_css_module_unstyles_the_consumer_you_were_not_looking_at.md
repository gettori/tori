---
summary: a CSS rule dead in one folder can be the only height bound for a different file sharing the module, grep every importer
status: current
updated: 2026-08-13
source: "Delete the legacy modal chrome (personal/tori, branch `101-delete-legacy-modal-chrome`, issue #101, part of #93); `src/components/Omnibox/Omnibox.module.css`, `scripts/check-tokens.mjs`; regression introduced in commit be21ced"
---

# Deleting a rule from a shared CSS module unstyles the consumer you were not looking at

Before deleting a rule from a CSS module, grep for **every** file importing that module, not just the folder it lives in. `be21ced` deleted `.picker` from `Dialogs.module.css` because the dialogs' picker had moved inside `Dialog`, whose body is now the scroller, so the flex column and its `max-height: min(70vh, 520px)` were genuinely dead **for the dialogs**. `Omnibox.tsx` imported the same module from another folder (`import dialogStyles from "../Dialogs/Dialogs.module.css"`) and had no `Dialog` under it, so that rule was its only height bound. With `MAX_RESULTS` at 200 the palette then overflowed a fixed, centred backdrop in both directions and the rows above the fold became unreachable.

Nothing anywhere failed. `dialogStyles.picker` resolved to `undefined`, `class={undefined}` rendered no class, `tsc` does not read stylesheets, and vitest's CSS-Modules stub returns a name for any key asked of it, so no test could have noticed either (see [[gotcha_vitest_stubs_css_imports_to_the_empty_string]]). The deletion was correct for the consumer in front of you and wrong for the one you had no reason to open, which is the whole trap: a shared module makes every rule a cross-folder API without ever looking like one.

The fix was to stop sharing: the palette now carries its own copy in `Omnibox.module.css`, and `check-tokens.mjs` check 8 asserts its `.panel` declares `max-height` and its `.list` declares `overflow-y`.
