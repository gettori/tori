---
summary: the one chip showing a file's repo by initials on its Space tint, decorative unless a broken member's badge needs it
status: current
updated: 2026-08-28
source: "Repository identity on tabs, breadcrumbs, quick-open and menus (personal/sway, branch `feature-workspace`, issue #158) - phase 1 - commits `a7e2797`, `b1ac5f2`; worn by phases 2 and 3, commits `6183eae`, `12fe232`"
---

# MemberChip

**Location:** `src/components/MemberChip/` (key files: `MemberChip.tsx`, `MemberChip.module.css`, `MemberChip.stories.tsx`, `MemberChip.test.tsx`), `src/styles/patterns.module.css`

The one box that says which repo something belongs to: a member's initials on its Space tint. Before it, `memberInitials` was hand-inlined at seven sites with five copies of the chip CSS, and #158 was about to add five more. It is the visual half of [[concept_repository_identity]]; the resolver half is `memberFor`.

## Responsibilities

- Owns the chip: initials from `memberInitials`, the Space hue as `--chip-hue`/`--chip-rgb`, a flat `.neutral` fill for a repo in no Space, two sizes, and the `title` that names the member on hover.
- Owns whether the chip is spoken, through `decorative`, and the slot a state badge sits in so that badge stays announced.
- Does **not** resolve which member a path belongs to. That is `memberFor` in `featureMembers.ts:113`.
- Does **not** decide when a chip appears. Every call site gates on its own selection being a Feature.
- Does **not** cover the two `aria-pressed` toggle buttons whose content happens to be initials.

## Decorative by request, not by default

`aria-hidden` covers a subtree, so one component cannot be unconditionally silent and also hold an announced badge. Two real cases forced the prop:

- A **tab** already carries its repo in the accessible name through a hidden `patterns.srOnly` span, so a spoken chip would say it twice. `TabMemberChip` is the preset: decorative, plus `data-chip={repoPath}` and `data-state` so a member whose worktree is gone is dimmed by CSS and still identifiable in a test.
- The **sidebar's** `FeatureItem` chip holds the only spoken account of a broken member, as a `role="img"` badge inside the box. `FeatureItem.test.tsx:73` and `FeatureList.test.tsx:194` both assert that name, and both fail against an unconditionally hidden chip. That was predicted by an adversarial pass on the plan and confirmed by the tests on the first run.

## Five sites, not seven

The audit that motivated the extraction counted seven `memberInitials` call sites. Only five were chips. `SearchPanel.tsx:870` and `Toolbar.tsx:109` are `Tooltip as="button"` toggles with `aria-pressed`, a border and hover/pressed fills, whose *content* happens to be initials; wrapping them would nest a chip inside a chip and lose the pressed styling. They still call `memberInitials`, which is the thing they genuinely share. Treat "renders initials" as weaker evidence than "is a chip".

## The sr-only recipe moved with it

Five modules carried the `clip-path: inset(50%)` visually-hidden recipe verbatim (Settings, Chat, ReviewPanel, CheckpointTimeline, SearchPanel; the plan undercounted at four). All five now `composes:` from `.srOnly` in `src/styles/patterns.module.css:62`. `composes` works from inside `@layer components`, where Settings' copy was nested, verified by a real `vite build`: the bundle carries exactly one `.srOnly` rule with declarations plus six hashed class names. `display: none` is not an option here, since the whole point is text that contributes to an accessible name.

## Key files & entry points

- `src/components/MemberChip/MemberChip.tsx:37` - the chip. `ChipMember` is the minimum it needs (`displayName`, `repoPath`), so a caller holding a `MemberRoot` passes `tint` and one holding a `TintedMember` passes `chipStyle`.
- `src/components/MemberChip/MemberChip.tsx:76` - `TabMemberChip`, the decorative preset worn by file tabs, terminal tabs, both `+N` overflow rows and the member crumb.
- `src/styles/patterns.module.css:62` - `.srOnly`, the one visually-hidden recipe.
- `src/test/interactiveTitle.test.ts` - the raw-element census that dropped from 50 spans to 49 when the sidebar chip's `title` became a component prop.

## Connections

- Implements the visual half of [[concept_repository_identity]].
- Reads `TintedMember` from [[component_feature_selection]]'s `featureMembers.ts`, which is also where `memberFor` lives.
- Worn by [[component_tab]] and [[component_overflow_tab_bar]] (file and terminal tabs, `+N` rows), [[component_editor_navigation]] (the member crumb), [[component_project_file_tree]] and [[component_search_panel]] and [[component_changes_panel]] (section headers), and [[component_feature_list]] (the sidebar rows, the one announced case).
- Governed by [[adr_premium_design_system]] for the tint and density.

## Related

- [[concept_feature_workspace]] - the cross-repo context every chip exists to disambiguate
- [[lesson_labelling_through_present_roots_drops_the_broken_member]] - why the chip resolves through the member record and not through `Selection.roots`
- [[gotcha_an_aria_hidden_node_still_shows_up_in_textcontent]] - what a decorative chip does to a text assertion
- [[gotcha_jsdoms_accessible_name_joins_adjacent_nodes_with_no_separator]] - why the `<repo> / <file>` name assertions are tolerant regexes
