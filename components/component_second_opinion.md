---
summary: second_opinion.rs runs a hidden read-only reviewer on a session span and stores its findings per worktree top level
status: current
updated: 2026-10-12
source: "Second opinion plan (branch `phase-1-block-2`, gettori/tickets#34); commits 3962a2b2, dd89664b, 97a0a589; `src-tauri/src/second_opinion.rs:299`, `src/utils/secondOpinion.ts`, `src/panels/Editor/HeldComments.tsx`"
---

# Second opinion

`src-tauri/src/second_opinion.rs` asks a different agent to review what a session changed since its review mark, read-only, and keeps the findings so they come back as held hunk comments in the session's diff.

## Responsibility

- **Subject.** `second_opinion_run` takes `review::span_now` (the same span the Inbox shows), diffs it with `git diff before after -- :(top)paths`, leaves lockfiles out and names them, and caps the diff at 2,000 changed lines, naming the files past the cap. Each included file's blob at `after` is kept as the finding's baseline. The task is the session's prompts since the mark (`session_prompts_body`), else its first prompt for an ACP author.
- **Run.** `spawn_session` with `background: false` in the author's worktree, then confirm read-only before the brief goes: claude through `SessionStarted.permission_mode == plan`, codex by setting the `mode` config option to `read-only` and waiting for a `ConfigOptions` event showing it. Leaving the mode stops the run. Permissions are denied and questions settled so the reviewer never waits. Timeouts: 90s start, 30s mode, 15 min review. The session is closed afterwards and stays in the worktree's history.
- **Parse.** The last fenced json block of the reply, else a bare object, else the ExitPlanMode `plan` (`parse_draft`, `second_opinion.rs:730`). A finding on a file outside the span is dropped. No block is a stored error, an empty list is "nothing worth raising".
- **Store.** `project_state_path("second-opinion", toplevel)`, a map of session id to `Review { reviewer, ts, findings, error }`. A finding has id `so-{ms}-{i}`, absolute path, lines, body, baseline blob and status `open`, `sent` or `dismissed`. Stale is computed on read: `git hash-object` of the live file against the blob.
- **Spend.** Each turn end goes to `usage::record_turn` in the worktree's usage file under the reviewer's session id, best effort. A run refuses to start at or past `budgets.project_usd` (the chat rule, spent >= limit). Codex reports no cost, so codex alone never trips it.

## Interface

- Tauri: `second_opinion_reviewers`, `second_opinion_running`, `second_opinion_list(folder)` (with the author's `SessionMeta` and per finding `stale`), `second_opinion_set_status`, `second_opinion_run`. Every change emits `second-opinion://changed`.
- `opinion_of` feeds `ReviewItem.second_opinion`. `forget` is called by `review::mark_now`. A mark during a run goes into `MARKED`, and the finishing run drops its findings; both sets are taken under `RUNNING`'s lock, before `STORE_LOCK`.
- Frontend: `secondOpinion.ts` picks the reviewer from `settings.secondOpinion[projectPath]` (default: first enabled reviewer that is not the author's agent), starts runs, toasts on finish, and turns open findings into held comments with their own send target. Entry points: the History row menu, the sidebar unit menu (latest Inbox item under the folder), and the Inbox row button.

## Why it is this way

- **The author's worktree, not a new one.** The reviewer reads the real files, including untracked ones, and read-only mode is what keeps it from touching them.
- **Keyed by git top level**, so a session's cwd and a diff tab's folder find one file however each spells the path.
- **On disk, not in memory** like the user's own held comments, so sent and dismissed survive a relaunch and a finding is never offered twice.

## Related

- [[concept_held_hunk_comments]] where findings show up and how they are sent
- [[component_review_inbox]] the span it reviews and the row that shows its state
- [[concept_spend_ceilings]] the ceiling a run checks
- [[gotcha_a_background_chat_pre_allows_toris_mcp_tools]] why the reviewer spawns foreground
