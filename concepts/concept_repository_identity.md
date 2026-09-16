---
summary: inside a Feature every surface naming a file also names its repo, resolved so a broken worktree still labels its file
status: current
updated: 2026-08-28
source: "Repository identity on tabs, breadcrumbs, quick-open and menus (personal/sway, branch `feature-workspace`, issue #158, design epic #151, phases 1 to 5) - commits `a7e2797`, `b1ac5f2`, `6183eae`, `12fe232`, `809c85b`, `c422394` - `src/utils/featureMembers.ts:113`"
---

# Repository identity: every surface that names a file names its repo

Inside a [[concept_feature_workspace]] one tab strip, one crumb bar, one quick-open box and one tree hold files from up to eight repositories, and a basename identifies nothing: two members hold the same `package.json`, the same `src/index.ts`, the same `README.md`. So every surface that names a file also names its repo, **always**, not only when a basename happens to collide. VS Code's collision-only suffix was rejected in #151 for the reason that makes it cheap: a strip whose shape changes as basenames collide and un-collide is unreadable with eight repos, and the shape is what the eye tracks.

## How it works

One resolver, one chip, five surfaces.

**`memberFor(path, members)`** (`featureMembers.ts:113`) is the resolver: longest matching worktree wins, built on `rootOf` so a member nested inside another answers with itself and the two can never disagree. It matches over **every** member, present or broken, which is the whole reason it exists rather than a `rootOf(path, sel.roots)` call at each site (see below). `null` for a path under no member, which is how a Docs or `sway://` path stays unlabelled.

**[[component_member_chip]]** is the visual token, and `TabMemberChip` its decorative preset.

| Surface | Says it by | Anchor |
|---|---|---|
| File and terminal tab | a chip composed **before** the existing glyph, plus a hidden `srOnly` span making the name `<repo> / <basename>` | `Editor.tsx:2334,2347`, `Terminal.tsx:1741,2060` |
| `+N` overflow row | the spelled-out `<repo> / <rel path>`, since that menu is where two members' same-named files sit next to each other | `Editor.tsx:2388`, `Terminal.tsx:2049` |
| Breadcrumbs | a leading member crumb wearing the chip; the trail is resolved against the member holding the file, not the active one | `breadcrumbTrail.ts:57`, `Breadcrumbs.tsx:66` |
| Toolbar crumb | `Feature / member / branch`, the crumb reading as a location while the chip row stays the switcher | `Toolbar.tsx:37` |
| Quick-open row | label `<repo>/<rel>` and id `file:<root>:<rel>`, so two `package.json`s are two rows | `Omnibox.tsx:310,330` |
| Tree row menu | a `role="group"` heading naming the member, ahead of the actions | `FileTree.tsx:467`, `Menu/rows.tsx:17` |

**The tab's name comes from a hidden span, never `aria-label`.** [[component_tab]] refuses `aria-label` on purpose: it *replaces* visible text and would break `getByRole("tab", { name })` in 34 places. The `srOnly` recipe is `clip-path` based, so hidden text does contribute to the accessible name, which is exactly what a decorative chip beside it cannot do.

**The chip composes before the icon, it does not replace it.** `TabDescriptor.icon` is a single glyph slot already holding `FileIcon` or `TabMark`; filling it with a chip would cost the file-type glyph. Composed, the tab says which repo *and* which kind of file.

**Only three things carry the gate.** A surface shows identity when its selection is a Feature. Two of the five derive that without a flag: `FileTree` synthesises a lone root as `{ label: "" }`, so an empty label already means "not inside a Feature"; the Omnibox asks whether `props.selected.kind === "feature"`. The editor's `tabMember` also excludes synthetic (`sway://`) ids, which belong to no repo.

## Why it's this way

- **A path outlives its worktree, and that is when naming it matters most.** `Selection.roots` holds only *present* members, so anything labelled through it falls back to a bare absolute path exactly when a repo is broken, while the same file's tab still reads `web / b.txt`. `memberFor` reads the record instead. This was designed in, then violated once in the Omnibox and caught by self-review; see [[lesson_labelling_through_present_roots_drops_the_broken_member]].
- **The crumb trail names the member because it is the one root a Feature has more than one of.** Everywhere else the trail deliberately does not name its root; the member crumb is the exception, and it is prepended only when the member really holds the path, so a mismatch costs its own crumb rather than collapsing the whole trail to a basename.
- **Quick-open scores the labelled string, not the rel path.** `fuzzyScore(q, "web/src/app.ts")` means typing the repo name narrows the list the same way typing a folder name does, with no separate repo filter to learn.
- **One cap per root untyped, one cap globally once scored.** A single shared `MAX_RESULTS` over an untyped list of eight members silently drops the last members entirely, and a member with no rows reads as a member with no files. Once a query has scored the list the scores are comparable across members, so the best 200 really are the best 200 and there is nothing left to protect.
- **The row menu's heading is a group label, not a styled row.** A plain div inside `role="menu"` would be seen and not heard. Kobalte's `GroupLabel` is `aria-hidden` with an id and its `Group` is `aria-labelledby` that id, so the name is announced once, as the group's name, before the first row, and the arrows and typeahead pass over it.

## Related

- [[concept_feature_workspace]] - the cross-repo context this exists inside, and the consumer table it completes
- [[component_member_chip]] - the chip, its `decorative` prop and the shared sr-only recipe
- [[component_tab]] - why the accessible name comes from a hidden span
- [[component_command_palette]] - the Omnibox half, per-root listing and the two caps
- [[component_editor_navigation]] - the crumb trail that grew a member head
- [[component_project_file_tree]] - the row menu that grew a heading
- [[component_menu]] - the `{ heading }` variant the menu half rests on
- [[lesson_labelling_through_present_roots_drops_the_broken_member]] - the shortcut that drops the label exactly when it is needed
- [[gotcha_feature_members_are_read_once_per_generation_module_wide]] - why a test cannot swap the `list_features` payload between cases
- [[gotcha_a_frecency_row_renders_before_list_features_answers]] - why a member-derived label needs a `waitFor`
