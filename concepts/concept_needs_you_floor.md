---
summary: the sidebar dot joins PTY quiet against the transcript tail, gated per agent by a measured needs_you capability flag
status: current
updated: 2026-08-14
source: "Adapter registry, pulse, presence, checkpoints (personal/sway, branch `topbar`); Phase 2; Prove the adapter: opencode + claude hooks (personal/sway, branch `topbar`); Phase 3; `src-tauri/src/pty.rs`, `src-tauri/src/sessions.rs` (`session_tail_state`), `src-tauri/src/hooks.rs`, `src/panels/LeftSidebar/LeftSidebar.tsx` (`sessionDot`)"
---

# Needs-you floor (working/blocked dot join)

A live session's sidebar dot has four states — none/hollow/working/needs-you — computed by joining two independent, agent-agnostic signals: whether the PTY is currently emitting bytes, and what the transcript's last turn looks like. Neither signal alone can tell "the agent is waiting on you" from "the agent is thinking" or "the agent crashed"; the join can, and it never touches agent IO to get there (the pure-PTY invariant: everything here *observes* streams).

## How it works

`pty.rs`'s reader thread calls `note_output` on every chunk it forwards to xterm; a separate per-session watcher thread polls `check_quiet` every 200ms (stopping once the session leaves `PtyState`) and emits debounced `pty://activity` active/quiet transitions once the gap since the last byte exceeds the adapter's `pty_quiet_ms` capability. This needed a second thread because a blocking PTY reader has no read-timeout of its own — "gone quiet" isn't observable from inside the read loop.

`sessions.rs`'s `session_tail_state(id, path, agent)` classifies the transcript's *last* turn (via the already-agent-agnostic `parse_transcript_turns`): a trailing `tool_call` → `blocked-candidate`, a trailing final `text` → `done`, anything else (no turns yet, mid-thinking, a tool result awaiting the next reply) → `working`. This is a **guess** from a proxy signal — it can't tell "blocked on a real permission prompt" from "still generating with nothing streamed yet".

**Phase 3 promoted claude off the guess entirely.** When `agents::find(agent).hooks` is true, `session_tail_state` checks [[component_claude_hooks_status]]'s `hooks::status_for(id)` *first*: if claude's own injected hook fired and wrote a recognized status (`Notification` → `blocked-candidate`, `UserPromptSubmit`/`PreToolUse` → `working`, `Stop` → `done`), that's returned directly, and the transcript-tail guess below it never runs. Only when no hook file exists yet (a session just launched, or the claude process wasn't Sway-launched) does it fall through to the tail join. pi and opencode have no hook mechanism (`hooks = false`) and always use the tail join.

`LeftSidebar.tsx`'s `sessionDot(id)` composes them, keyed differently on purpose: PTY activity is keyed by *tab* id (one hosted shell can outlive/precede its session attribution), tail state by *session* id. `activity === "quiet" && tailState === "blocked-candidate"` → needs-you; `activity === "active"` → working; otherwise solid/hollow/none based on whether a live tab and a running probe exist. Detached sessions (no live tab) cap at the hollow dot — working/needs-you both require a real PTY to observe.

## Why it's this way

The join's correctness depends on an assumption that must be verified **per agent**, not assumed globally: is "blocked waiting for permission" actually byte-quiet on the PTY? Phase 2 measured this empirically before wiring anything (real `claude`/`pi` binaries, `pty.fork`, raw byte-arrival logging): claude's `--permission-mode plan` produced a genuine plan-approval prompt that went **fully silent for 9.46s**, while pi ran a Bash-requiring prompt **immediately with no permission gate at all** — pi is effectively always-yolo, so a trailing tool_use + quiet PTY for it means "still running", not "waiting on you". `pty_quiet_ms = 2000` was chosen as >2-3x each agent's own noisy-phase max inter-chunk gap (0.62s claude, 0.93s pi), comfortably below the observed blocked-silence duration.

Rather than hardcode "pi never shows amber" as a special case, the plan's contingency became a capability field: `capabilities.needs_you` (bool, default true) on [[component_agent_adapter_registry]]'s `AgentAdapter`. `session_tail_state` capability-gates at the source — an adapter with `needs_you = false` (pi) collapses `blocked-candidate` to `working` inside the command itself, so a false amber can't reach the frontend even if a caller forgets to check the capability. A future third-party adapter that fails this verification ships with `needs_you = false` in its TOML, recorded in `ADAPTERS.md`, rather than skipping the empirical step.

## Chat adds a third, exact tier (2026-07-28)

Chat status is **purely additive** and nothing here was removed. The PTY-activity join keeps serving agent tabs and pgrep keeps serving external sessions; a chat session reports its state directly from its own event stream, so for it the join is not needed at all. `sessionDot` gains a chat branch ahead of the existing tab and probe branches.

Only the **exact** side is marked visually. Marking the inferred side would have changed external-session rendering and broken the committed golden status fixture, so inferred output stays byte-for-byte as it was - consistent with [[concept_evidence_tiered_attribution]]'s rule that the tree never claims more certainty than it has.

## The tiers, and where the gate went (2026-07-31)

The three certainty tiers this join sits inside are written up separately now -
see [[concept_session_certainty_tiers]] - and the one line worth repeating here
is that **only the PTY tier can starve**, so a chat-based check of this join
certifies nothing.

The composition moved out of `LeftSidebar` into [[component_session_stores]]:
probes, PTY activity, tail states and the tray/badge/notification effects all
live in one module-level `createRoot`, because the tray must keep tracking
whether or not a sidebar is mounted.

The capability gate was **extracted to a pure function**, `gate_tail(tail,
needs_you_capable)` in `sessions.rs`, so the off case is testable directly rather
than through `session_tail_state`, which reads the global registry. The old
pi-based test for it was passing for the wrong reason by then -
[[lesson_a_test_can_pass_because_its_fixture_stopped_parsing]].

## The off case is the majority now (2026-08-14)

This page said at the time that **no bundled adapter turns `needs_you` off any
more**. That is now false, and it inverted rather than drifted: of the four
bundled adapters, **three declare `needs_you = false`** (`codex.toml`,
`gemini.toml`, `opencode.toml`) and only `claude.toml` declares it true. pi is no
longer bundled at all.

The reason is not that those three behave like pi did. It is that the flag means
*"the blocked-quiet join has been verified for this agent"*, and for an adapter
that ships over ACP nobody has done that measurement - Gemini ships deliberately
unmeasured, and Codex and OpenCode were measured for their protocol behaviour
rather than for their PTY silence. Declaring `false` is the honest reading:
[[component_agent_adapter_registry]]'s rule is that an adapter which fails or skips
the empirical step ships with the gate off rather than borrowing another agent's
result. Those three are also chat-first harnesses, where the exact tier below
supersedes this join entirely, so the capped dot costs them nothing.

## A fourth input, outside the tiers (2026-08-03)

`computeSessionDot` gained `forgeAttention` (`src/utils/sessionDot.ts:96`), which
is true when a required check on this branch's pull request has failed. It is not
a fourth tier: the tiers grade Sway's certainty about a *session*, and this is a
fact about the *branch*, which is why it sits beside them rather than among them.

It only ever **raises a session that is sitting still** (`solid` or `hollow`
become `needsYou`), never one already working, because a red check is not a
reason to interrupt a turn in progress. Attribution is `belongsToUnit`, the same
rule the rest of the app uses, not a second one invented here, so a detached
session with no tab and no chat can still be the one that owns the failure.

Its golden fixture is separate (`sessionDotCi.golden.json`). The pre-existing
`sessionDot.golden.json` holds the inferred tiers byte-for-byte and must not
absorb new cases, for the reason in
[[gotcha_only_the_pty_tier_can_starve_so_a_chat_based_needs_you_test_proves_nothing]].

## Related

- [[component_chat_panel]] - the exact tier's source.
- [[component_forge_client]] - where the failing-check fact comes from.
- [[concept_forge_rate_budget]] - the poll layer that keeps that fact current.
- [[component_agent_adapter_registry]] — owns the `needs_you`/`pty_quiet_ms`/`hooks` capability fields this join is gated by.
- [[component_claude_hooks_status]] — claude's ground-truth override of this join.
- [[component_presence]] — consumes the composed dot's rising edge (quiet+blocked-candidate) for OS notification/tray/badge.
- [[component_session_worklog]] — `parse_transcript_turns`, the parser this reuses rather than re-deriving.
- [[concept_session_certainty_tiers]] — the three tiers this join is the middle of.
- [[component_session_stores]] — where the composition and its effects now live.
- [[gotcha_only_the_pty_tier_can_starve_so_a_chat_based_needs_you_test_proves_nothing]]
