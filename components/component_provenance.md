---
summary: provenance.rs names the turn and tool call behind each hunk by walking every session's checkpoints; the gutter reads it too
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1); commits a402d912, 1354c40c, b160034c, 90b92684, f0282c7f, be057654; src-tauri/src/provenance.rs, src/utils/provenance.ts, src/panels/Editor/HunkProvenance.tsx"
---

# Hunk provenance

`src-tauri/src/provenance.rs` answers "who wrote these lines" for a diff hunk or a whole file: the session, the turn, the tool call and the agent's words before it, or a reason nobody can be named.

## Responsibility

- **The walk** (`changes`, `apply`, `provenance.rs:189`, `:249`). Every checkpoint of every session in the worktree is a point on one timeline. One batched `cat-file --batch-check` reads the file's blob in each tree, and only intervals where the blob changed are diffed, newest `MAX_CHANGES` (40) kept. A per-line vector records which interval wrote each line, and a parallel gap vector records which interval last deleted between two lines, so a deletion-only hunk resolves too.
- **Who wrote an interval**, graded per turn and settled into a claim. See [[concept_who_wrote_an_interval]].
- **Ends.** A walk ends at a tree with an optional `until` time: the working tree (`live_end`), the index read from a copy (`index_end`, `provenance.rs:1278`), a turn's next checkpoint (`checkpoint_end`), or a PR head commit stopped at its commit time (`pr_claims`, `provenance.rs:1376`).
- **Sessions** come from `worktree_sessions` (`provenance.rs:1126`): the worktree's own sessions by `owned_by_listing`, chat or terminal, plus sessions of any Topic home the worktree is a member of. Not `inclusive: true`, which pulls in nested `.tori/worktrees` whose trees are other branches.

It does not decide what a hunk is: callers pass changed-line blocks, and `hunk_spans` / `spans_of` (`provenance.rs:1227`, `:1240`) are the one parser, used by the panel (raw hunk text goes to Rust) and by the CLI.

## Interface

- `hunk_provenance(repo, file, end, sessions, hunks, histories)` (`provenance.rs:1062`): claim ranges per hunk.
- `line_turns` (`provenance.rs:1094`): one turn index per line, for the editor gutter, so the gutter and the panel cannot disagree. `agent_lines` is now a thin projection of it.
- `Histories`: transcripts read once per request and shared across files.
- Tauri: `diff_provenance`, `checkpoint_provenance`, `pr_provenance`, `ask_why_reply`. Socket: `provenance.hunks`, and `checkpoint.diff` with `why` (`rpc/methods.rs:1255`). CLI: `tori checkpoint diff --why / --json` ([[component_tori_cli]]).
- Frontend: `src/utils/provenance.ts` (types, `claimHeadline`, readers via `claimsVia`, the ask seed) and `HunkProvenance.tsx` (the panel, `WhyToggle`, `createOpenHunks`, the ask box) in the diff tab, Checkpoints diff tab and PR file view.

## Related

- [[concept_who_wrote_an_interval]] the evidence model inside the walk
- [[concept_ask_why_by_fork]] the ask box under a claim
- [[concept_line_provenance]] the gutter, now a projection of this
- [[component_turn_checkpoints]] the trees it walks
- [[concept_evidence_tiered_attribution]] the rule the claims follow
- [[gotcha_a_checkpoint_turn_spans_many_transcript_prompts]] why a turn is cut by time
- [[gotcha_a_diffs_own_text_can_contain_binary_files]] the binary check
