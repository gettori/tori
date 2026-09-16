---
summary: a source scanning test walking a jsx tag must skip comments before tracking quotes, an apostrophe opens a string to EOF
status: current
updated: 2026-08-13
source: "plan \"Tooltip primitive and the `title=` sweep\" (personal/sway, branch `102-tooltip-primitive`, issue #102); `src/test/interactiveTitle.test.ts`; commit `51771df`"
---

# An apostrophe in a JSX-tag comment runs a naive attribute scanner to EOF

A source-scanning test that walks an opening tag to its closing `>` must skip `//` and `/* */` comments *before* it tracks quotes. A perfectly ordinary note between two attributes — `// a tab's visible text` — opens a single-quoted string that never closes, so the scan runs past the tag, past the file, and reports that tag's attribute region as everything to EOF. Every check downstream then reads the wrong attributes, silently and plausibly. Two related traps in the same parser: scanning *backwards* from an attribute to the nearest `<` finds the inner tag of `<IconButton icon={<Icon …/>} title=…>`, and picking the *first* enclosing region rather than the innermost reads a nested `<Tab>`'s attributes off the `<OverflowTabBar>` whose `renderTab={…}` contains it.
