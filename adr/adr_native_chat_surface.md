---
summary: native chat driving claude as a stream json process becomes the default way to open a session, PTY tab stays optional
status: needs-verification
updated: 2026-08-14
source: not recorded; imported from grimoire docs/personal/sway
---

# Native in-app chat is the default way to open a session

Sway drove agents only as a terminal TUI in a PTY tab, which meant every path, tool call and diff was pixels: unclickable, undiffable, and unattributable. We added a native chat tab that drives `claude` as a long-lived `stream-json` process and renders its structured output, and made it the surface a click on a sidebar session opens. The PTY agent tab, its `init` seeding, the split-button, the Ghostty button and [[concept_shell_hosted_tabs]] all stay and stay reachable; a setting restores PTY-as-default wholesale.

The decision rests on measurement rather than inference. The CLI's multi-turn behaviour, its control protocol, its hook semantics and its concurrency hazards were probed live before anything was built, and the results are recorded in [[concept_transport_neutral_event_model]] and [[concept_pretooluse_capture_hook]].

## Considered options

- **Keep the TUI and screen-scrape it.** Rejected: the PTY gives no tool ids, no file paths and no turn boundaries, so editor coupling and per-turn attribution would stay guesses. [[concept_needs_you_floor]] exists precisely because scraping only supports a guess.
- **Implement our own agent loop against the vendor API.** Rejected: it moves billing off the user's own subscription, and re-implements a harness that already exists and is already installed.
- **Replace the terminal.** Rejected. Running `claude` by hand stays supported, and the PTY tab remains the honest answer for a session already running outside Sway (see the routing fallback in [[component_chat_panel]]).

## Consequences

- **Several chats can run per worktree**, which invalidated three subsystems written when a tree had at most one live agent. Sweeping them was a required task, not a follow-up; the results and the one genuinely broken guard are in [[component_agent_adapter_registry]] and [[component_turn_checkpoints]].
- **Session identity has exactly one owner.** Concurrent `--resume` of one id was measured to corrupt the transcript silently, so a session live in a chat cannot be opened a second time inside Sway.
- **Claude only.** The event model is transport-neutral so a second harness is a module plus a TOML table, enforced by an exhaustive `match` rather than by assertion.
- **Sway adds no network path of its own.** The harness talks to its vendor exactly as it would from a terminal, under the user's own subscription. See [[lesson_privacy_claims_are_assertions_about_the_binary]].
