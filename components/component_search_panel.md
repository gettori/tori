---
summary: project search fans backends into one canonical regex and now fans a Feature's members into one merged result set
status: current
updated: 2026-08-27
source: "v0.1 features: status indicators, search, input layer (personal/sway, branch `topbar`); Phase 2; rewritten by Search panel v2 (branch `wave-1-2`), all four phases; PR #81; issue #11; widened over a Feature's members by Features phase 4 (#156), branch `feature-workspace`, phases 1 to 3, commits 92d697f, ec71908, 9c7ce7a"
---

# Search panel (project-wide grep and replace)

**Location:** `src-tauri/src/search.rs`, `src/panels/Editor/SearchPanel.tsx`, `src/utils/searchOptions.ts`, `src/utils/searchHistory.ts`, `src/utils/savedSearches.ts`, `src/utils/featureMembers.ts`, `src/panels/Editor/searchResultsDoc.ts`, `src/utils/debounce.ts`

The editor's sixth right-panel mode: project-wide text search with case / whole-word / regex / glob / ignored-files controls, an honest cap notice, and replace-in-files at three scopes. Three backends still form a fallback chain, but since v2 they no longer decide what a match is; they narrow candidates for one canonical regex, see [[concept_canonical_matcher]]. Since #156 a Feature searches every member at once, one section each, see [[concept_member_fan_out]].

## Responsibilities

- **`grep_project(root, query, options, max)`**: takes a `SearchOptions` struct (`case`, `regex`, `wholeWord`, `include`, `exclude`, `noIgnore`). Prefers `rg --json`, falls back to `git grep -n --untracked` inside a repo, then to a plain recursive `grep -rn` excluding the churn dirs `fs::list_project_files` uses. Exit code 1 ("no matches") is success. An invalid regex returns `Err` with the crate's own compile message.
- **Returns more than matches**: each `SearchMatch` carries `submatches` as UTF-16 offsets; the result carries `truncated`, the `backend` that ran, an `unsupported` list of options that backend cannot honour, and `files` (per-path size+mtime digests for the replace staleness guard). An **empty query still returns capabilities**, which is what lets the panel disable a toggle before the first search.
- **`preview_replace(query, options, replacement, spans)`**: pure, no file I/O. Expands `$1`/`${name}` through the canonical regex over line text already on screen; a span that no longer verifies comes back `null` rather than a guess.
- **`replace_in_files(root, query, options, replacement, targets)`**: the fail-closed write path, see [[concept_fail_closed_replace]].
- **`SearchPanel.tsx`**: a thin shell. Debounced query (200ms) and glob inputs; toggles re-search immediately, since a toggle is one deliberate act rather than a keystroke. Results grouped client-side by file, click emits `OPEN_IN_EDITOR`. Replace row renders the backend's preview (old span struck through beside the substitution) with Replace All / per-file / per-occurrence actions.
- **Refreshes on `fs://changed`** with its own longer debounce (400ms), only while mounted: `Editor.tsx`'s `<Switch>/<Match>` unmounts inactive right-panel modes, so the listener is gated by visibility with no extra bookkeeping.
- **Two props from `Editor.tsx`**: `dirty` (the absolute-keyed unsaved-buffer record) and `confirm` (Editor's local `askConfirm`, which cannot be imported, see the gotcha below).

## A result set you can edit, recall, and name (2026-08-05, wave 6)

Three things landed on top of the panel (issues #50 and #61, commits 48af914 and
98b038b):

- **The results are editable.** A result set can be materialised as one
  CodeMirror document, edited line by line and written back to the files it came
  from. That is its own concept, [[concept_editable_search_results]], including
  why its staleness guard is the source *line* rather than this panel's file
  digest, and why it uses `markSelfWrite` where `applyReplace` deliberately does
  not.
- **Query history**, `src/utils/searchHistory.ts`: per workspace, capped at 50,
  ordered by recency, walked with the arrow keys. An entry is a **(query,
  options) pair** and `applyRecall` replaces both, because handing back `needle`
  without the regex flag it ran under hands back a search nobody ran. **Enter**
  commits, not every keystroke, or the list fills with `n`, `ne`, `nee`; opening
  the editable buffer and running a replace commit too, since both spend a result
  set. One entry per query text, carrying the options it was last run with.
  Recall is debounced like typing, not immediate like a toggle, so holding Up
  does not fire a `grep_project` per step. The draft is captured on the first Up
  and restored by arrowing past the newest entry, options included, clamped at
  both ends rather than wrapped.
- **Saved searches**, `src/utils/savedSearches.ts`: named, uncapped, never
  reordered, gone only when deleted. Same payload as history and the opposite
  contract, which is [[concept_path_keyed_workspace_stores]]' split. Opening one
  opens the editable buffer and restores the panel underneath it, so the toggles
  on screen still describe what is being looked at; a search that now matches
  nothing opens no tab. **Enter is the only thing that renames** - committing on
  blur too would mean Escape, which unmounts the input and so blurs it, applied
  the rename it was pressed to call off.

`parseSearchOptions` moved into `searchOptions.ts` beside the type it validates
rather than into either store, because a validator living beside one of two
consumers is one the other drifts from. Both stores load and write through **in
the panel**, not in `Editor.tsx`: the right-hand `Switch`/`Match` tears this
panel down whenever another mode is picked, so re-reading storage on mount is
exactly what makes that survivable.

## Every member of a Feature, at once (2026-08-27, #156)

`grep_project` stays single-root. The panel takes `roots?: MemberRoot[]` beside `root` and fans out, which is [[concept_member_fan_out]]; a branch unit passes none and searches exactly as it always did, headerless, with its 52 pre-existing tests unmodified. What is specific to this panel:

- **A search-local member restriction.** A chip row above the query narrows the grep and nothing else. Multi-select, with All as a button rather than a chip you can deselect into nothing, and deliberately **not** wired to the Toolbar's active-member row: two chip rows on screen mean two different things, and narrowing a search must not also move which file the editor is showing. Excluded members lose their sections entirely, because a header over a zero count reads as "searched, nothing here" when it was never searched; an unusable member keeps its header, since that is the only place its state gets said.
- **The restriction persists with a recalled query and with a saved search**, as member **repo paths**. `SearchRecall.repos` and `SavedSearch.repos` are optional and absent when unrestricted, so every entry written before #156 round-trips byte for byte, and `parseSearchRepos` reads empty, non-array and non-string-element forms back as absent so nothing in storage can spell "restricted to no member at all". Read back through `resolveMemberRestriction` against the members present now, falling back to all. Two readings exist and are not the same value: `restricted()` is the raw pick, `restriction()` is it resolved, and everything rendered or grepped reads the resolved one.
- **Replace fans out per member with per-member digests**, so a file that moved under one member cannot fence off a write to another, and skips carry their member into the reason string (`skipReason`, `SearchPanel.tsx:615`). `replaceOutcome` groups skips by reason and reports counts, so a bare "1 skipped (unsaved changes)" over a Feature named neither the file you can see twice on screen nor the repo to go and save it in.
- **`preview_replace` stays one root-free call.** The spans are read back positionally, so `flatSpans()` and `previewBase()` iterate the drawn roots and agree with each other by construction; the row-to-preview map is keyed on match identity, not screen position.
- **Open hands the whole set to one buffer**, keyed on `wsKey`, with rows carrying their own member; see [[concept_editable_search_results]].

## Key files & entry points

- `src-tauri/src/search.rs:445` - `grep_project`; `:603` `preview_replace`; `:628` `replace_in_files`.
- `src-tauri/src/search.rs:126` - `canonical_pattern`, the one matcher every backend and both commands share.
- `src-tauri/src/search.rs:143` - `longest_literal`, the fallback `-F` pre-filter; bails to `None` on alternation, groups and classes.
- `src-tauri/src/search.rs:195` / `:540` - `submatches_utf16` and `utf16_to_byte`, the offset boundary in both directions.
- `src-tauri/src/search.rs:282` - `finalize`: globs, then verify, then cap, in that order.
- `src-tauri/src/search.rs:334` - `pick_backend`, split out so the plain path stays testable on a machine that has rg.
- `src/utils/searchOptions.ts` - every decision the panel makes, kept pure so vitest reaches it: `grepArgs`, `splitHighlights` (clamps, sorts and merges spans so a malformed one renders plainly rather than dropping text), `truncationNotice`, `countOccurrences`, `dirtyRelativePaths`, `replaceTargets`, `replaceOutcome`, `unsupportedReason`.
- `src/panels/Editor/SearchPanel.tsx:142` - `runSearch`, with a `"user" | "refresh"` source: only a user-caused failure clears results, so a transient watcher-refresh error cannot blank a good set.
- `src/panels/Editor/SearchPanel.tsx:178` - `probeCapabilities` (own latest-wins guard); `:224` `previewBase` memo; `:267` `applyReplace`.

## Testing

Both vitest projects and the Rust suite cover this component, which is worth knowing because an earlier pass wrongly recorded that only pure helpers were testable, see [[lesson_a_test_harness_you_did_not_look_for]].

- `src/utils/searchOptions.test.ts` (node project) - 52 tests over the pure helpers, including the fan-out merge (section order, the capability union, an errored leg leaving the others intact) and a two-member replace outcome.
- `src/panels/Editor/SearchPanel.test.tsx` (jsdom project) - 82 tests through the real component with `invoke` stubbed, covering toggles, capability-driven disabling, globs, errors, highlighting, all three replace scopes, the confirm gate, dirty-buffer exclusion, that `markSelfWrite` is never called, and two describes for a Feature: the multi-root fan-out and the member restriction.
- `src/utils/featureMembers.test.ts` - 7 tests, three of them on `resolveMemberRestriction` (a worktree that moved but held its repo, a member that left, and every member leaving).
- `src-tauri/src/search.rs` - 44 tests, including cross-backend match-set parity and the rename-not-truncate proof.

The 52 pre-existing single-root `SearchPanel` tests pass **unmodified** through all three of #156's phases. That, rather than any new test, is the evidence the branch-unit path is untouched.

One behaviour is deliberately **not** automated: that a replace into an open clean tab reloads that buffer. It crosses `SearchPanel` → watcher → `CodeEditor.handleExternalChange`, and its failure mode is a silent revert, so it is a manual pre-merge smoke.

## Connections

- Emits [[concept_fs_change_pipeline]]'s `OPEN_IN_EDITOR` event, same as [[component_cm6_editor]]'s file tree and review panel.
- Sits alongside [[component_cm6_editor]]'s other right-panel modes in `Editor.tsx`'s `rightMode` union.
- Cmd+Shift+F (`FOCUS_PROJECT_SEARCH`) switches to this mode and focuses its input, through [[component_command_palette]]'s shared `dispatchHotkey` so it fires while an xterm terminal has focus.
- A replace deliberately does **not** mark its writes, so [[component_cm6_editor]] reloads the affected clean buffers itself.

## Related

- [[component_member_chip]] - the shared chip its member section headers moved onto in #158; its member **toggle** stayed a `Tooltip as="button"` and still calls `memberInitials` directly

- [[concept_editable_search_results]] - the results-as-a-buffer write path and its two enforced invariants
- [[concept_member_fan_out]] - one call per Feature member, merged in TS, and the `(root, path)` identity rule
- [[lesson_a_reset_key_must_name_what_changed]] - the reset effect that fired on a chip click it did not mean
- [[gotcha_a_members_path_moves_only_repopath_survives_a_recreate]] - why the restriction persists as `repoPath`
- [[gotcha_a_raw_nul_in_a_source_file_type_checks_and_passes_every_test]] - the separator trap in `rootsKey`
- [[concept_path_keyed_workspace_stores]] - why history is capped and saved searches are not
- [[concept_canonical_matcher]] - why the backends narrow rather than decide
- [[concept_fail_closed_replace]] - the guard chain behind the write
- [[gotcha_autofocus_on_an_input_a_show_inserts_is_not_honoured]] - the rename input's focus trap
- [[lesson_prove_flag_parity_by_running_the_tools]] - how the backend divergences were found
- [[lesson_a_test_harness_you_did_not_look_for]] - why this page names its harnesses explicitly
- [[gotcha_a_replace_must_not_mark_its_own_writes_as_self_writes]] - the trap at the write/reload seam
- [[gotcha_askconfirm_is_local_to_editor_tsx_not_an_exported_utility]] - why `confirm` is a prop
- [[gotcha_rg_w_is_wider_than_b_pat_b]] - the divergence that drove the v2 rewrite
- [[gotcha_an_anchored_glob_needs_a_relative_search_root]] - the silent zero-result glob trap
- [[gotcha_git_grep_needs_no_exclude_standard_to_see_ignored_files]] - the ignored-files flag
- [[gotcha_rg_max_count_is_per_file_not_a_total]] - why it is not the result cap
- [[gotcha_match_offsets_cross_to_js_as_utf_16_not_bytes]] - the offset boundary
- [[gotcha_a_request_bound_to_a_fast_changing_selection_needs_a_latest_request_wins_guard]] - the pattern `searchGen` and `probeGen` both apply
