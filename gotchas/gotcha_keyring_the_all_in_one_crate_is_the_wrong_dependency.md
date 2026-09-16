---
summary: the keyring crate is a facade since v4, link keyring-core plus apple-native-keyring-store with the keychain feature
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phase 2; `src-tauri/Cargo.toml:41`, `src-tauri/src/forge/token.rs:19`; commit e73cf00"
---

# `keyring` the all-in-one crate is the wrong dependency

Don't add `keyring` for the token store. Why: since v4 it is a facade whose credential stores must be linked separately, so the working pair is `keyring-core` plus `apple-native-keyring-store` with the `keychain` feature (the login keychain, which a desktop app shares with the user's other credentials, not `protected`). Note the service name `com.sway.forge.github` is stable on purpose: changing it orphans every token already stored.
