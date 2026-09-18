---
summary: git invokes GIT_ASKPASS once per field as a fresh process, so one fetch can spawn several helper runs to correlate
status: current
updated: 2026-07-10
source: Askpass credential bridge for backgrounded git (personal/tori, branch code-mirror-6); `src-tauri/src/askpass.rs`, `src-tauri/src/git.rs` (`git_command`); commit 3fff674
---

# git calls askpass once per field as separate processes

Do NOT model a credential prompt as one call per git op. git invokes `$GIT_ASKPASS` **once per field, each a fresh process**: `Username for '…'` then `Password for '…'` (SSH: `Enter passphrase for key '…'`). So one fetch = 2+ helper runs = 2+ dialogs, and the flow must be modeled **per-op, not per-prompt**: thread an `op_id` through env → helper → socket so sibling prompts correlate, and a **per-op cancel latch** makes cancelling one field (username) auto-empty the op's remaining fields so git aborts the whole op (no second dialog). Also run git under `LC_ALL=C` so the prompt wording is stable English and username-vs-secret classification (masked input) does not depend on the user's locale.
