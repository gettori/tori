---
summary: editor-side stores hold one git status slot per Feature member, and a root leaving the set blanks its slot immediately
status: current
updated: 2026-08-27
source: "Editor wave 1: close out the fundamentals (personal/tori, branch `wave-1-4`); Phase 3, issue #15; commit bd9567c, git store rebuilt as one slot per member by Features phase 5: unified changes and the git slot map (#157, branch `feature-workspace`), commits 9658cff, 9687380"
---

# Editor-side module stores (git status, editor state)

**Location:** `src/utils/gitActions.ts`, `src/utils/editorState.ts`, `src/utils/diagnostics.ts`, `src/utils/symbols.ts`

Two module-level stores that outlive any component, the same shape of thing as [[component_session_stores]] and for the same reason: a consumer needs an answer from a component that is not on screen. The command palette has to know whether there is anything staged before it offers "Commit", and whether a file is open before it offers "Save file" — and it is a *sibling* of both the Changes panel and the editor, not a child of either.

## The lazy boundary decides where a store lives (2026-08-03, wave 4)

`src/utils/symbols.ts` joined this family, and the rule it followed is worth stating once because every later language feature will meet it.

`Editor.tsx` sits on the **eager** side of the lazy `CodeEditor` import. A module it imports at module scope may not touch CodeMirror at runtime, or the editor's ~1.3 MB dependency graph re-enters the startup chunk and the lazy boundary is undone. `diagnostics.ts` opens with that rule; `symbols.ts` is the second instance.

So a language feature whose *support* the always-mounted shell has to read gets **split in two**: the types, normalising and store in `utils/` (CodeMirror-free), the asking in `panels/Editor/`. That is not a taste call, and it forces the rest of the design — the editor becomes the sole publisher and every sibling surface a reader, because the outline panel and the command palette are siblings of the editor and neither can hold a language client. See [[component_editor_symbols]].

The escape hatch for a query that cannot be cached is a **registered accessor**: a module-level slot the editor fills on mount and clears on cleanup, with a stale-unregister guard so a remount that beats the old cleanup is not silently disconnected. `liveBuffers.setBufferAccess` is the pattern; `setWorkspaceSymbolSearch` and `setSemanticRefreshListener` follow it.

## Responsibilities

- **`gitActions.ts` owns the actions and the status they act on.** One module rather than two, because every action invalidates the store and splitting them leaves each caller to remember the refresh — which is exactly the bug the Changes panel had, where staging from anywhere else left its list stale. Exports `stage` / `unstage` / `commit` / `push` (each toasting on failure and refreshing on the way out) alongside the readers below.
- **It holds one slot per root, not one per window** (2026-08-27, #157). A `Map<root, GitState>` behind one signal: `gitStateFor(root)` reads a slot, `gitState()` is the active member's, `stagedFiles(root?)` / `changedFiles(root?)` / `conflictedFiles(root?)` / `canPush(root?)` mean the member in front when the argument is omitted, and the union has its own names, `stagedAcross()` / `changedAcross()` / `conflictedAcross()`, returning rows tagged with their member. `pushing()` became `pushingIn(root)`. The full mechanism, and why a union under the old accessor names would have compiled clean and been wrong, is [[concept_per_member_git_slots]].
- **Membership and content have separate writers.** `enterRoots(roots, active)` is the only thing that opens or closes a slot; every refresh only fills one, and resolves without invoking anything for a root nobody entered. `enterRoot` used to be called from inside `refreshStatus`, which made a refresh a declaration of what the store was about. See [[gotcha_a_git_refresh_fills_a_slot_but_never_opens_one]] for what that costs a fixture.
- **A root leaving the set blanks it synchronously**, inside `enterRoots`, before any read for the new set can land. Otherwise the palette would offer "Commit" on the strength of a workspace nobody is in during the window.
- **An in-flight read whose root left is dropped on arrival.** The guard is a per-root generation counter rather than one `currentRoot`, so several members can have reads in flight at once. **The coalesce key carries that generation** (`status:<root>#<gen>`) and has to: see [[lesson_a_coalesce_key_must_carry_the_guards_generation]].
- **Concurrent refreshes of the same key coalesce.** `Editor.tsx` and the Changes panel both refresh on a root change; without this that is two `git status` runs per switch.
- **`push`'s in-flight flag is per member** rather than one shared boolean, because a Feature draws a Push per member section and one flag would label every one of them "Pushing..." for a push in any one. It is still shared between the palette and the panel for one root, because two concurrent pushes of one branch is not something either should be able to start. Its `git://push-done|error` wait (`waitForPush`) moved here from the panel wholesale.
- **`startGitWatch()` subscribes the store to `fs://changed` and `git://fetch-done|error`**, called once from `Editor.tsx`, refreshing the slot the payload names (`root`, `repo`) and every slot when it names none. The file-list refresh moved here from the Changes panel in #157, so status stays true with the panel closed, at the price of one `git status` per member per burst. `.git` is watcher-filtered ([[gotcha_the_project_watcher_must_filter_churn_dirs]]), so a fetch that moves the upstream, or a terminal-side commit, emits no `fs://changed` and window focus stays the only recovery.
- **`editorState.ts` publishes a snapshot**, not live signals: `{activePath, dirty, tabCount, projectRoot, recentJumps}`, replaced wholesale by an effect in `Editor.tsx`. A half-updated read (an active path from one moment beside a dirty flag from another) would have the palette offering to save a file that is already saved.
- **`projectRoot` is the repo the editor's git commands act in** (2026-08-27, #157), which inside a Feature is the member owning the active file, not the selected workspace. It changed meaning rather than gaining a sibling, because its only consumer is the palette's staged/ahead gating, and that was already asking the narrower question. Without it the palette can offer Commit off one member's index and run it in another.
- **`recentJumps` is a required field, not an optional one** (2026-08-05, wave 6). The navigation jump list is session-lived and lives in `Editor.tsx`, so the omnibox reads it here rather than through storage the way it reads frecency. Required, because this module's own rule is that a snapshot's parts describe one moment; an optional field would let a consumer read "no jumps" and "not published yet" as the same answer. See [[component_editor_navigation]] and [[concept_omnibox_prefix_router]].
- **Deliberately NOT here:** the expanded diff and its gaps, the PR origin/base branch, preview toggles. State only a mounted panel has any use for stays in the panel.

## Key files & entry points

- `src/utils/gitActions.ts` — `:67` the slot map, `:74` `gitStateFor`, `:99` the `*Across` family, `:133` `pushingIn`, `:152` `epochs`, `:191` `enterRoots`, `:209` `refreshStatus` (and `refreshMeta` / `refreshGit`), `coalesce`, `stage` / `unstage` / `commit` / `push`, `waitForPush`, `:356` `startGitWatch`.
- `src/utils/features.ts:133` — `rootOf(path, roots)`, the one "which member owns this path" rule, shared with the panel and the palette.
- `src/utils/editorState.ts` — `editorState()`, `publishEditorState`, `clearEditorState`.
- `src/panels/Editor/Editor.tsx` — `:1174` `watchKey`, the memo the git slot set and the fs watcher both key on; the effect that calls `enterRoots`; `startGitWatch`; and the effect that publishes the editor snapshot.
- `src/utils/gitActions.test.ts` (16 tests), `src/utils/editorState.test.ts` (3) — both drive the stores with nothing mounted, which is the claim.

## Connections

- Read by [[component_command_palette]] to resolve the `requires` tags of [[concept_command_registry]].
- [[component_changes_panel]] became a consumer: it reads the file list, branch and ahead/behind from here instead of fetching them.
- Driven by [[component_cm6_editor]]'s `Editor.tsx`, which is always mounted (`App.tsx` hides the pane with a CSS class, it does not unmount it) — the property the whole design rests on.

## Related

- [[component_session_stores]] — the precedent this follows.
- [[concept_per_member_git_slots]] — the git half's shape since #157, and the rules the accessors follow.
- [[lesson_pure_core_for_global_stores]] — the same instinct on the Rust side: keep the store read at one boundary and pass state in.
- **New cost worth knowing:** every workspace switch runs `git_status`, `list_branches` and `git_ahead_behind` even if you never open Changes, and inside a Feature that is once per member, on every burst as well as every switch. That is the price of a store the palette and the sidebar can read with the panel closed.
