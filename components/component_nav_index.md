---
summary: navIndex builds every Cmd+K place from the tree the sidebar feeds, other spaces' sessions read only, PRs live or remembered
status: current
updated: 2026-11-20
source: "plan \"Cmd+K navigator\" (personal/tori, branch `cmdk-improvements`), Phases 5, 6, 8, 11 and 13; commits `7bb1bbc0`, `84e3748d`, `1bcfa5f1`, `8cc77a78`, `938751d7`; `src/utils/navIndex.ts:171`, `src/utils/prMemory.ts`, `src/utils/visitLog.ts`, `src-tauri/src/sessions.rs` (`sessions_overview`)"
---

# Nav index

`src/utils/navIndex.ts` is the list of places Cmd+K searches, and the lookups
other surfaces need over the same tree.

## Responsibility

It owns no data of its own. The sidebar is the only place that resolves the
config, so it pushes the resolved tree and each project's raw origin URL in
through `noteNavTree(spaces, origins)` on every change. Everything else is read
from existing stores when `livePlaces()` runs inside a memo:

- **Topics and chats** from `topics()` and `chats()`.
- **Sessions in every space** from one read-only Rust listing,
  `sessions_overview`, asked when the box opens on the all home and again on
  each `sessions://changed` while it is open (`watchSessionsOverview`, latest
  request wins). These rows never enter the session store, which would put
  other spaces on the needs-you pipeline and the liveness probe. A recreated
  folder's old sessions stay out until adopted in the History dropdown.
- **Pull requests** from the forge's `unitStatus` in the active space, and from
  `prMemory.ts` everywhere else: the last PR seen per project and branch,
  written from `onForgeReport`, kept in localStorage, drawn muted as "last
  seen". The forge never polls another space for this
  ([[concept_forge_rate_budget]]).
- **Review requests** per project, and **mentions** from
  [[component_session_issues]].

It does not rank; that is [[concept_navigator_ranking]].

## Interface

- `buildPlaces(input)` (`navIndex.ts:171`) is pure and returns, in tie order:
  spaces, projects, units, Topics, Topic members, review requests, chats,
  sessions. A unit inside a Topic is reached through the Topic, not listed
  twice. Each place carries `target` (a `NavTarget` for `NAVIGATE`, see
  [[concept_in_app_navigation]]) or `review` (Enter opens or makes its
  `pr-<n>` worktree through `OPEN_REVIEW`).
- `placeNumbers(place)` lists the numbers a place answers to: its issue, its
  PR, digit runs in a branch name, its mentions.
- `placeIdOf(selection)` gives `unit:<folder> <branch>`, `topic:<id>` or
  `chat:<id>`. These ids are also the keys `visitLog.ts` stores, so Recent and
  the visit tie-break resolve against live places and a gone place just drops
  out. The unit id joins folder and branch with a space, since an option id
  ends up in a selector ([[gotcha_kobalte_finds_an_option_by_an_unescaped_data_key_selector]]).
- Tree lookups for other callers: `liveProjects()`, `linkedIssueAt(folder,
  branch)`, `unitAt(folder)` (a worktree, or a plain repo's checked-out branch),
  `unitFolders()` (for a pasted path), `liveOrigin`, `livePr`.

## Related

- [[component_command_palette]] the box that lists these places
- [[adr_cmdk_is_a_navigator]] why places are in Cmd+K at all
- [[concept_omnibox_prefix_router]] when the all home is the one searching
