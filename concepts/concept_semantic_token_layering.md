---
summary: a server's resolved colours paint over the grammar's guess, and deltaStart in the wire format is relative only per line
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phase 7; commit 075b5d7; `src/utils/semanticTokens.ts`, `src/panels/Editor/semanticHighlight.ts`, `lspSemanticTokens.ts`"
---

# Semantic tokens: the server's answer layered over the grammar's guess

A grammar can only see shape. `foo` in `f(foo)` and `foo` in `{ foo: 1 }` are the same three characters to Lezer, so lexical highlighting has to guess — Tori's guess was a `t.local(t.variableName)` rule that painted a good deal of ordinary local state as parameters. A language server has resolved the program, so it can say which is which.

**The two coexist; the server does not replace the grammar.** Lexical highlighting colours every character instantly and offline; the server colours the subset it has actually resolved, hundreds of milliseconds later, and only while it is running. So semantic answers arrive as *decorations on top*, never as a swapped `HighlightStyle`, and a file with no server looks exactly as it did. The capability block says so too: `augmentsSyntaxTokens: true`.

## The wire format, and its one real trap

`textDocument/semanticTokens/full` answers with a flat array of unsigned integers, five per token, every number relative to the token before it:

| field | meaning |
|---|---|
| `deltaLine` | lines since the previous token's line |
| `deltaStart` | characters since the previous token's start **when `deltaLine` is 0**, and an absolute column otherwise |
| `length` | in UTF-16 code units |
| `type` | an index into the legend's `tokenTypes` |
| `modifiers` | a bitset over the legend's `tokenModifiers` |

The `deltaStart` rule is the whole trap. Read as always-relative, every token after the first line break walks further and further right — and the result still looks like plausible highlighting, which is why it needs a test with a multi-line delta rather than an eyeball.

The **legend** is declared once, at `initialize`, on `semanticTokensProvider`. Without it the numbers are uninterpretable, and guessing at one colours the file confidently and wrongly, so a provider with no legend is treated exactly like no provider: keep the grammar's colours.

## Colours move, they are not added

Every token type maps onto a `--syntax-*` role the theme already declares and the grammar already uses. Semantic colouring therefore introduces no new colour — it moves *existing* colours onto the runs of text that actually deserve them. A type Tori has no role for (rust-analyzer ships a dozen of its own) simply gets no class and keeps whatever the grammar gave it.

Only one modifier renders: `deprecated`, struck through rather than recoloured, so it composes — a deprecated method should still read as a method.

Because the stylesheet generates one rule per role as `var(--syntax-${role})`, check 3 of `scripts/check-tokens.mjs` can only be told to trust it. **Check 7 earns that trust**, the way check 6 does for seti hues: every role the map can emit must be a declared syntax role. The failure it catches is the quietest in the editor — a missing role resolves to nothing, the element inherits, and the identifier keeps the *grammar's* colour, which is indistinguishable from the server not running. See [[concept_design_token_system]] and [[lesson_a_rule_that_matches_nothing_passes_every_guard]].

## Applying an answer to a document that may have moved

Every token is a position, so three guards stand between a reply and the screen:

- **`sync()` before the request.** The library's `autoSync` is debounced by 500 ms, so a request made sooner is answered about the document as it was before the last keystroke ([[gotcha_autosync_is_debounced_so_sync_before_a_position_request]]).
- **Newest-wins by path.** Four things re-ask (a tab swap, a client coming up, the typing debounce, the server's own refresh), a busy server can answer out of order, and an older reply landing last paints every colour in the file against an older document.
- **Document identity, compared before and after.** `Text` is immutable, so its identity is the only handle CodeMirror offers on "is this still the document I asked about?" — the same guard format-on-save uses ([[component_project_formatter]]). A moved document drops the answer and re-asks *through the debounce*, so the calls coalesce rather than turning every keystroke into a round trip.

Decorations map through edits rather than being dropped on one: discarding them per keystroke would leave the file flashing back to lexical colours for as long as anyone is typing. They simply go stale until the next answer lands.

The decision core is a pure function with injected deps, the shape `formatOnSave.ts` and `lspRename.ts` established, because every branch in it is about a race between a subprocess and somebody typing and none of them should need CodeMirror standing up to test.

## Related

- [[concept_lsp_capability_contract]] — including the `refreshSupport` exception this feature earned.
- [[component_lsp_host]] — the session the request goes to.
- [[component_cm6_editor]] — where the decorations land.
- [[concept_contrast_gate]] · [[concept_design_token_system]] — the role layer the colours come from.
- [[gotcha_codemirror_decoration_precedence_nests_inward]] — which of two overlapping marks actually paints.
