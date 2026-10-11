---
summary: text inside a menuitem joins its accessible name, so a live note renames the row; aria-hide it and point aria-describedby at it
status: current
updated: 2026-10-11
source: plan "Pull, Pull (Rebase) and Push say what they will do to this branch" (gettori/tickets#73, branch phase-1-block-2); `src/components/Menu/rows.tsx:210` `DescribedRow`
---

# A menu row's visible note becomes part of its name

A menuitem takes its accessible name from its content, so a note drawn under the label is read into the name: the Pull row becomes "Pull Fast-forward to origin/feat, 3 commits". A screen reader announces the whole thing as the row's name, and a test that finds the row by `{ name: "Pull" }` stops matching the moment the counts change. `aria-describedby` alone does not take it back out, because the name is computed from content regardless.

`DescribedRow` marks the note `aria-hidden` and points `aria-describedby` at it. The name is the label alone, and the note is still announced, as the description, since a node referenced by `aria-describedby` is read even when hidden. The older note rows (`NoteRow`, the `note` field of `MenuItem`) still put the note in the name. Their notes are static refusal reasons, which is why nothing has broken there.

## Related

- [[gotcha_jsdoms_accessible_name_joins_adjacent_nodes_with_no_separator]]: how that joined name reads under jsdom
- [[adr_headless_primitives]]: the Kobalte menu these rows sit in
