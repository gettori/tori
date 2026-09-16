---
summary: CodeMirror decoration precedence nests spans inward, so the innermost element's color wins, not the highest specificity
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/sway, branch `wave-4`); Phase 7; `src/panels/Editor/semanticHighlight.ts`; commit 075b5d7"
---

# CodeMirror decoration precedence nests inward

Do NOT assume higher precedence means "on top". For overlapping mark decorations CodeMirror emits **nested** spans, and it is the *innermost* element whose own `color` rule paints the text — specificity across two different elements never enters into it. Higher facet precedence puts a decoration further **in**, not further out. `@codemirror/language` registers `treeHighlighter` at `Prec.high` (`dist/index.js:1797`), so a semantic-token field left at default precedence *wraps* the grammar's span and the lexical guess wins every time, which on screen is indistinguishable from the language server never having answered. `semanticHighlight()` is `Prec.highest` for this reason and `semanticHighlight.test.tsx` asserts the nesting. Belt and braces: write the theme rules one class deeper too, for the case where the two cover exactly the same run and CodeMirror emits a single element carrying both classes. See [[concept_semantic_token_layering]].
