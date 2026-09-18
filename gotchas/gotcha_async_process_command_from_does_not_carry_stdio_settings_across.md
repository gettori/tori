---
summary: converting a std::process::Command with pipes set via async_process::Command::from drops the stdio settings
status: current
updated: 2026-08-14
source: Defer permissions to the harness, and grow to four harnesses, phase 4 (personal/tori, branch `chat-fix`); `src-tauri/src/chat/acp_transport.rs`; [[component_acp_transport]]
---

# `async_process::Command::from` does not carry stdio settings across

Do NOT configure piping on a `std::process::Command` and then convert it with `async_process::Command::from(std_cmd)`: the stdio settings are silently dropped and the child comes up with inherited stdio and no pipes. Set them on the **converted** command. Why it costs an afternoon: the failure surfaces far downstream as `the agent gave no stdin`, which points nowhere near the conversion. The SDK's own `spawn_process` does it in the right order, and that is the only hint available.
