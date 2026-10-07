---
summary: ~/.local/bin holds the 200MB claude binary, so sniffing files there for a marker must read a bounded head
status: current
updated: 2026-10-08
source: "plan \"Shell command per Claude account\" (personal/tori, branch `phase-1-block-1`), self-review; `src-tauri/src/account_commands.rs` (`marked_by`)"
---

# ~/.local/bin holds the agent binaries

Do not `read_to_string` every file in `~/.local/bin` to look for a marker. Why: claude's installer puts its binary there, hundreds of megabytes, so a full read pays that on every sync. Open the file and read a fixed head (512 bytes is plenty for a shebang plus a marker line), then decode it lossily.

## Related

- [[component_account_commands]] - `marked_by` is the bounded read
