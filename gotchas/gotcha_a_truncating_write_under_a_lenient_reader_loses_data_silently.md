---
summary: pairing a truncating fs write with a lenient reader turns a mid write crash into silent total data loss
status: current
updated: 2026-07-29
source: Chat surface plan, phase 10 (personal/sway, branch `chat`); `src-tauri/src/chat/ownership.rs:237` (`claims_are_replaced_by_rename_so_a_torn_write_cannot_empty_the_file`)
---

# A truncating write under a lenient reader loses data silently

Do NOT pair `std::fs::write` (which truncates in place) with a reader ending in `unwrap_or_default()`. A crash mid-write leaves a short file, and the lenient reader turns that into an empty map rather than an error, so total data loss is indistinguishable from "there was never anything here". For the claims file that meant every live session reading as unowned. Use the atomic shape (write temp, fsync temp, `rename`, fsync the directory); `chat/rules.rs`'s `write_atomically` is the one to call. The property is testable without a crash: `rename` swaps a directory entry, so a handle opened before the save still reads the old bytes, while a truncate rewrites the file that handle points at.
