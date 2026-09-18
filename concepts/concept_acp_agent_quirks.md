---
summary: a running list of where real ACP agents disagree with the spec, so the client is built against measured behavior
status: current
updated: 2026-08-14
source: Defer permissions to the harness, and grow to four harnesses, phases 4 to 8 (personal/tori, branch `chat-fix`); spec `agentclientprotocol.com/protocol/*`; crate `agent-client-protocol` 2.0.0; measured against `opencode acp` 1.18.3, `@agentclientprotocol/claude-agent-acp` 0.67.0 (formerly `@zed-industries/claude-code-acp`) and `@agentclientprotocol/codex-acp` 1.2.0
---

# ACP agent quirks

ACP is one protocol with several independent implementations, and the gap between what the spec says and what a given agent does is where a generic client either works everywhere or works against exactly one binary. This page is that gap, written down before the client was, so the transport is built against measured behaviour rather than against the happy path. Every entry is marked **measured** (seen on the wire here), **documented** (a MUST/SHOULD in the spec that a naive client would still get wrong), or **reported** (a behaviour another implementation found and worked around, which Tori has not independently reproduced).

## How it works

### Session creation

- **Some agents refuse a non-empty `mcpServers`.** *(reported)* An adapter that does not itself speak MCP can fail `session/new` outright when the array is populated, rather than ignoring it. So the payload is empty by default and populated only for an agent whose adapter opts in. This is the first of the two per-agent overrides the transport must carry.
- **`cwd` and `mcpServers` are required even when empty.** *(reported)* Omitting either yields `Invalid params` from agents that validate strictly. They are sent unconditionally, never gated on a capability: an empty array is a value, an absent key is a protocol error.
- **`cwd` must be absolute.** *(documented)* It is also the base for relative paths for the life of the session.
- **`session/new` may answer `auth_required`.** *(documented)* This is a named error with a user-actionable meaning, not a spawn failure, and it is the only error code on this path worth branching on.
- **`additionalDirectories` is advertise-gated and non-cumulative.** *(documented)* Only send it when `sessionCapabilities.additionalDirectories` is advertised; on `load` and `resume` the full intended list must be re-sent, because omitting it does not restore the stored roots.

### Capabilities

- **Client capabilities are an offer, not a description.** *(documented)* `fs.readTextFile`, `fs.writeTextFile` and `terminal` say what the *client* will serve. Agents do their own I/O by default, so declining all three is a legitimate and complete configuration. Some agents behave better when a client serves them, which is the second per-agent override.
- **An advertised capability is not a promise of data.** *(measured)* `opencode acp` 1.18.3 advertised `sessionCapabilities.list` and returned zero rows against a store holding a session. Every protocol-derived list is therefore possibly empty, and an empty result is rendered as empty rather than as an error.
- **The crate's stability labels and the wire disagree.** *(measured)* Session fork is marked unstable in `agent-client-protocol` 2.0.0, yet both probed agents advertise `sessionCapabilities.fork`. Gate affordances on what arrives at `initialize`, never on the crate's label.
- **A listed session row carries four fields.** *(measured)* `sessionId`, `cwd`, `title`, `updatedAt`. No branch, no created-at, no agent id, and the title is the raw first prompt rather than a cleaned one.

### Lifecycle and timing

- **`initialize` can hang.** *(reported)* An agent that never answers leaves the client waiting forever, so the client owns a deadline here, the same shape as the Claude transport's own timer. This is the ACP echo of Phase 1's finding that the CLI has no deadline of its own.
- **Probing an agent can trigger interactive auth.** *(reported)* Gemini CLI opens a browser sign-in when probed for models or modes. `NO_BROWSER` suppresses it and is ignored by other agents, so it is safe to set unconditionally.
- **Vendor-extension notifications can arrive after `session/new`.** *(reported)* Slash-command catalogues in particular. Anything waiting on them needs a gate that is *settled* even when the batch is legitimately empty, or an agent with no commands blocks the reader for a full timeout.

### Turn semantics

- **Cancellation is a stop reason, not an error.** *(documented)* On `session/cancel` the agent MUST answer the original `session/prompt` with `cancelled`, and the client MUST answer every pending `session/request_permission` with the `cancelled` outcome. Clients SHOULD keep accepting `session/update` after cancelling, because final updates can still arrive. A client that treats the post-cancel window as closed loses the tail of the turn.
- **`refusal` drops the turn from history.** *(documented)* The user prompt and everything after it will not be in the next prompt, so the transcript has to say so rather than leaving it looking sent.
- **Permission options are the agent's vocabulary.** *(documented)* `session/request_permission` supplies `optionId` and `kind` per option. The client renders what the agent offered and echoes the chosen `optionId` back; it does not impose a fixed Allow/Deny pair. Same principle as Phase 1's `updatedPermissions` finding: the grammar belongs to the harness.
- **`messageId` can be null, and a change of it starts a new message.** *(documented)* A client keying assistant text on `messageId` needs a fallback identity for the null case, or every chunk collapses into one message.

### Configuration and turn shape (added 2026-08-14, phase 8)

- **An agent may ignore the user's own config and impose its own.** *(measured)* `@agentclientprotocol/codex-acp` 1.2.0 ignores `approval_policy` and `sandbox_mode` from `~/.codex/config.toml` - verified via `config/read`, which shows both set while the agent writes anyway - and applies its own `agent` mode, approving edits inside *and outside* the workspace silently. A client that assumes the user's config still governs will publish a permission tier nobody is actually getting. The only route to the user's intent is the mode config option ([[concept_acp_config_options]]).
- **A tool call's diff arrives on the call, and the completion carries nothing.** *(measured)* `codex-acp` sends the `{type: "diff", oldText, newText, path}` content block on the `tool_call` update while it is still `in_progress`, and the `tool_call_update` that completes it carries **no content at all**. Code that reads the completing frame for paths or diffs will run and find nothing, on the one agent it was written for. `oldText: null` means a creation, and the agent says so in `_meta.codex.kind: "add"`.
- **A client that declines `fs` may still be asked to write.** *(measured)* `opencode acp` sent `fs/write_text_file` with `readTextFile`, `writeTextFile` and `terminal` all declined at `initialize`. Refusing is safe - the agent falls back to writing the file itself, verified on disk - but the client must **answer**, since an unanswered request hangs the agent. The SDK's default handler does answer, which is why this went unnoticed for a phase.
- **`-32000` is `AuthRequired`, not a generic error.** *(measured)* Reading the raw JSON-RPC number off a probe and assuming the named constructor meant a different wire value produced a whole task's worth of work on a problem that did not exist. Branch on the named code.

### Extensibility

- **`_meta` is reserved and opaque.** *(documented)* Implementations MUST NOT assume anything about its keys, so it is carried, never branched on.

## Why it's this way

ACP's capability handshake is a *negotiation between peers*, not a feature list a client can trust, and the four measured items above are all instances of that: an agent advertises what it is willing to be asked, which is a weaker claim than what it will actually deliver. The design consequence for Tori is that every ACP affordance is gated twice, once on the advertisement and once on the result being non-empty, and that a gap between the two is reported as absence rather than as failure.

The two per-agent overrides (`mcpServers` and client capabilities) exist because they are the only places where a *correct* client can still be wrong for a *particular* agent: everything else is either fixed by the spec or discoverable at `initialize`. Keeping them to two, and naming them in the adapter TOML rather than in Rust, is what keeps `[[adr_harness_breadth]]`'s "a new harness is a TOML file" claim true.

The licensing boundary matters here: entries marked *(reported)* were learned from another implementation's behaviour and documentation as protocol facts and agent misbehaviours. No code or structure was taken. See the plan's Paseo decision.

## Related

- [[concept_harness_capability_tiers]] — where an ACP session's measured tier is published, including the affordances it cannot have
- [[adr_harness_breadth]] — the decision this list is the maintenance cost of
- [[concept_mcp_config_scopes]] — what Tori would be putting in `mcpServers` if an agent accepted one
- [[concept_capability_resolution]] — the same advertise-then-verify shape, one layer up
- [[concept_pretooluse_capture_hook]] — the Claude-only mechanism ACP replaces with in-protocol permissions
- [[component_acp_transport]] — the client every entry here is a constraint on
- [[concept_acp_config_options]] — the one verb behind every mid-session switch
- [[concept_acp_session_locator]] — the advertise-then-verify rule applied to history
