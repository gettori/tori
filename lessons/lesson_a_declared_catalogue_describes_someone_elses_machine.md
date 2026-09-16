---
summary: an adapter table named fixed models with context windows wrong for the harness installed, so it was deleted outright
status: current
updated: 2026-08-21
source: plan "Model catalogues from the harnesses themselves" (phases 1, 2 and 6, branch `settings-and-chat`); `src-tauri/agents/claude.toml` (`[[chat.annotations]]`, formerly `[[chat.models]]`); `src-tauri/agents/codex.toml` (the "No `[[chat.models]]`" comment); commit "Show the models a harness actually named"
---

# A declared catalogue describes someone else's machine

Sway's adapters used to declare the models each harness could run. Four rows for claude, with context windows. The owner's verdict on that table was one sentence: **"it's a lie"**, and every measurement taken since agrees.

## What the table actually claimed

It said the same four models regardless of which CLI was installed on the machine, and it wrote **200k** for two models the harness reports running at **1M**. Both numbers were shipped, and the second was visible in the product: the same session rendered 200k in the composer and 1M in the status strip.

Then the ways it is per-machine rather than merely out of date:

- **A catalogue is per account.** `opencode acp` lists the providers *that user* has authenticated: 15 rows here, a different number for anyone else. Codex signed out returns seven models over its native app-server and four signed in. A bundled table is a guess about somebody else's entitlement.
- **A catalogue is per install.** The models a claude build offers are the build's, and the file in the repo is whatever was true when someone last edited it.
- **A user can add their own.** `~/.claude/settings.json` and `ANTHROPIC_*_MODEL` name models no catalogue anywhere lists.

## What replaced it

Ask the harness, cache the answer, show its provenance ([[component_catalog_probe]]). The picker's order became live > cache > nothing, with **nothing** as a real state that renders as "nobody has asked" rather than as an empty list.

The table did not survive in reduced form; `[[chat.models]]` became `[[chat.annotations]]`, and the rename was the design. An annotation **decorates a model a catalogue named** (fast mode, keyed by model id) and there was deliberately no code path turning one into a picker row. A test pinned that an annotated id no catalogue mentions renders nothing.

**Update, 2026-08-21: the annotation is gone too, so nothing survived after all.** Constraining the table to decorating removed the danger this page was written about and left a different one. Its single row was keyed `claude-opus-5`, the catalogue resolves both Opus rows to `claude-opus-5[1m]`, and so it decorated nothing, on every machine, from the day it was written. Nothing said so, because a fast-mode control that never renders is exactly what a model without a fast mode looks like. The `initialize` handshake publishes `supportsFastMode` per model and always did, so the row was restating a fact its own source ships. See [[lesson_a_restatement_matches_nothing_and_says_nothing]], which is what the closing question below turned out to be asking.

## The cost, accepted deliberately

A Claude session now shows **no context-window denominator until turn one completes**, because the only trustworthy window is the one the session reports. Declared windows were the pre-first-turn answer and two of three were wrong, so the honest interim is an absent number rather than a wrong one. The owner accepted that trade explicitly.

## The generalisation

Anything a config file states about a program on the user's machine is a claim about the author's machine at the time of writing. The question to ask of such a row is not "is it correct" but **"how would it announce itself once it stopped being correct"** - and a hardcoded model list has no way to. The annotation that replaced it answered worse: it had no way to announce itself even while being *joined* to nothing, which is the sequel above. Compare [[lesson_a_capability_measured_signed_out_is_not_the_users_capability]], which is the same failure with authentication as the variable.

Related: [[lesson_a_restatement_matches_nothing_and_says_nothing]], [[component_catalog_probe]], [[component_chat_model_resolver]], [[concept_no_turn_probe]], [[adr_harness_breadth]].
