---
summary: Session scanner is Claude only now that pi's parser is gone, and sessions_running batches one pgrep per adapter
status: current
updated: 2026-07-31
source: "Tori build plan (personal/tori); commit e121aeb; multi-agent + folder anchoring; commit 84f2930; adopted/historical sessions; commit 4f14660; Session worklog: status dot, touched files, panels (branch `topbar`); Phases 1-3"
---

# Session scanner

**Location:** `src-tauri/src/sessions.rs` (frontend: `src/panels/LeftSidebar/LeftSidebar.tsx`)

Discovers agent sessions by scanning the on-disk jsonl logs and exposes them to the tree, anchored on each session's recorded `cwd` (see [[concept_folder_anchored_sessions]]). Built for speed: it reads only the head of each file, caches by mtime, and watches the directory for live updates. **Two agents** are merged: Claude (`~/.claude/projects/*/*.jsonl`) and pi (`~/.pi/agent/sessions/*/*.jsonl`).

## One agent, a batch probe, and a listing that writes nothing (2026-07-31)

**pi's parser is gone** (branch `navigation`, phase 8). Claude is the only shape
scanned, `watch_dirs()` returns exactly one directory, and a test asserts the
count - a stale root would have the watcher creating and watching a directory for
an agent that no longer exists.

**Liveness is a batch call.** `sessions_running(sessions)` spawns **one `pgrep`
per registered adapter** and matches ids in Rust, instead of one subprocess per
session id. Three callers were issuing N probes, not the expected two: the
surprise was `probeActive`, which fires on *every* `sessions://changed` and probed
once per live tab, so a busy window paid a subprocess per open tab on every
transcript write.

**Listing no longer persists an adoption.** `fetchSessions` used to call
`folder_historical` right after `list_sessions`, and that verdict auto-adopts and
writes `adopted.json` - so eagerly covering the whole space would have silently
adopted folders the user never opened. The verdict is now `checkHistorical`,
called only where the Historical section is about to render. Both "never adopts"
guards are source-level assertions, following `attempts.rs::promotion_never_merges`,
because the write is two calls down and `list_sessions` takes a Tauri `State` a
unit test cannot construct.

The cached map itself moved to the frontend as [[component_session_stores]]; this
page stays the Rust half.

## Responsibilities

- For each session file, extract id, `cwd`, a title (first real user message), last-activity (file mtime), and an `agent` tag (`"claude"` | `"pi"`). Reads only the first ~60 lines.
  - Claude: id = file stem, branch from `gitBranch`, title skips meta/slash-command/`<`-envelope messages.
  - Pi: head line `{type:"session", id, cwd}`; no branch; title from the first user message skipping `<`-envelopes and `[Context]` blocks, with an **id-slice fallback** for an empty session; resumed by its `sessionFile` path (`pi --session`). `last_active` uses file mtime (better than the head ISO timestamp; no parse dep).
- Maintain per-agent in-memory indexes (`SessionIndex`, `PiIndex`) keyed by path; re-parse only when mtime changed.
- `list_sessions(folder)` merges both agents whose normalized cwd **is the folder or nested under it** (branch is no longer a filter - it is a label), newest first. The frontend distributes them to branch-units (see the concept).
- Watch both agents' session dirs (`watch_dirs()`: `~/.claude/projects` + `~/.pi/agent/sessions`) recursively (debounced) and emit `sessions://changed`; the frontend re-fetches open folders and re-probes liveness (see [[component_session_worklog]]).
- Deliberately head-only for discovery/listing (`list_sessions`), so a folder with many sessions stays cheap to render. Full-transcript reads (touched files, prompt/turn/token counts, transcript turns) are a **separate**, differently-cached layer built on top, never folded into `SessionIndex`/`PiIndex` — see [[component_session_worklog]].

## Adopted paths / Historical sessions

A folder recreated at a path where old sessions still live would surface those ghosts as if they were its own. `adopted_paths` (in a **separate** `~/.config/tori/adopted.json`, never the watched `tori.toml`, which would loop the config watcher) marks folders whose sessions are "ours".

- **Seed once** (`do_seed`): on the first discovery yielding ≥1 folder, adopt them all (so a fresh install never flags pre-existing folders); **never on empty discovery**. Idempotent via a `seeded` flag; the UI calls `seed_adopted(folders)` after each `get_config`.
- **Verdict** (pure `folder_verdict`, unit-tested): in the set OR no sessions → Adopted; all sessions **postdate the folder's creation** (btime, mtime fallback) → **AutoAdopt** (persist); a session **predating** creation → **Historical**. `folder_historical(folder)` returns the bool, auto-adopting in passing.
- **Auto-adopt on Tori-create**: `pub fn adopt` is called by `config::add_folder`, `worktree::create_worktree`, and the clone/bootstrap path (`adopt_path` on the target before it exists), so reusing a path over old sessions is not historical.
- **UI**: a historical folder renders its sessions under a collapsed "Historical (N)" row with an inline **Adopt** button (`adopt_path`, persisted across restart); a single session `<For>` is gated so the normal path is unchanged.

## Key files & entry points

- `src-tauri/src/sessions.rs` - `parse_session` / `parse_pi_session` (head-only extract), `ensure_index` / `ensure_pi_index` (mtime-cached walks), `cwd_matches` + `filter_sort`, `list_sessions`, `sessions_watch_start`.
- `src/panels/LeftSidebar/LeftSidebar.tsx` - lazy-fetches sessions per branch-unit folder, renders title + relative time, the per-agent icon (`ClaudeIcon` / `PiIcon`), the mismatch badge, and the liveness dot (see [[component_session_worklog]]).

## Connections

- Implements [[concept_filesystem_source_of_truth]] - the session half.
- Realizes [[concept_folder_anchored_sessions]] - the cwd anchor + multi-agent merge.
- Sibling of [[component_project_discovery]] - sessions vs projects.
- Feeds [[component_pty_host]] - a clicked session's id + `sessionCwd` become a resumed terminal.
- Provides the live-use guard (`list_sessions` + `session_running`) and auto-adopt hook for [[component_worktree_lifecycle]].
- Extended by [[component_session_worklog]] - the liveness dot and touched-files extraction are built on this scanner's file discovery, in a separate cache.
- Cached by [[component_session_stores]] - the frontend store that holds what `list_sessions` returns.
- Listed by [[component_history_dropdown]] - the surface that renders these sessions.
- Governed by [[adr_stack_choice]] - auto-discovery rather than manual session lists; adopted-set model from [[adr_sidebar_project_manager]].

## Related

- [[gotcha_encoded_claude_dir_name_is_lossy]] - why cwd is read from contents, not the folder name.
- [[gotcha_gitbranch_is_recorded_at_session_creation]] - why filtering by live branch can miss old sessions.
- [[gotcha_listing_a_folders_sessions_must_never_ask_for_the_historical_verdict]]
- [[gotcha_the_pgrep_flag_for_full_command_lines_differs_on_macos]]
