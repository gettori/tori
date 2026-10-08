---
summary: verification.rs marks each code-changing turn verified, failed or unverified from the last check after its last edit
status: current
updated: 2026-10-08
source: "Verification badge plan (branch `phase-1-block-1`, gettori/tickets#26); commits 32bb7fa2, 1624030d, 140d5b82; `src-tauri/src/verification.rs` (`Tracker`, `mark_history`, `session_turns`, `entries_for`), `src-tauri/src/chat/host.rs` (`wrap`, `mark_verification`), `src-tauri/src/chat/commands.rs` (`session_verification`), `src/utils/verification.ts`, `src/components/Dialogs/VerificationCommandsDialog.tsx`"
---

# Verification

`src-tauri/src/verification.rs` decides, for every turn that changed code, whether the agent checked its work afterwards. The answer is its own event, `TurnVerification { verdict, checks }`, sent just before the turn's `TurnCompleted`. A fact on the turn, never a gate: Tori never runs a check or holds a turn.

## Responsibility

- **Code changed** means an `Ok` call of kind Edit, Delete or Move, a call with files, or a `FileEdit`. A shell write (`sed -i`) is not seen, so that turn gets no verdict. A turn with no edit gets none either.
- **The verdict** comes from the last checking call after the last edit, by its worst entry: passed is verified, failed is failed, and no check or an exit not seen is unverified. A later edit voids an earlier pass.
- **A check** is a command whose words start with an entry of the list, after `strip_wrappers` takes off assignments, `timeout`, `time`, `nice`, `command`, `npx`, `bunx`, `env`, `pnpm|npm|yarn exec|dlx`, `uv|poetry run`, `python -m` and runner flags. `cd`, `export` and friends are setup, and `sh -c "..."` is read recursively.
- **Exit trust.** Only the trailing `&&` run of a line can own the call's exit, and only when what precedes it is `;`, `&` or nothing, the line ends there, the call was not backgrounded, and the output does not show a timeout or an interrupt. Anything else is `notSeen`. A rejected call never ran and yields no check. A failing chain holding a command that is neither a check nor setup is `notSeen`, since Tori cannot tell which one failed; setup is assumed not to be what failed.
- **The list** is `DEFAULTS`, or the project's own from `verification.commands`, resolved by the deepest key that is a component prefix of the session cwd (so worktrees under a container and `.tori/worktrees/x` find it, `/work/app-other` does not). An empty list is no entry. It replaces the defaults, never adds.

## Interface

- Live: `ChatHost::wrap` keeps a `Tracker` per session in `verify`, fed only `ToolCallStarted`, `FileEdit`, `ToolCallCompleted` and `TurnCompleted`. Time is measured only when the session is not replaying (`Lifecycle::replaying`). The tracker re-reads the list on a turn's first event, so a saved list applies from the next turn.
- Replay: `mark_history` (through `ChatHost::mark_verification`, in both `history_reply` and `chat_history_page`) drops logged `TurnVerification` events, recomputes them against the list as it is now and keeps only their measured durations. A mirror log groups by turn id; a Claude transcript has no `TurnCompleted` and groups by prompt, see [[gotcha_a_claude_transcript_replay_has_no_turn_completed]].
- Per turn: `session_verification(sessionId, agentId, cwd)` runs `session_turns` over `read_with_prompts`, keyed by `promptTs` for Checkpoints and the tab. Cached on the transcript stamp plus the settings.json mtime, and it shares one parse with `session_secrets` through `marked_history`. This is the shape the risk score (#32) reads.
- Frontend: `chatStore` folds the event into `verifications`, `MessageList` draws the badge at the turn head with `verdictDetail` as its tooltip, and `turnWatch` (shared with secret reads) feeds `TabMark`, the History row and the Checkpoints row with the latest code turn's verdict.
- Settings: `verification.enabled` (default on, the Chat pane's "Mark unverified turns") and `verification.commands`, edited from the project menu's "Verification commands" dialog, whose prefill comes from `verification_commands(project)`. Both are cached on the settings mtime.

## Why it is this way

- **Its own event, not a field on `TurnCompleted`**, because a Claude transcript replay has no `TurnCompleted` to carry it.
- **One rollup, in Rust.** A second copy in `chatStore` (the blind-edit shape) would let the ordering rule drift between two languages.
- **First answer per turn kept** in the tracker, so an ACP load replaying through `wrap` does not overwrite measured times. See [[gotcha_an_acp_load_hands_history_back_through_the_live_sink]].
- **Never read from the repo**, so a project cannot declare its own work verified.

## Related

- [[concept_evidence_tiered_attribution]] why a masked exit reads unverified, never verified
- [[gotcha_claude_bash_reports_exit_only_in_its_text]] where a Claude exit code comes from
- [[gotcha_a_claude_transcript_replay_has_no_turn_completed]] the prompt grouping on replay
- [[gotcha_a_change_to_live_chat_events_misses_replay]] why it is marked in two places
- [[component_secret_watch]] the sibling whose cache and watcher this shares
- [[component_blind_edit]] the sibling tracker in `wrap`
