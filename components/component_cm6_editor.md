---
summary: the CM6 pane keeps one EditorView per open file and now parks views instead of rebuilding them when a pane is re keyed
status: current
updated: 2026-08-20
source: "CM6 editor migration plan + Shared tab (personal/tori, branch code-mirror-6); commits 462b49e->bab6e0a (Phases 2 to 6), _shared-tab_; Session worklog: status dot, touched files, panels (branch `topbar`); Phase 3; Review-to-prompt + commit flow (branch `topbar`); ReviewPanel -> [[component_changes_panel]]; Editor wave-1 opener: multi-cursor, editing polish, language packs (branch `editor-improvements`); PR #80; Editor wave 7: language intelligence depth (branch `wave-7`); issues #63-#68; commits c4750d7 -> d7a6e3e; The reveal path: verify the mismatch switch, then decide what it costs (branch `unified-tab-bar`), Phases 2 and 3, commits be27425, dab0114"
---

# CM6 editor pane

**Location:** `src/panels/Editor/` (`CodeEditor.tsx`, `Editor.tsx`, `FileTree/FileTree.tsx`, `ReviewPanel.tsx`, `SessionPanel.tsx`, `TranscriptViewer.tsx`), `src/diffGutter.ts`, `src/theme.ts` + `src-tauri/src/theme.rs`, `src-tauri/src/fs.rs`

The same-origin CodeMirror 6 editor that replaced the code-server iframe. It is a multi-file editor (file tree, tabs, save, git gutter, inline-diff review, quick-open) living in the same SolidJS document as the terminal, which is what makes cross-pane glue ([[component_pty_host]] clickable paths, drag-to-`@path`) possible. Governed by [[adr_cm6_editor]].

## Tabs became per-workspace (2026-08-02)

Editor tabs are keyed by branch-unit folder rather than held in one flat global
list, and come back across a relaunch. The mechanism is
[[concept_editor_tab_workspaces]]; two things about *this* component follow from
it and are easy to break:

- **`CodeEditor` mounts on the union of every workspace's open paths**, and hides
  on the visible strip via its `hidden` prop. Gating the mount on the visible
  strip destroys every buffer behind it - see
  [[lesson_a_mount_gate_is_a_destroy_gate]].
- **"Mounted but hidden" is a real state now**, so `CodeEditor` re-measures on the
  hidden -> visible transition. Geometry measured under `display:none` is stale,
  the same reason `REFIT_PANES` exists.

`Editor.tsx` also became the app's always-mounted host for things that outlive
the right panel: it drives the git store's root-change refresh and
`startGitWatch` ([[component_editor_stores]]), publishes `editorState`, and hosts
the editor and git commands of [[concept_command_registry]] - including the only
prompt host for command-initiated text input, since it already owns `askText`.

## Language intelligence landed (2026-08-03, wave 4)

Eight phases turned this from a pane that *shows* code with one hard-coded TS server into one that understands it. The editor-side surface, in order of where it lives:

- **Cross-file navigation and rename.** Go-to-definition, find-references (the library's own panel) and rename all leave the file they started in, through [[concept_lsp_workspace_bridge]]. The rename is Tori's own command, takes a working-tree backstop before the first write, dispatches into the shown buffer while *writing* every other file, and asks before saving a dirty background tab rather than clobbering it.
- **Outline tab + palette symbol modes.** A fifth `RightMode`, self-hiding when the server offers no provider, plus `@` (this file) and `#` (every live session) in quick-open. All three read one store — [[component_editor_symbols]].
- **Format-on-save.** The project's own Biome or Prettier, off by default, applied as a minimal change so the caret does not move — [[component_project_formatter]]. `lsp-format` (⇧⌥F) falls back to the language server where a project has no formatter.
- **Semantic highlighting.** Server-resolved token colours layered over the grammar's guess; the `t.local(t.variableName)` parameter proxy in `toriHighlight` is gone with it — [[concept_semantic_token_layering]].
- **Vim mode**, off by default, in a compartment so toggling lands where the caret already is. `vimConf.of([])` sits **first** in `commonExtensions`, which is load-bearing: for a key vim and a keymap both claim, whichever is earlier takes it ([[gotcha_a_keymap_extension_that_stoppropagations_kills_window_scope_hotkeys]]). Filled by `syncVim` on every swap, the same arrangement `blameConf` uses.
- **Four LSP commands in `commands.ts`** at `window` scope, so they reach the palette and the ⌘/ sheet with Mac-reachable combos beside the library's function-row defaults — plus a Cmd-click go-to-definition the library has no equivalent of.

## The IDE surface landed (2026-08-05, wave 6)

Fifteen phases (issues #48 to #62, branch `wave-6`) turned the pane from an
editor with a file list into the surface an IDE is expected to have. Each has its
own page; this is the map:

- **The file tree became editable** - create, rename, trash (never a hard `rm`),
  drag-move, multi-select, reveal, fuzzy filter, compact folders. It is also the
  origin of the rename and purge sweeps every path-keyed store must follow.
  [[component_project_file_tree]]
- **Navigation history, breadcrumbs and sticky scroll** - three surfaces derived
  from the caret and the viewport, sharing one module of CodeMirror update
  listeners. [[component_editor_navigation]]
- **Quick-open and the command palette merged into one omnibox** whose mode is a
  prefix on the query. Both old components are deleted.
  [[concept_omnibox_prefix_router]]
- **Per-workspace settings** - `editorDefaults` now resolves default < user <
  workspace, with a searchable panel and a `Preferences:` command per setting.
  Every later feature registers one field and gets the whole stack.
  [[concept_workspace_settings_overlay]]
- **Search results became an editable buffer**, with query history and named
  saved searches beside it. [[concept_editable_search_results]],
  [[component_search_panel]]
- **Local history** - every save recorded as a git blob, restorable without
  touching the index. [[concept_local_history_blobs]]
- **A task runner** over the project's own npm scripts, make targets and just
  recipes, run in a login-shell tab. [[component_task_runner]]
- **Bookmarks, scratch buffers, a TODO/FIXME explorer and recents/frecency**,
  which are covered where their mechanisms live:
  [[concept_path_keyed_workspace_stores]] and
  [[concept_editor_tab_workspaces]].

Two new right-panel modes (`todos`, `tasks`) and two new synthetic tab kinds
(`tori://search`, `tori://localhistory`) came with them.

## Language intelligence got deep (2026-08-08, wave 7)

Wave 4 brought up the servers and the surfaces that only *read* from them. Wave 7
(issues #63 to #68, branch `wave-7`) added the ones that **change files** or
**answer a question the server asks back**, which needed two foundations the pane
did not have: a general `WorkspaceEdit` applier and a router for server-initiated
requests. The map:

- **Foundations, in no ticket.** `workspaceEdit.ts` applies any edit through a
  three-hook policy; `serverRequests.ts` answers on the transport seam, because
  the library `-32601`s everything a server asks. `serverEdits.ts` and
  `batchWrite.ts` sit on top. [[concept_workspace_edit_policy]] ·
  [[concept_server_request_router]]
- **Code actions (#64)** - quick fixes on `⌥⏎` and a gutter bulb, source actions
  as palette commands, organize-imports inside the save path, and the fix titles
  the Problems panel sends to an agent. [[component_code_actions]]
- **Auto-import (#64)** - the library's completion source replaced rather than
  wrapped, because `apply` is built at map time and is synchronous. This is why
  the client's extension list is written out by hand.
  [[concept_resolving_completion]]
- **Schema-validated JSON and YAML (#65)** - two more bundled servers, the
  SchemaStore catalog, and two schemas for Tori's own settings files.
  [[concept_schema_backed_json]]
- **Peek (#66)** - a block widget hosting a read-only nested view, opening no tab
  and unknown to the language workspace. [[component_peek_view]]
- **Call hierarchy (#67)** - a Calls right-panel mode expanding one level per
  round trip. [[component_call_hierarchy]]
- **Code lens (#68)** - counts above the line, behind a setting that defaults to
  off, and the first key to go through all four settings homes.
  [[component_code_lens]]

Two pane-level mechanics are worth knowing before touching any of them. The
**eager/lazy boundary rule keeps applying**: `Editor.tsx` decides which
right-panel tabs exist, so any store it reads must stay CodeMirror-free, which is
what forces the `utils/x.ts` + `panels/Editor/lspX.ts` split
([[component_editor_symbols]]). And **a per-buffer compartment is the only way a
setting reaches a background tab**: `prefsConf` reaches the buffer in the view
only, so code lens uses `reconfigureBuffers` (`state.update` for buffers in no
view) instead.

## A view is moved between panes now, not rebuilt (2026-08-20)

A pane's id is not stable under the editor. A split re-keys it (`editorStageId`
is per pane, so the host goes `editor-stage:main` to `editor-stage:pane-1`) and
a worktree switch re-keys it again, because `editorPaneIds()` resolves per
workspace. Both showed up in a trace as `cm:detach` + `cm:destroyed` +
`cm:attach`, twice per mismatch switch: the `<For>` over pane ids disposed one
row and created another, and the `EditorView` went with it.

`attachView` now takes a **parked** view first. `detachView` pushes the record
onto a `parked` list instead of destroying it and schedules a sweep on the next
task; the pane arriving in the same flush pops it, moves `view.dom` into its new
mount, re-keys the record and re-resolves its authority role. Anything nobody
claims by the end of that task is destroyed, and the component's own teardown
destroys the pool. Order-tolerant by construction: if a create ever ran before
the dispose, the pool is empty and it degrades to a rebuild.

The scroll position rides along on **CodeMirror's own snapshot**. `Buffer` grew a
`scrollSnap`, recorded from the scroll handler while the view is on screen,
stashed beside the state when the view is left, and dispatched **instead of** the
caret `scrollIntoView` when it comes back. Do not reach for `scrollTop` here; see
[[lesson_a_pixel_is_not_a_position]] for the four mechanisms that failed first.

`REFIT_PANES` also loops every pane's view rather than the focused one, because a
split builds a view in the pane that did not take focus and a view that never
measures keeps CodeMirror's placeholder height
([[gotcha_refit_panes_re_measured_only_the_focused_view_so_a_split_left_one_unmeasured]]).

**It bought correctness, not speed.** The mismatch switch did not get faster:
that cost is the frame in which panes reparent their surfaces, not the rebuild.
See [[concept_switch_cost_anatomy]]. `paneRekey.test.tsx` is the regression
guard, asserting the view is the **same object** after a re-key rather than an
equal one.

## Responsibilities

- **`Editor`** (renamed from `EditorPane`) owns the open-editors model: a `Tab` discriminated union (`FileTab | TranscriptTab`, keyed by `tabId()`, see [[component_session_worklog]]) rather than a plain file array, `activeId`, the per-file `dirty` map, the Files/Changes/**Session**/**Shared**/Docs right panel (a `<Switch>` over `rightMode`), and the Follow toggle. Listens for `OPEN_IN_EDITOR` and `OPEN_TRANSCRIPT` and routes opens. Starts the fs watcher and the LSP for the project.
- **The transcript virtual tab was removed 2026-07-31** (branch `navigation`, phase 7). An editor tab is now just a path: `FileTab` lost its `kind` discriminant, `tabId(t)` is `t.path`, and about twenty `t.kind === "file"` narrowings that only ever guarded against a transcript went with it. `.editorMain` also lost the `position: relative` that existed solely for the viewer's overlay. The Session right-panel mode stays. Read the next bullet as history.
- **Session mode + transcript viewer**: a fourth right-panel mode (`SessionPanel.tsx`), shown only when a session is selected, joins [[component_session_worklog]]'s touched-files extraction with `git_diff_text` for an inline diff and click-to-open. A session's transcript opens as a **virtual center-pane tab** (`` transcript:<id> ``, `TranscriptViewer.tsx`) in the same `OverflowTabBar` as file tabs; `CodeEditor` stays mounted underneath at all times (a CSS overlay, not a conditional unmount) so its per-buffer undo history survives switching to and from a transcript.
- **Shared tab**: a third right-panel mode shown **only for worktree units** (`selected.projectKind === "worktree"`, rooted at `<container>/.shared`; a non-worktree selection falls back to Files). It renders `FileTree` in **editable** mode over the `.shared` folder ([[component_worktree_lifecycle]]). `EditorPane` reuses the sidebar's `PromptModal`/`askText` pattern for name entry (WKWebView has no `window.prompt`).
- **`CodeEditor`** holds the CM6 truth: **one `EditorView`, one `EditorState` per open file** in a `Map`, so cursor/selection/undo are preserved per tab. Switching tabs stashes the outgoing state and `setState`s the incoming one (a `swapToken` guards against a stale async file read winning). `⌘S` saves via `fs_write_file`; an `updateListener` derives dirty from `doc !== savedText`.
- **Editing behaviors** (wave-1 opener, 2026-08-01): `EditorState.allowMultipleSelections` + `rectangularSelection()` + `crosshairCursor()` make the searchKeymap's Mod-d / Mod-Shift-l real (they silently no-oped before); CM's default mouse modifiers are kept, so Cmd-click adds a cursor and Alt-drag rectangles never collide. `closeBrackets()` + `closeBracketsKeymap` (spread **ahead of** `defaultKeymap` so pair-aware Backspace wins) and `highlightSpecialChars()`. Comment toggle is `defaultKeymap`'s own Mod-/ (it was always bound); the shortcut-sheet collision it exposed is [[gotcha_an_app_global_hotkey_must_yield_to_a_defaultprevented_key]].
- **Language packs load lazily**: `langForPath` is async. ts/js/json stay statically imported; md/css/html/rust/python/yaml (official packs) and toml/shell (`StreamLanguage` over `@codemirror/legacy-modes`) arrive via dynamic `import()` awaited beside the file read, inside `swapTo`'s `swapToken` guard, before `makeState` (no Compartment hot-swap: with one view and swapped states a late reconfigure can target the wrong buffer). The suffix comes from the basename, with aliases (yml, htm, markdown, bash, zsh) and dotfiles (`.zshrc`) resolving; each pack is its own vite chunk, and the editor chunk stayed flat (+1.8 kB measured against a baseline build).
- **`FileTree`** — lazy right-side tree via `fs_read_dir`, ignoring `.git`/`node_modules`; a file click emits `OPEN_IN_EDITOR`. Rows are draggable. **Editable mode** (opt-in `editable` + `askText` props, so Files/Docs stay read-only): a sticky header (New File/New Folder) and a per-node [[component_context_menu]] (New File/Folder in dirs, Rename, Delete) that mutate through the **containment-scoped** backend commands `fs_mkdir`/`fs_delete`/`fs_rename` in `fs.rs`, all bounded to the tree root; New File/Folder `mkdir -p` the root so the first add auto-creates `.shared`. After a mutation the affected node re-reads its own children in place (no whole-tree remount). Editing a shared file uses the ordinary CM6 open/save path.
- **Containment-scoped fs mutations** (`fs.rs`): `fs_mkdir`/`fs_delete`/`fs_rename` each resolve the target and **refuse anything outside the passed `root`** (fail-closed via `ensure_inside`; `fs_rename` also refuses to overwrite an existing destination). This is the only write surface for the editable tree, so a recursive delete can never escape `.shared`. See [[gotcha_containment_checking_a_not_yet_created_path]].
- **`ReviewPanel`** — the "Changes" mode; grew into a full VS Code-style stage/commit/push/PR surface with word-level highlights, side-by-side, and per-hunk staging, see [[component_changes_panel]].
- **Diagnostics** — `lintGutter()` paints severity markers beside the line numbers, and an `updateListener` watching for `setDiagnosticsEffect` mirrors each buffer's lint state into the Problems store (`src/utils/diagnostics.ts`). Publishing is buffer-scoped, so closing a tab drops its entries; see [[component_problems_panel]]. Inline underlines and hover tooltips come free with the LSP client ([[component_lsp_host]]).
- **`diffGutter`** — a `StateField<RangeSet<GutterMarker>>` painted from `git_diff_file` hunks, refreshed on save and external `fs://changed`.
- **Theme** — `theme.rs` distills the active VS Code theme's `tokenColors` into `--syn-*` CSS vars (with Dark+ fallbacks); CM6's `HighlightStyle` reads them via `var()`, so re-theming is automatic.

Does NOT: provide a debugger, an extension marketplace, or remote development (the last two are permanently out, see [[adr_cm6_editor]]). Multi-language LSP is no longer a gap: a language is a config file ([[component_lsp_host]]).

## Key files & entry points

- `src/panels/Editor/CodeEditor.tsx` — `buffers` map, `swapTo`, `saveActive`, `refreshDiff`, `handleExternalChange`/conflict banner, `applyGoto`, `lspPluginFor` per buffer.
- `src/panels/Editor/Editor.tsx` — the `Tab` union + `tabId`, tab bar, `gotoTarget`, watcher startup, the Outline/Problems self-hiding right-panel modes, app-close dirty guard. It only *stops* servers on a project switch now; `CodeEditor.swapTo` starts one lazily.
- `src/panels/Editor/{toriWorkspace,lspRename,lspRenameCommand,lspSymbols,lspSemanticTokens,semanticHighlight,formatOnSave,docDiff,vimMode}.ts` — the wave-4 modules, each split out of `CodeEditor` so its decisions are testable without CodeMirror in jsdom.
- `src/panels/Editor/SessionPanel.tsx`, `src/panels/Editor/TranscriptViewer.tsx` — see [[component_session_worklog]].
- `src/diffGutter.ts` — gutter extension + `setDiffMarkers`.
- `src/components/QuickOpen.tsx` — ⌘P fuzzy finder over `list_project_files`.

## Connections

- Drives [[component_pty_host]] cross-pane features (open-on-click, drag-to-`@path`) via the shared `OPEN_IN_EDITOR` / `DRAG_PATH_MIME` contract in `src/events.ts`.
- Uses [[component_lsp_host]] — per-buffer `lspPluginFor` attaches the language client for whichever session answers for the file.
- Adapts it to a single-view editor through [[concept_lsp_workspace_bridge]], and consumes [[component_editor_symbols]], [[component_project_formatter]] and [[concept_semantic_token_layering]].
- Implements [[concept_fs_change_pipeline]] — gutter refresh, auto-reload, follow-mode, review-list refresh all consume `fs://changed`.
- Editor tabs (`Editor.tsx`) are rendered by the shared [[component_overflow_tab_bar]]; identity-preserving reorder keeps `CodeEditor` buffers/cursors intact.
- Hosts [[component_session_worklog]]'s Session panel. (Its transcript viewer was removed 2026-07-31.)
- Hosts [[component_changes_panel]] as the Changes right-panel mode, and [[component_problems_panel]] as the Problems mode (which only appears when a diagnostic exists).
- The file tree, editor tabs, and quick-open render file-type icons via [[component_seti_icons]] (files only; folders keep a chevron).
- Governed by [[adr_cm6_editor]].

## Related

- [[gotcha_save_triggers_its_own_fs_watcher_echo]] — why saves must be echo-suppressed.
- [[gotcha_vs_code_theme_colors_cannot_color_syntax_historical]] — why `tokenColors` extraction exists.
- [[gotcha_containment_checking_a_not_yet_created_path]] — how the editable tree's fs commands stay fail-closed inside `.shared`.
- [[lesson_a_pixel_is_not_a_position]] - why the scroll restore goes through CodeMirror rather than `scrollTop`.
- [[concept_switch_cost_anatomy]] - what a loaded view actually costs a worktree switch, and what it does not.
- [[gotcha_an_app_global_hotkey_must_yield_to_a_defaultprevented_key]] - why editor keys and window hotkeys no longer double-fire.
- [[lesson_grep_the_installed_dep_before_wiring_a_binding]] - the false premise behind the wave-1 comment-toggle ticket.
