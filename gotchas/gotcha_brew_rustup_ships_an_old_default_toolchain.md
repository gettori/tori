---
summary: a fresh brew rustup install defaults to a toolchain too old for Tauri 2, run rustup update stable first
status: current
updated: 2026-06-28
source: Tori build plan (personal/tori); Phase 0 setup
---

# brew rustup ships an old default toolchain

Do NOT build Tauri 2 right after `brew install rustup` + `rustup-init`; run `rustup update stable` first. Why: the bootstrap installed Rust 1.75 (late 2023), which is too old for Tauri 2 (needs >= 1.77); the build fails until the stable toolchain is updated (1.96 worked).
