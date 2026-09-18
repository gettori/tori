---
summary: Tori adds harnesses like Codex and a generic ACP client rather than an LLM client, since the registry keeps the tax low
status: needs-verification
updated: 2026-08-14
source: not recorded; imported from grimoire docs/personal/tori; npm download counts measured 2026-08-13; codex-acp comparison run 2026-08-14
---

# Tori grows by supporting more harnesses, not by going deeper on attention

Tori drove only `claude`, which made it invisible to the largest single agent population and rested the entire product on one vendor's CLI. We chose to add harnesses (Claude first-class, one generic ACP client for the tail, then Codex) rather than spend the same weeks on cross-project attention routing and remote access, because harness breadth is table stakes among comparable tools while the presence layer Tori already ships is harness-agnostic and gains value from every harness added.

Measured 2026-08-13, npm downloads for the prior month: Codex 65.5M, Claude Code 48.0M, OpenCode 8.6M, Copilot CLI 6.7M, Gemini CLI 1.85M.

**Read those as name-scoped and therefore as floors.** An npm figure counts one package name, and packages in this ecosystem get renamed mid-window: `@zed-industries/claude-code-acp` was deprecated and renamed `@agentclientprotocol/claude-agent-acp` during this decision's own lifetime, so any count taken at either name alone undercounts the thing it is about. The ranking is what this decision rests on and the ranking is not in doubt; no individual figure here should be quoted as a total.

## Considered Options

- **Go deep on attention and reach instead** (rejected: a narrower market that keeps vendor risk concentrated, though it would have been one program rather than three). Tori's presence layer is already built and entirely harness-agnostic, so breadth compounds it rather than competing with it. Note that Conductor, Paseo and Pane all ship remote access, so that ground is not empty either.
- **Become an LLM client**, owning the transcript and calling provider APIs directly (rejected: moves billing off the user's own subscription, rebuilds an agent loop that already exists, and contradicts the standing "adds no endpoint of its own, proxies nothing" position). Conductor did not do this either: when it wanted provider breadth it added OpenCode as a harness.
- **A typed adapter per vendor for everything** (rejected: Paseo spends roughly 40k lines on five of them, and the tail does not repay that). One generic ACP client covers about thirty agents for the cost of a single module.

  **Tested against the strongest case and it held.** Codex was the one harness where a typed adapter had a real argument: it ships a native `codex app-server` protocol, Paseo drives it that way, and this project planned to as well. Both paths were driven through the same live turn on 2026-08-14, and the first-party ACP wrapper carried the permission prompt, the exact diff, the same four models and the same token-only usage - for one TOML file against ~6,900 lines of `[experimental]` generated bindings plus a second typed transport. Codex ships as `codex.toml`. What is given up is named rather than discovered: `thread/archive`, `thread/rollback`, `thread/fork` and `turn/steer`. Paseo is not counter-evidence: its adapter's first commit predates `codex-acp`'s first publish by three months, so it records what was available, not what was chosen.

## Consequences

- Every supported harness is a permanent maintenance tax rather than a one-time build. Each ships breaking changes on its own schedule, and `verified_against` pins go stale between them. **Corrected 2026-08-14: the tax is real but it is smaller than this assumed, and the reason is that the catalog is not hand-maintained.** Tori consumes the ACP Registry (`github.com/agentclientprotocol/registry`), a curated upstream that lists only agents supporting authentication, so a launch command going stale is upstream's problem and `dev/acp-catalog.mjs --check` says when it has moved. What stays taxable is a **measured** harness: the four-line TOML is nearly free, and re-verifying it against a new CLI version is not. The size of that half was measured on somebody else's repo rather than assumed - Paseo's typed Codex adapter carries 141 commits, three of them in the four days to 2026-08-13, for one vendor.
- ~~Feature parity is not achievable. Exact before-state diffs, hunk revert and spend ceilings all ride Claude's `PreToolUse` hook.~~ **Falsified 2026-08-14, one third at a time, and the shape of the conclusion changed with it.** *Diffs*: they do not ride the hook. `@agentclientprotocol/codex-acp` sends the file's prior text with the tool call and Tori stores it in the same object store, so the card is identical - but `opencode acp` sends none, which makes this vary **per agent** rather than per transport. *Spend ceilings*: they stopped riding the hook when they moved to the turn boundary, and the real limit is that ACP reports no money, only tokens and a context window. The native `codex app-server` reports the same, so it is the ecosystem rather than the wrapper. *Hunk revert*: unchanged, and now blocked on Tori's own rewind rather than on the protocol.
- Parity gaps are still real and still published, but the honest statement is narrower: a gap belongs to **a transport, or to one agent behind it**, and [[concept_harness_capability_tiers]] carries a per-affordance reason for each rather than one blanket cause. The blanket cause was wrong, and it was wrong in the direction that flatters the incumbent - it made Claude's mechanism sound load-bearing for things it did not carry.
- This becomes a third concurrent program alongside the eight-wave editor roadmap and the Kobalte design-system migration.
- Mid-conversation provider switching stays impossible and must never be implied in the UI. No comparable tool does it, because a session is pinned to one harness; only a product owning its own inference gateway can, and that is the LLM-client path rejected above.

## Related

- [[concept_transport_neutral_event_model]] - the seam that makes a second harness a module rather than a fork
- [[concept_harness_capability_tiers]] - where the per-harness gaps this creates are published
- [[component_acp_transport]] - the one generic client the third rejected option was weighed against
- [[component_acp_catalog]] - the curated upstream that shrank the maintenance tax
- [[concept_acp_agent_quirks]] - the per-agent variance this breadth buys
- [[adr_native_chat_surface]] - the decision this extends
