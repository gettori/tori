---
summary: a fresh brew rustup defaults to a toolchain too old for Tauri 2; rust-toolchain.toml now pins it, run rustup toolchain install
status: current
updated: 2026-10-06
source: Tori build plan (personal/tori); Phase 0 setup; pin from PR #257, rust-toolchain.toml
---

# brew rustup ships an old default toolchain

Do NOT build Tauri 2 right after `brew install rustup` + `rustup-init`; run `rustup update stable` first. Why: the bootstrap installed Rust 1.75 (late 2023), which is too old for Tauri 2 (needs >= 1.77); the build fails until the stable toolchain is updated (1.96 worked).

Since #257 `rust-toolchain.toml` pins the version (1.98.1), so `rustup toolchain install` once in the repo fetches the right one.

## Related

- [[component_check_script]]
