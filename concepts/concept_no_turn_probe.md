---
summary: probing a harness for its model catalogue is free for claude at initialize but always opens a session for an ACP agent
status: current
updated: 2026-08-21
source: plan "Model catalogues from the harnesses themselves" (phases 1 and 3, branch `settings-and-chat`); `src-tauri/src/catalog_probe.rs` (module doc, `probe_cwd`, `probe_acp`); `src-tauri/src/chat/acp_sessions.rs` (`adopt`); measured against claude 2.1.231, `opencode acp` 1.18.3, `@agentclientprotocol/codex-acp` 1.2.0; the per-model sweep from plan "The composer offers every lever the agent published" (phase 3, branch `unified-chat`, commit 462d734)
---

# Asking a harness what it can run, without spending a turn

Sway shows no model it was not told about, which means it has to ask. Asking means starting the harness's own binary, and the whole design question is what that costs the user: tokens, a session in their history, a process left running.

**The claim shipped is "a probe submits no turn", and the first draft said "token-free or it does not ship".** The weakening is the interesting part, and it is written into the module doc rather than quietly dropped.

## Why the strong claim could not survive ACP

- **claude `stream-json` is free by construction.** The `initialize` control response carries the whole catalogue - models, resolved ids, effort levels, `supportsAutoMode`, the account - and it arrives **before any session exists**. Spawn, handshake, read, kill. Measured ~1.6s, and no jsonl appears under `~/.claude/projects`, which the live test asserts by counting files rather than by arguing.
- **ACP cannot do that.** There is no `initialize` catalogue: models, modes and config options are part of the `session/new` answer. To learn what an agent offers you must open a session on it, and the spec's `session/close` "frees resources" rather than deleting the record. So a probe leaves something behind on the agent's side, and no amount of wording changes that.

## What the weaker promise actually buys

1. **No `session/prompt` anywhere in the probe's code path.** Not "we avoid calling it": there is no call to avoid. A turn cannot be submitted by code that contains no way to submit one.
2. **One session, in a directory that is nobody's project.** `probe_cwd()` is a single constant path under the data dir, created on demand and canonicalized with the same helper `accounts.rs` uses.
3. **`session/close` when the agent advertises `sessionCapabilities.close`**, and silence when it does not. Best effort on top, never the hygiene story itself.

**The probe writes as well as reads, and the promise still holds.** Since the per-model sweep ([[component_catalog_probe]]), the ACP arm sends one `session/set_config_option` per model inside that session, because one `session/new` answer describes one model ([[concept_acp_config_options]]). That is a mutation, so "read-only" was never the claim; **"submits no turn" is**, and a config switch is not a turn. It costs nothing measurable either: handshake plus `session/new` alone is 4.4s on OpenCode and the same probe plus eight switches is 4.3s.

What it does leave behind is a session whose recorded config is the *last* model swept rather than the agent's default. That lands in the same discarded scratch session the whole mechanism already accounts for: it is closed immediately, it lives in the constant probe directory, and the two ignored hygiene tests (`a_probe_leaves_nothing_in_the_history_sway_would_adopt`, `a_codex_probe_is_not_adopted_into_the_history_a_chat_lists`) still pass. The catalogue's own `current` values are read from the **opening** answer, so nothing downstream describes the post-sweep state.

## Phantom hygiene is a directory, not a list of ids

The obvious alternative was to remember the session ids the probe created and filter those out of history. Rejected: a crashed probe records no id, and a build that predates the list leaves rows nothing would recognise. **A directory is recognisable forever with no bookkeeping.**

The filter lives inside `acp_sessions::adopt` itself, as a `probe_cwds: &[String]` parameter, so no future caller can forget it. The slice rather than a path keeps `adopt` pure - the caller resolves the spellings against the filesystem and `adopt` only compares - and **both spellings are passed** because macOS hands out `/var/...` while agents record `/private/var/...` ([[concept_one_directory_two_spellings]]).

Measured 2026-08-17: Codex answers `session/list` and **scopes it to the asking session's cwd**, so a probe session is out of a user's history twice over. That is reassuring rather than load-bearing: the agent's scoping is the agent's to change, the filter is Sway's.

## A deadline, not an expectation

`PROBE_DEADLINE` is 45s: a ceiling for the unmeasured harnesses, not a guess at how long this takes. The measured numbers are ~1.6s for claude, ~1s for Codex, and about 5s for opencode's three live tests together. A hung child lands in `failed(timedOut)` and never wedges anything.

## Related

- [[component_catalog_probe]] — the module this describes
- [[concept_acp_session_locator]] — the history a probe session must stay out of
- [[concept_one_directory_two_spellings]] — why two cwd strings are compared
- [[concept_acp_config_options]] — what the ACP probe is actually reading
- [[lesson_probe_the_capability_before_building_its_control]] — the same discipline, one layer up
