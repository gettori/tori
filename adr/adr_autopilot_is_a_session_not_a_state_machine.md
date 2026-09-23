---
summary: judgment lives in a spawned chat session, mechanics in rust behind tools, so the watcher never spends tokens
status: current
updated: 2026-09-24
source: "design conversation 2026-09-23 captured in gettori/tori#194; ticket gettori/tori#195; hard lock from the #201 design 2026-09-24; implemented by gettori/tori#205 and #206; no code yet, decision precedes first implementation"
---

# The autopilot is a session, and Rust is the machinery under it

**The autopilot's judgment lives in an ordinary chat session Tori spawns with a fixed brief, and its mechanics live in Rust behind tools that session calls.** Reading a ticket, writing a brief and deciding what is worth telling the user are things a model does. Watching worker sessions, creating worktrees and calling the forge are things Rust does. The dividing line is the one that keeps the cost down: the Rust watcher subscribes to Tori's own events and spends no tokens at all, and it wakes the session only when something actionable happened.

## Considered Options

- **A Rust orchestrator that calls the model only for text** (rejected): a state machine in Rust owns the queue and the transitions, and reaches for a model only to write a sentence. It is genuinely cheaper per wake, because nothing has to carry a conversation. It loses on what it leaves behind. The user still wants a cockpit to talk to, so a chat session gets bolted on anyway, and once it exists the state machine is duplicating the judgment that session is already capable of. After that every change in behaviour is a Rust change and a rebuild, where the same change in a brief is an edit to a text file.
- **One session that does its own watching** (rejected): the session polls for what its workers are doing. Every poll is a turn, so idleness costs money, and the cost grows with the number of workers rather than with the amount of work. A watcher that spends nothing while nothing happens is the whole point.
- **A session for judgment with Rust underneath** (chosen): the model is woken, never polled.

## Consequences

- **A Tori spawned session is the exception [[adr_draft_first_chat]] did not have.** That decision says no harness process starts until the first send, because the user's first message is what mints the session. The autopilot has no user first message: Tori spawns it with the brief as the first prompt. The rule still holds for every session a person opens.
- **Workers are ordinary sessions, not subagents of the autopilot.** [[concept_subagent_lanes]] measured why: a subagent is observable and not addressable, so only the agent that launched one can message it. An autopilot whose workers were subagents could watch them and could not steer them. Ordinary sessions can be steered, and the moment the autopilot stops, every worker is already a session the user can pick up as is, with nothing to convert.
- **An in-flight worker is locked while the autopilot is on.** The user cannot type into it or close it, and taking one over means stopping the autopilot, which releases every worker at once. The rejected alternative was typing to take a single worker over, with a per worker paused state and a hand back. The lock keeps one driver per session at any time, so the autopilot never steers a session the user is halfway through, and there is no paused state for the watcher to reconcile. Decided in the #201 design, amending #194 and #209.
- **The autopilot binds an account and a model at spawn like any session.** [[adr_account_is_session_identity]] applies unchanged, so the autopilot is picked from the same agent and catalogue machinery every other session uses rather than getting a path of its own.
- **Waking is a steer, not a new channel.** The watcher writes one compact line into the session, which is the mechanism [[concept_mid_turn_steer]] already built for reaching a running turn. A worker's transcript never travels: the wake names the item, what happened and the session id, and the autopilot reads the rest itself if it decides to.
- **The watcher reads Tori's events, never the forge on a timer.** [[concept_forge_rate_budget]] is why: the poll layer is already shaped to one batched call per project per tick, never one per branch unit, and a watcher asking per worker would break that shape. Checks and reviews arrive as events on the same subscription as everything else.
- **Spend ceilings still work, because they never needed a tool gate.** [[concept_spend_ceilings]] is enforced at the turn boundary, with Tori declining to open the next turn, so an autopilot session is bounded the same way a hand driven one is.
- **Behaviour lives in a resource, not in Rust.** The brief is a file, which is what makes the autopilot's etiquette iterable without a release.

## Related

- [[adr_draft_first_chat]] - the rule this carves an exception out of, no process until first send
- [[concept_subagent_lanes]] - the measured reason workers are sessions rather than subagents
- [[component_chat_host]] - what actually spawns the session and owns its identity
- [[concept_mid_turn_steer]] - the verb the watcher wakes it with
- [[concept_spend_ceilings]] - the ceiling that still applies, at the turn boundary
- [[adr_one_protocol_several_fronts]] - the protocol its tools reach Tori through
- [[adr_a_background_session_needs_a_tori_gate]] - what it may not do without asking first
- [[adr_a_workers_questions_bubble_up_to_its_spawner]]: how a worker's questions reach the session that spawned it
