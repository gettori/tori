---
summary: the Rust tail test compares its committed golden JSON byte for byte, so *.golden.json stays on Oxfmt's ignore list
status: current
updated: 2026-10-06
source: plan "Tooling: one check everywhere, Vite+, formatters and linters", phase 4 (reformat), PR #257; src-tauri/src/chat/tail.rs:639; vite.config.ts:101
---

# Golden files are compared byte for byte

Do NOT format a `*.golden.json` file, or drop it from Oxfmt's `ignorePatterns`. Why: `chat/tail.rs` regenerates `historyTail.golden.json` and `assert_eq!`s it against the committed text, so a reformatted golden fails `cargo test` even though it parses the same. Regenerate one with `TORI_BLESS=1` instead.

## Related

- [[adr_vite_plus_toolchain]]
