---
summary: one member's band in a right panel list gets a header only when there is something to disambiguate, empty groups render
status: current
updated: 2026-08-28
source: "Features phase 8: the right panel modes inside a Feature (#160), branch `feature-workspace`, phase 1, commit 6aa93fb"
---

# Member section

**Location:** `src/components/MemberSection/MemberSection.tsx`, `.module.css`, `src/utils/featureMembers.ts` (`groupByMemberRoot`, `memberSectionsHeaded`, `OUTSIDE_MEMBERS_LABEL`)

One member's band in a right-panel list: its chip, its name, its state when it has one, an optional count, and whatever the panel draws for it. Problems, TODOs and Bookmarks each drew this header separately before ([[concept_right_panel_member_scope]]).

## Responsibilities

- **A header only when there is something to disambiguate.** `memberSectionsHeaded(roots)` is the one rule: more than one member, **or** a single member that cannot be opened. That second half matters, because a lone broken member's badge is the only account of why there is nothing below it. A branch unit passes no roots and reads exactly as it always did.
- **Collapsible, per section, uncontrolled.** The header is a `button` with `aria-expanded`; an unusable member gets a static header instead, since there is nothing to expand.
- **The grouping rule, shared.** `groupByMemberRoot(items, pathOf, roots)` returns one group per member in member order, plus a trailing group for anything under none of them. It uses `rootOf`'s longest-match, so a member nested inside another answers with itself and cannot disagree with the tree.
- **A row under no member is kept, not dropped.** The trailing group is headed "Outside this Feature". Removing a repository from a Feature keeps its worktree by default, so the marks that point into it are still about files on disk; sweeping them would destroy hand-made marks for a folder that is still there.
- **Empty groups survive.** A member with no rows still gets its group, which is what gives an unusable one somewhere to say why it is empty.

## Who uses it, and how their scoping differs

- **Bookmarks** is the only panel that can actually reach the trailing bucket. Its rows come from a store keyed on `feature:<id>`, so a row under no member genuinely belongs to this Feature. Each row's folder is relativised against **its own** member root, not against `activeRoot`.
- **Problems** pre-scopes to the member roots before grouping. The diagnostics store spans every warm project, so it cannot tell a Feature's departed member from another workspace entirely, and anything outside the roots is not this Feature's to show.
- **TODOs** greps per member, so a hit is always under the root it was found in. It keeps a section per root anyway, because a cap and a failure are both facts about the repo they happened in.

FileTree, SearchPanel and ReviewPanel keep their own headers: theirs carry per-section create, repair and commit actions this one has no place for. They become the fourth, fifth and sixth callers whenever one of them is next touched.

## Gotchas

- The sections are rebuilt from scratch on every data change, so Problems and Bookmarks iterate them with `<Index>`, not `<For>`. A referentially-keyed list remounts each section and reopens a member the reader had just collapsed. See [[gotcha_a_referentially_keyed_for_over_recomputed_groups_resets_its_children]].

## Related

- [[component_member_chip]] - the chip in the header.
- [[concept_right_panel_member_scope]] - which modes group this way and which do not.
- [[concept_member_fan_out]] - the pattern the list panels follow to fill these sections.
- [[component_problems_panel]] - the first of the three.
