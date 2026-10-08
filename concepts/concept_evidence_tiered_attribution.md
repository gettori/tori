---
summary: a weak signal must produce a weaker claim, never a confident one, and unknown actors must never read as empty ones
status: current
updated: 2026-10-08
source: "Status deepening: checkpoint timeline, tree revert, touched markers, live indicator (personal/tori, branch `main`); Phases 1 and 2; `src/utils/revertGuard.ts`, `src/utils/editingNow.ts`, `src/utils/folderActors.ts`, `src/panels/Editor/Editor.tsx`; Chat surface plan, phase 1 (branch `chat`); `src-tauri/src/checkpoint.rs`, `src-tauri/src/chat/claude.rs`; commits \"Stop recording a read file as one the session wrote\", \"Grade per-turn attribution instead of asserting it\""
---

# Evidence-tiered attribution (never assert what you cannot verify)

Tori makes claims about other processes it does not own: "this session is mid-turn", "this session wrote that file". Every such claim rests on a signal of a *specific strength*, and the strengths differ enormously. The rule this codebase settled on is that the **certainty of the signal must be visible in the behaviour**: a weak signal produces a weaker claim, never the same confident claim with worse odds behind it. Two features implement the same shape.

## The two ladders

**The revert guard** ([[component_turn_checkpoints]]'s `checkpoint_revert_tree`) grades *liveness*:

- a live-tab session showing Executing is **known** mid-turn (Tori hosts its PTY and reads its transcript) → hard block, no override;
- a detached session found only by the pgrep probe **can never report Executing** — Tori has no window into it → block, but overridable with an explicit "revert anyway", because the state is *unverifiable*, not *known-busy*.

"Cannot verify" is deliberately closer to "busy" than to "idle": the cost of a wrong "idle" is clobbering an agent's in-flight work.

**The live editing indicator** (`editingNow.ts`) grades *authorship*:

- the **parser path** (`session_editing_now`, reading the file name out of the session's own transcript) is **direct** attribution — the session said it wrote that file. It holds regardless of who else is active in the folder;
- an **`fs://changed` path** is **circumstantial** — the watcher reports that a file changed, never *who* changed it. Attributing it to the selected session is only sound if that session is the folder's sole live actor.

So the fs tier degrades rather than lies: sole actor → a filename; anything else → a file-less "editing…" pulse. Showing the wrong filename is worse than showing none, because the user acts on it.

## Unknown must never collapse into empty

The sharpest edge, and the one that was actually wrong in review before it was fixed. The folder's actor set is gathered asynchronously (`folderActors`: `list_sessions` plus a `session_running` probe per off-tab session), so there is a window right after a selection change — and after any failed probe — where the set is simply **not known yet**.

Representing that as an empty array makes "we haven't looked" indistinguishable from "we looked and nobody is there". An empty set reads as *sole actor*, which hands an fs event a confident filename **precisely in the window where the evidence is missing**. The fix is a tri-state: `isSoleLiveActor` takes `RevertCandidate[] | null` and answers `false` for `null`; `Editor` holds `actors: RevertCandidate[] | null`, set to `null` on selection change and when the probe throws.

Generalizes: any "is it safe / is it unambiguous" predicate fed by an async probe needs three states, not two. Absence of evidence must be its own value, and it must fall on the conservative side.

## One definition of "actor"

The indicator and the revert guard test the same question ("who could be writing here?"), so they share one implementation rather than two that drift. `revertBlockers` is the single predicate; `folderActors.ts` is the single gatherer, extracted from `CheckpointTimeline` when the indicator needed it. Cost dictates *cadence*, not duplication: the detached tier costs a subprocess probe per off-tab session, so the guard gathers at click time and the indicator on a turn boundary — never per fs event.

## Silence is not denial

A related trap in the same wiring. `refreshEditing` originally published its result unconditionally, so for an adapter whose transcript shape cannot be parsed, the parser returned "nothing" on every `sessions://changed` and **stamped out a perfectly good fs-derived indication** moments after it appeared. A parser that names nothing has said *nothing*, not "no file is being edited". It now returns early and lets the existing indication expire on its own quiet timer.

Every indication is provisional regardless: a 4s `EDITING_QUIET_MS` timer expires it, so a turn that dies without a closing event cannot leave a file pulsing forever, and turn end (Executing dropping) clears it immediately.

## The attribution state is stored, not derived (2026-07-29)

Per-turn attribution was being *reconstructed*, and it was wrong in two opposite
directions at once: a mixed turn dropped its `Bash`-written files from the
recorded set (and therefore from revert), while a `Bash`-only turn recorded
nothing, fell through the unfiltered branch, and **claimed a concurrent
session's edits**. Neither the tree diff nor the tool-call paths could see a
shell write, so intersecting them did not "keep the tree's coverage" as a
comment claimed.

`checkpoint-touched/<sid>/<ts>.json` now stores `{"tools":[...],"files":[...]}`
and grades itself:

- **The old bare-array shape reads as `partial`, never `complete`.** It was
  written by code that could not see a shell write, so calling it complete would
  assert what was never measured.
- **Path-parseability is an allowlist** (`PATH_PARSEABLE_TOOLS`,
  `checkpoint.rs`), not a denylist. An unrecognised tool (an MCP server, `Task`,
  a new built-in) grades the turn `partial`, because any of them can write
  through a path Tori cannot see and the fail-safe direction is to doubt.
- **Both fields carry `#[serde(default)]`**, so a later field addition cannot
  drop a record to `unmeasured`, which is the unfiltered branch this exists to
  close.
- **Revert refuses rather than widens.** `checkpoint_revert_file` gained a
  `force` flag and refuses without it; the UI names the files it is leaving alone
  before a tree revert runs.

The mirror-image bug found in the same pass: a `Read` result names a file in the
same shape a write does (`file.filePath`), so `files_touched` was recording files
the session only opened. Fixed by keying off the *call's* name (`READ_ONLY_TOOLS`)
rather than guessing at the result's shape.

## Secret watch: read versus named

The same rule set the wording of the secret mark. A read or search tool names
the path it opened, which is direct evidence, so the turn says "Read a secret
file". A shell command that only has the path among its words (`cat .env`,
`ls ~/.aws`, `--env-file=.env`) may or may not have read it, so it says "A command
named a secret file". When a turn has both, the stronger claim wins. See
[[component_secret_watch]].

## Verification: an exit not seen is not a pass

The verification badge applies the rule to exit codes. A check whose exit
reached the call (the last `&&` run of the line, nothing after it, not
backgrounded, not timed out or interrupted) passes or fails on that exit. A
check whose exit was masked (`cargo test | tail`, `pnpm test || true`, a `;`
after it) "ran, exit not seen", and a turn resting on one reads unverified,
never verified. Trusting the call's status there would read a piped failing
suite as verified. See [[component_verification]].

## Hunk provenance: one sentence per grade

The rule set a whole feature's wording. A hunk's claim names one call only when one call is shown to have written it, falls back to "one of these calls", "a shell command", and then to `none` with the reason nobody can be named: there before the first checkpoint, older than the walk, a session Tori ran but cannot read, several sessions at once, nobody Tori saw, or a pull request whose branch no worktree here holds. "Ran but cannot read" is kept apart from "never saw", because the touched record exists only for chats with a view open and an absent record is not an absent session. See [[concept_who_wrote_an_interval]].

## Related

- [[component_provenance]] the hunk claims
- [[component_secret_watch]] the read versus named claims
- [[component_verification]] the exit not seen tier
- [[component_turn_checkpoints]] — the revert guard's home; the tree revert this protects.
- [[component_session_worklog]] — the indicator's surfaces (tree rows, tabs, Session panel).
- [[concept_needs_you_floor]] — where "Executing" is composed; the reason the guard lives in the frontend and the backend cannot see it.
- [[concept_fs_change_pipeline]] — the `fs://changed` producer and its self-write echo suppression, which keeps Tori's own saves from making a session look busy.
- [[concept_diff_as_transcript]] - lists a file it cannot diff rather than inventing one or staying silent.
