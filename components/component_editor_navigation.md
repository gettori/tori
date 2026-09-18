---
summary: jump list, breadcrumbs and sticky scroll answer where am I from the caret, and the trail starts with the file's member
status: current
updated: 2026-08-28
source: "Editor Wave 6: the IDE surface (personal/tori, branch `wave-6`); Phases 2, 7, 8, issues #49 / #54 / #55; commits ca93f99, c6177fa, 2185971; the member crumb from Repository identity on tabs, breadcrumbs, quick-open and menus (branch `feature-workspace`, issue #158), Phase 3, commit `12fe232`"
---

# Editor navigation surfaces: jump list, caret listeners, breadcrumbs, sticky scroll

**Location:** `src/utils/jumpList.ts`, `src/panels/Editor/cursorJump.ts`, `src/panels/Editor/breadcrumbTrail.ts`, `src/panels/Editor/Breadcrumbs.tsx`, `src/panels/Editor/stickyScroll.ts`

Four surfaces that all answer "where am I" from the caret or the viewport, and none of which is a file operation: navigation history with back/forward, the breadcrumb trail above the editor, and the sticky-scroll overlay inside it. They share `cursorJump.ts`, which holds two CodeMirror update listeners that want opposite things.

## Responsibilities

- **`jumpList.ts`** — a pure back/forward list per workspace: `record` (`:111`) with adjacent dedup and a cap, `mapPaths` (`:152`) for the tree sweep, and the `*In` variants over the per-workspace store. Session-lived, not persisted: #49 asks for per-workspace and no task's verify asks for durability.
- **Recording happens at one chokepoint.** Go-to-definition, a search hit and an omnibox pick all reach the editor through `OPEN_IN_EDITOR`, so "record at four places" is one recording site. `goJump` deliberately does **not** route through it, so the chokepoint never sees a Back.
- **An entry's line is optional, and `record` refines rather than appending.** A tree click records the file with no line (the tab may already be open five hundred lines down, so pinning it to line 1 is worse than nothing); the caret landing a moment later fills the line in. Left as two entries the first Back press looks broken.
- **`cursorJump.ts` holds two listeners.** `cursorJumpListener` throws drift away, because a jump list of every line is one nobody can walk back through. `caretListener` keeps it, because arrowing into the next function changes which symbol you are in. Same file because they read the same updates and would misread as one rule with an exception if they shared a body.
- **`breadcrumbTrail.ts`** — two separate chains concatenated for display: `pathCrumbs` (`:49`, lexical, always available) and `symbolTrail` (`:88`, empty with no language server), plus `siblingsAt` (`:110`) for the pickers. Modelling them as one list would render a blank strip for any project without a server.
- **`stickyScroll.ts`** — `stickyHeaders(state, pos, max)` (`:66`) resolves the innermost node at the top visible position and walks parents, keeping every ancestor whose own first line is above it. `MAX_STICKY = 5`, matching VS Code. Gated on a Phase 4 setting, default off.
- **Does NOT** ask a language server anything of its own: the bar reads `symbolsFor(path)` from the published store, as the outline panel and `@` mode do.

## Key files & entry points

- `src/utils/jumpList.ts:111` / `:152` / `:183` / `:199` — record, sweep, and their per-store forms.
- `src/panels/Editor/cursorJump.ts` — both listeners; `u.transactions.length` is the load-bearing guard (a tab switch arrives as a bare `setState` whose start state is the *previous* file's document).
- `src/panels/Editor/breadcrumbTrail.ts:27` / `:49` / `:88` / `:110`.
- `src/panels/Editor/stickyScroll.ts:66` `stickyHeaders`, `:158` the `requestMeasure` call, `:237` the extension factory.
- `src/panels/Editor/navHistory.test.tsx` — the cross-surface test: a crumb click, a sibling pick, and Back going live.

## Connections

- Publishes into [[component_editor_stores]] — `EditorSnapshot.recentJumps` is a required field, read by [[concept_omnibox_prefix_router]]'s "Recently visited" section.
- Joins [[concept_path_keyed_workspace_stores]] — the jump list is swept by [[component_project_file_tree]]'s rename and trash.
- Reads [[component_editor_symbols]] — the symbol half of the trail, and the `endLine`/`endColumn` fields that were added for it a wave early.
- Governed by [[concept_workspace_settings_overlay]] — sticky scroll is a registered `EditorDefaults` key and got the whole settings stack for one field.
- Built on `Menu` ([[component_context_menu]]) rather than a new surface, which brings portalling, viewport clamping, escape and outside-click dismissal.

## Design notes worth keeping

- **Sticky scroll dedupes the chain by line**, which is why it needs no per-language list of what counts as a scope. `export default function f() {` is three nested nodes starting at the same character; keying on the line collapses them into the one row a reader would draw, for every language pack at once.
- **The deepest scopes are dropped at the cap, not the outermost.** The outer ones say where in the file you are, which nothing else on screen does; the innermost is a few lines up and comes back as you scroll toward it.
- **Every breadcrumb is a picker, not a link.** Opening the file you are already looking at is the one thing a breadcrumb click can never usefully do.
- **The caret carries its path and the pane withholds it.** `caretHere()` hands the bar a caret only while the buffer it belongs to is on screen, and the gate excludes preview and image tabs too, since a Markdown preview keeps the path while taking the caret away with the source.
- **Ctrl chords match on `e.code`, not `e.key`**, because Shift rewrites a punctuation key (⇧- is `_`) and the forward half would never match.

## The trail starts at the member, inside a Feature

`pathCrumbs(root, path, member?)` takes an optional `CrumbMember { root, label }` and prepends a crumb for it. Two things about it are load-bearing:

- **The member is the one the file sits in, and it need not be the active one.** The bar used to resolve every path against the active root, so a file open in any *other* member found no shared prefix and collapsed to a single basename crumb. That was a bigger bug than the missing repo name #158 went in for.
- **The member only replaces the root when it really holds the path.** `pathCrumbs` guards on `path.startsWith(member.root + "/")` and falls back to `root` otherwise, so a mismatched member costs its own crumb rather than the whole trail.

The pane resolves the member and the bar draws it (`Breadcrumbs.tsx:66` takes a `member` prop), rather than `Breadcrumbs` calling `memberFor` itself: `Editor.tsx:806 tabMember` already owns both the Feature guard and the synthetic-id guard, and the bar is presentational everywhere else. The chip is matched on `crumb.path === member.key`, not on being first, so a trail that declined to prepend the member wears no chip instead of pinning one to whatever crumb happened to lead. This is the one place the trail names a root at all, and the reason is that a member root is the only root a Feature has more than one of. See [[concept_repository_identity]].

## Related

- [[gotcha_view_viewport_is_the_rendered_range_not_the_visible_one]] — the input that would have looked right in every small test.
- [[gotcha_reading_the_editor_layout_during_a_cm6_update_throws]] — and leaves an orphaned overlay behind when it does.
- [[gotcha_a_case_insensitive_filesystem_cannot_hold_foo_ts_beside_foo_tsx]] — why the module is `breadcrumbTrail.ts`.
- [[lesson_a_solid_effect_inherits_the_change_rate_of_what_it_reads]] — neighbouring reactivity discipline.
