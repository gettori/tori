---
summary: a Rust test temp file keyed only on process id is shared by every test in one cargo run, parallel tests race and fail
status: current
updated: 2026-07-20
source: Editor upgrades (personal/tori, phase 3, observed not introduced); `src-tauri/src/settings.rs` (`tmp_file`)
---

# Rust tests sharing a temp path keyed only on process id race each other

Do NOT key a test's temp file on `std::process::id()` alone. Every test in one `cargo test` run shares that pid, so tests in the same module race over a single path: they write, read, and delete the same file concurrently, and each passes alone while failing together. This bit `settings.rs`, where `settings::tests::partial_file_fills_missing_sections` failed on every parallel run and passed in isolation, which reads as flakiness rather than a bug. Add nanos and an atomic counter, as `checkpoint.rs` and `git.rs` already do (`format!("..._{n}_{seq}")`). Fixed in `settings.rs`; the pattern is the thing to remember.
