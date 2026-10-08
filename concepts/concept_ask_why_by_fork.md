---
summary: a hunk's question opens a forked chat tab that sends it first; the panel tails the answer; ACP forks only if advertised
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1), phases ask-why-claude and ask-why-acp; commits f0282c7f, be057654; src/panels/Editor/HunkProvenance.tsx, src/panels/Terminal/Terminal.tsx, src-tauri/src/chat/acp_transport.rs"
---

# Ask why by fork

A question about a hunk goes to a fork of the session that wrote it, never to the session itself, so the original is not interrupted and never sees it.

## How it works

- **Spawn without a race.** `AskWhy` (`HunkProvenance.tsx:122`) mints a fork id and emits `ASK_WHY`. `Terminal.askWhy` (`Terminal.tsx:1798`) opens a chat tab with `forkFrom` on the origin's account, not focused, and `markAutoSend`s the seed, so the tab's own ChatView makes the one `chat_spawn` and sends once it can. Spawning from the panel would race that ChatView ([[gotcha_a_chat_view_on_a_rust_spawned_session_must_wait_for_its_first_turn]]). `background` is not set: it means unattended with gated approvals.
- **The seed** (`whySeed`) names the file and lines, the turn and its prompt, the calls, the hunk (capped at 120 lines) and a `Question:` line, and says there is no need to change files. The fork runs in the default mode for a fork tab.
- **Reading the answer.** The panel polls `ask_why_reply` every 1.5s. It reads the fork's transcript (claude) or mirror log (ACP) for the agent's text after the `Question:` line, and reports a fatal open error and whether anything has started. Done is the fork's `LiveChat.doneAt` plus a reply. It says when the fork waits on you, when nothing started after 30s, and gives up after 10 minutes pointing at the chat.
- **Who can be asked** (`canFork`, `HunkProvenance.tsx:112`): claude by its tier, any session including a terminal one, since the fork reads the transcript. An ACP agent only if its cached catalogue for that account says `fork`, read from `initialize`.
- **ACP fork** (`fork_session`, `acp_transport.rs:1442`): `session/fork` on the origin's locator, only on the fork's first start (no locator of its own yet), refused rather than opened empty when the agent cannot fork or lost the conversation. The crate is pinned `=2.0.0` with `unstable_session_fork`.

## Why it is this way

Asking in the live session would put the question in its context and wait for it to go idle; insert-only send has no answer to show under the hunk. A fork costs a context load but leaves the original alone.

Forking mid-turn is safe, measured on claude 2.1.285: a session whose Bash call was still open forked cleanly, the fork answered reading the call as interrupted, and the original finished its turn with nothing added to its transcript. Measured on `opencode acp`: it advertises fork and the fork recalls what its origin was told.

## Related

- [[component_provenance]] where the claim the box sits under comes from
- [[concept_rewind_by_fork]] the other fork, still claude only
- [[gotcha_claude_allowedtools_swallows_the_prompt]] met while measuring
- [[gotcha_the_claude_harness_blocks_a_bare_long_sleep]] met while measuring
