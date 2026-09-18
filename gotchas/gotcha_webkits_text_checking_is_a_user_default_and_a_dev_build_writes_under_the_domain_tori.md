---
summary: WebKit spell check and dash substitution are NSUserDefaults not attributes, a dev build writes them under domain tori
status: current
updated: 2026-09-07
source: plan "Chat composer Tier 1" (personal/tori, branch `composer-260907`), phase 1 . `src-tauri/src/lib.rs:92` . commit `face7c4` . _2026-09-07_
---

# WebKit's text checking is a user default, and a dev build writes under the domain `tori`

Do NOT reach for `spellcheck` alone, and do NOT look for the flags under `com.skarif.tori.dev`. Why: continuous spell check and the smart dash, quote and text substitutions are WebKit **NSUserDefaults**, not element attributes, so `--` becomes an em dash in a prompt however the textarea is marked up; and an unbundled `tauri dev` binary has no bundle identifier, so the domain is the process name (`defaults read tori WebContinuousSpellCheckingEnabled`) while the bundled app uses `com.skarif.tori`. Write them into the **persistent** domain before the builder runs, never the registration domain, which WebKit registers its own values over.
