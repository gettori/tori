---
summary: cargo test rewrites the model.json fixture with different key ordering every run, revert the pure churn, do not fix it
status: current
updated: 2026-08-14
source: Defer permissions to the harness, and grow to four harnesses, phases 4, 6, 7 and 8 (personal/sway, branch `chat-fix`); `src-tauri/src/forge/model.rs:495`
---

# `cargo test` rewrites `dev/fixtures/forge/model.json` with different key ordering

Do NOT try to fix this in your branch, and do not commit it. A test at `src-tauri/src/forge/model.rs:495` generates the fixture, and the committed copy has its top-level keys sorted while a fresh run emits them in insertion order. Semantically identical, verified by deep-sorted comparison, so it is pure churn - but it lands in every run's diff and has to be reverted by hand. It happens on `main` too and has nothing to do with whatever you are working on. Hit in four consecutive phases before anyone wrote it down.
