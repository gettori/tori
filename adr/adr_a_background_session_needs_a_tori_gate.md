---
summary: a background session refuses an outward action without an approval ask_user issued; Tori pre-allows only its own tools
status: current
updated: 2026-09-26
source: "design conversation 2026-09-23 captured in gettori/tori#194; ticket gettori/tori#195; implemented by gettori/tori#203; narrows the decision recorded as `tori-harness-owns-permissions` (plan \"Defer permissions to the harness, and grow to four harnesses\", branch `chat-fix`, 2026-08-13); the pre-allow narrowing from plan \"tori mcp\" on branch orchestrator, commit cee102ec; the gate itself from plan \"Approval gate for background sessions\" on branch orchestrator, src-tauri/src/rpc/approvals.rs and rpc/methods.rs (outward); review pin from gettori/tori#208, commit b25293df; device approval from gettori/tori#215 plan \"Mobile app, chat only\" on branch orchestrator, src-tauri/src/rpc/asks.rs (`By::Device`) and rpc/methods.rs (`answered_by`)"
---

# A background session's outward actions need an approval Tori issued

**For a session flagged `background`, an action that leaves the machine refuses unless it carries an approval that `ask_user` issued. Every other session is untouched.** The autopilot and the workers it spawns run where nobody is looking, so the thing that normally authorises an outward action is not on anyone's screen. This is the only place Tori decides a tool call, and it is scoped to the flag.

## The rule this narrows, stated

The decision recorded as `tori-harness-owns-permissions` (2026-08-13) is that **Tori decides no tool call, in any mode, for any agent**. It is cited by five pages and written out by none, so it is written out here.

Tori used to gate. Between 2026-07-29 and 2026-08-14 an injected `PreToolUse` hook matched every tool, consulted a Tori owned rule file, opened a socket and answered allow or deny. It was built because it was the only authority available: measured on claude 2.1.220, a permission prompt fires when a dialog would be shown and headless `-p` has none, while `PreToolUse` runs first in the permission chain and its deny applies even under `bypassPermissions`.

Two things retired it. On claude 2.1.231 the CLI gained `--permission-prompt-tool stdio`, which makes it ask in protocol with a `can_use_tool` request Tori can render, so the user sees the harness's own question. And the hook turned out to be incompatible with that: a `PreToolUse` allow short circuits the rest of the chain, so a hook that answers every tool means the agent is never reached and never asks. Measured three ways in `dev/protocol-probe.mjs`. The two cannot both be live for one call, and the hook wins, so keeping the hook meant suppressing the real prompt.

What was left is a capture and only a capture, deliberately fail open, because whatever goes wrong the agent is still going to ask, and denying there would be Tori gating by the back door on the one path built to have stopped. See [[concept_pretooluse_capture_hook]], [[component_chat_host]] and [[component_acp_transport]].

The unstated premise in all of it is that **the harness prompt is on your screen**. A second gate is redundant when the first one is visible, and worse than redundant when it suppresses it.

## A second narrowing: Tori's own tools are pre-allowed

Every Tori launched claude session, foreground included, carries `permissions.allow: ["mcp__tori__*"]` in the settings Tori already injects, so the tools of `tori mcp` ([[component_tori_mcp]]) never raise a prompt. This decides tool calls, so it is a narrowing of `tori-harness-owns-permissions`, recorded here as one. It stays inside the rule's spirit for three reasons: it uses the harness's own rule mechanism rather than a hook, the user's deny rules still outrank it under claude's precedence, and it ends no permission chain for any other tool. The ACP agents that get the server (codex, opencode) raised no permission request for an MCP call in their default mode, so nothing is written for them. **Amended by #203: the outward tools are the exception.** A row marked `outward` in the socket's method table (`pr.create`, `review.submit`, `pr.merge` today) is pre-allowed only in a background session, where Tori's own gate decides it: that session's settings carry `mcp__tori__*`. A foreground session's settings name every other Tori tool one by one and leave the outward ones to the harness, so opening, reviewing or merging raises the same prompt `gh` would. The earlier rejection of a background only variant held while every tool was a read or a coordination call; an outward tool pre-allowed everywhere would let a foreground agent merge with no prompt at all. The background flag reaches the settings because it is decided at spawn: `chat_spawn` takes it and marks the session before the child starts, a session spawned by a background session inherits it, and the tab restore record carries it into every resume.

## Why it stops holding in the background

The autopilot runs with nobody watching its chat. Its harness prompt either blocks a session nobody is looking at, so the work stalls silently, or it is auto approved by the session's permission mode, so a pull request opens with no human in the loop. Neither is a person deciding. The premise the rule rests on is simply absent, so the rule's conclusion does not carry.

## Considered Options

- **Leave the rule untouched and rely on the harness prompt** (rejected): the harness will ask, and in a background session the question either blocks invisibly or is answered by the mode. The failure is silent in both directions, which is the worst property an authority can have.
- **Gate every session again, not just background ones** (rejected): this is the 2026-08-13 decision reopened, and it fails for the reason it failed the first time. A Tori gate that answers a tool call short circuits the permission chain, so the harness never asks, and the user loses the prompt they can actually see in favour of one Tori reimplements. It also throws away the harness breadth argument, since every new harness would need its gate ported.
- **A gate scoped to the `background` flag** (chosen): the narrowest thing that covers the case, and the only sessions affected are ones a person is by definition not watching.

## Consequences

- **This does not reopen `tori-harness-owns-permissions` for ordinary sessions.** A session you opened keeps the old rule exactly: Tori renders the harness's question and decides nothing. The capture hook stays decision free and fail open. [[adr_askuserquestion_answer_channel]] narrowed the same rule once before without reopening it, and this follows that shape.
- **Outward is a rule, not a list.** An action is outward when its effect is visible outside this machine, on something other people read. Today that set is opening a pull request, submitting a review, merging, and moving an issue's status. A sixth member is covered by the rule the day it exists, and nothing here has to be amended to include it.
- **The approval is a capability, not a mood.** `ask_user` issues an id bound to the session, the action and the target, and it is spent once. An approval to open a pull request on one branch cannot open one on another, and it cannot be replayed. That binding is what makes "authority is explicit, never inferred" checkable rather than aspirational.
- **The refusal has to name what is missing.** A background session that gets a bare denial has no way to tell a policy refusal from a broken tool, and its next move is to retry. The error says which approval it needed.
- **It partly reverses the reasoning in [[concept_spend_ceilings]].** That page records that the spend gate stopped being available because Tori stopped deciding tool calls at all, so there was no call left to refuse. There is one again, for background sessions. This decision does not revive spend ceilings on it: ceilings are enforced at the turn boundary and that still works, and widening this gate to cost would make it a general permission layer by increments.
- **The user sees the draft, not just the question.** An approval to post something is only meaningful if what will be posted is on screen, so the question carries the pull request title and body, or the review verdict and its comments.
- **The approval binds the draft, not only the target.** The outward call is refused unless its title, body, verdict, comments or merge head match what was approved exactly, a merge is pinned to its head commit, which the host enforces, and a review to the head it was drawn against ([[adr_review_submit_pins_the_reviewed_head]]). Only the user settles an approval ask: `ask.answer` from any socket caller is refused on one, so neither a spawner nor a session reaching the socket through `rpc.json` can approve its own post. A paired device is the one socket caller that counts as the user (see the amendment below).
- **Amended 2026-09-26 (#215): a paired device settles an approval.** `ask.answer` from a `Device` principal answers as `By::Device`, which the asks store treats like the card; every other socket caller is still `By::Socket` and refused. A device is a person on the remote front ([[component_remote_front]]), and the autopilot's holds are what a phone most needs to unblock. The draft rule holds on the phone too: `session.pending` hands a hold's whole draft to the device, and the app must render it before an approve. A lost phone is contained by revoking it, which closes its connections at once ([[concept_device_pairing]]). One path this opens: a session that makes itself `Local` (the `env -u` route below) can `device.mint`, connect to the front and approve its own post, and the approval then looks like the user's. Revoke cannot catch a device minted and used within seconds. It adds no outward reach that session lacks, since it could already run `gh` from its shell, and closing it means taking `device.mint` off `rpc.json` callers, its own decision.
- **Known gaps.** The gate covers Tori's own tools only. A background session can still run `gh pr create` or `curl` from its shell, and `env -u TORI_SOCK -u TORI_CALLER tori pr create` makes it an outside caller that is not gated. And a foreground ACP agent (codex, opencode) raises no permission request for an MCP call, so for those the foreground outward tools run unprompted. Closing either means taking credentials away from the session, which is its own decision.

## Related

- [[adr_review_submit_pins_the_reviewed_head]]: the review's own pin and the checks before its card
- [[concept_pretooluse_capture_hook]] - the page that records what the old gate was and why it was deleted
- [[component_chat_host]] - renders the harness's own permission question and decides nothing
- [[component_acp_transport]] - the same rule on the ACP side
- [[adr_harness_breadth]] - the reasoning that retired Tori owned permissions, and the cost of porting a gate per harness
- [[adr_askuserquestion_answer_channel]] - the earlier narrowing of the same rule, and the shape this follows
- [[concept_spend_ceilings]] - the enforcement point that died with the old gate, and stays dead here
- [[adr_autopilot_is_a_session_not_a_state_machine]] - the session this exists for
- [[adr_one_protocol_several_fronts]] - where the outward actions live as methods
- [[component_tori_mcp]]: the tools the second narrowing pre-allows
- [[adr_pr_create_pushes_the_approved_sha]]: the push that sits behind the same approval as the PR
