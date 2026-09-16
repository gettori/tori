---
summary: settling a pending ACP mode pick on any configOptions answer can drop it, a model answer landing first reports the old
status: current
updated: 2026-09-04
source: plan "Confirm an ACP mode or model switch from the agent's own answer" (personal/sway, branch `bugfix-260903`, issue 164, commit 1aedc0b), `src/panels/Chat/chatStore.ts` (`confirmMode`, the `configOptions` arm), `src-tauri/src/chat/acp_transport.rs` (`send`, `pending_mode`), [[concept_acp_config_options]], _2026-09-04_
---

# An ACP mode pick is staged until the next prompt, a model pick is answered at once

Do NOT settle a pending mode pick unconditionally on a `configOptions` answer or a repeated `sessionStarted`. Why: a model switch is sent at once and answered in order, while a mode switch waits in the transport's `pending_mode` for the next prompt, so a model answer that lands in between reports the *old* mode, and clearing `pendingMode` on it would drop a pick the transport is still going to send. `confirmMode` records the reported mode but clears the pick only on equality; a model pick may settle either way, and a dropped one takes `modelValue` with it. `noteMode`'s unconditional settle is right only at claude's turn boundary and the first `sessionStarted`.
