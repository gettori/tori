---
summary: the injected PreToolUse hook only captures a before state diff now, since any permissionDecision would end the chain
status: current
updated: 2026-08-14
source: "\"Defer permissions to the harness, and grow to four harnesses\" (phases 2 and 7, branch `chat-fix`); originally \"Native Claude chat as the default session surface\" (phases 4, 6, 12, branch `chat`); `src-tauri/src/chat/approval.rs`; `src-tauri/src/chat/snapshot.rs`"
---

# The PreToolUse capture hook

A `PreToolUse` hook that Tori injects into Claude sessions through `--settings`, matched to the write tools only, which reads the file a tool is about to change and hands the bytes to Tori before the write lands. It decides nothing. Its entire output is a marker saying the hook was Tori's, and the permission chain continues past it to the harness's own `can_use_tool` question.

**This page used to describe a gate**, and the gate is gone. Between 2026-07-29 and 2026-08-14 the same hook was the authority on every tool call in a chat: it matched `*`, consulted a Tori-owned rule file, opened a socket, prompted the user and answered `allow` or `deny`. All of that was deleted in phase 7. What follows describes what is there now; the reasoning that retired the rest is in [[adr_harness_breadth]] and the plan's own decisions, recorded as `tori-harness-owns-permissions`.

## How it works

- **Injection is additive and Tori-only.** `--settings <path>` layers on top of the user's own settings; an externally launched `claude` never sees the flag. `--setting-sources ''` would strip the user's own hooks and permissions and must never ship.
- **The helper is the same binary re-exec'd**, detected by a marker set inline on the hook command string, with the socket and token in `ENV_SOCK`/`ENV_TOKEN` (`approval.rs:55`) so only the hook process ever sees them.
- **The matcher is the write tools, and it is built rather than written.** `"Edit|Write|MultiEdit|NotebookEdit"`, derived from `snapshot::WRITE_TOOLS` (`snapshot.rs:67`) so a tool added to the snapshot list cannot be left off the matcher and silently lose its diff. Measured on claude 2.1.231: the alternation is a real selector, firing on `Edit` and `Write` and not on `Read`.
- **A read costs nothing, because a read never reaches it.** The zero-socket path is now the matcher itself rather than a rule file. A turn doing fifty `Read`s opens zero sockets because fifty `Read`s never match.
- **The reply carries no decision.** `CaptureAck` (`approval.rs:102`) exists so the helper's blocking read returns and the write may proceed. It stays a JSON line rather than a bare newline so a reader can still tell an answer from a hang-up.
- **Capture is fail-open**, inverting the gate's rule deliberately. A capture that cannot reach Tori has lost a diff; denying instead would be Tori gating by the back door on the one path meant to have stopped.
- **The hook identifies itself and nothing else.** `hook_output()` (`approval.rs:134`) prints `{"toriApproval": true}` - see [[lesson_identify_your_own_hook_rather_than_inferring_it]] and [[gotcha_hook_name_reports_the_tool_not_the_configured_matcher]].

## Why it's this way

**Emitting no `permissionDecision` is the whole point, and it is structural.** Measured on claude 2.1.231, *any* `permissionDecision` ends the permission chain at the hook. An always-allow helper therefore suppresses the harness's own question for precisely the write tools this design means to hand over. A helper that exits 0 emitting no decision lets the chain continue and still runs, which is all the snapshot needs.

**Emitting nothing at all is also chain-safe, and it is what phase 2 shipped - which was a silent bug.** With no output there is no marker, so `tori_owned` was always false and a Tori hook row could never be attributed. Measured on claude 2.1.232 (`dev/protocol-probe.mjs`, scenario `hook-matcher`): an output carrying **only unknown keys** leaves the chain running, the `Write` still raises `can_use_tool`, and the string comes back verbatim in `hook_response.output`. So the marker rides along for free. A Rust test replays the committed capture and asserts the CLI echoed exactly what `hook_output()` produces, so the two halves cannot drift. See [[gotcha_a_pretooluse_hook_printing_only_unknown_keys_does_not_end_the_permission_chain]].

**The file still owns `DECIDE_TIMEOUT_SECS`, and that is not a leftover.** 110 seconds, inside the `HOOK_TIMEOUT_SECS = 120` declared to the CLI (`approval.rs:76`). The deadline no longer belongs to the hook at all; it is what **both** transports honour for an in-protocol permission question, because measured in phase 1 the CLI has none of its own - an unanswered `can_use_tool` was still outstanding after 413s. The module keeps the name `approval.rs` for that reason.

**The bridge stopped being a per-session thread.** `SessionBridge` used to spawn a liveness-stamp refresher for the life of every chat. Nothing needs a stamp now, so the thread and its shutdown race are gone. `ApprovalServer` is `CaptureServer`: it has no decisions left to carry.

**A stale click stays silent.** With one waiter left there is nothing to route between, so a `request_id` the transport disclaims returns `Ok(())` rather than an error. A prompt timing out a moment before the click landed is a routine race, and an error toast would report a fault where there is only a stale button.

## What rides it now

One thing: **before-state capture** for inline diffs and for [[concept_diff_as_transcript]]. It used to be four, which is why [[concept_harness_capability_tiers]] published `hooks` as a single flag. Per-tool approval moved to the harness, Tori-owned rules were deleted outright, and spend ceilings moved to the turn boundary ([[concept_spend_ceilings]]) - so the single flag became three keys that answer differently, and the fourth question stopped existing.

The capture is also **no longer the only way to a before-state.** `snapshot::store_text` (`snapshot.rs:129`) hashes text straight into the same git object store `capture` writes to, so an ACP agent that sends the file's prior text with its tool call produces the same card. See [[concept_acp_agent_quirks]].

## One session kind will get a gate again, and it is not this one (2026-09-23)

Not built: gettori/tori#203 plans a refusal point for sessions flagged `background`, whose harness prompt is on nobody's screen. It sits on Tori's own outward tools rather than on this hook, so the capture stays decision free and fail open exactly as described above. See [[adr_a_background_session_needs_a_tori_gate]].

## Related

- [[concept_askpass_bridge]] - the socket-bridge pattern this reuses
- [[component_chat_host]] - where the capture is wired into the session lifecycle
- [[component_claude_hooks_status]] - the other, older `--settings` injection, which reports session status and is a separate mechanism
- [[concept_harness_capability_tiers]] - where what rides this is published
- [[gotcha_hook_name_reports_the_tool_not_the_configured_matcher]]
- [[gotcha_a_pretooluse_hook_printing_only_unknown_keys_does_not_end_the_permission_chain]]
- [[adr_a_background_session_needs_a_tori_gate]] - the planned exception for background sessions, which deliberately does not ride this hook
