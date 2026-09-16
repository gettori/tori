---
summary: Settings Agents cards probe install, version and sign in per adapter with bounded spawns, unknown health reads ready
status: current
updated: 2026-09-06
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/sway, branch `topbar`); Phase 1; then \"Make a harness installable, signed in, and discoverable\" (personal/sway, branch `harness-lifecycle`); Phases 1 and 3"
---

# Agent health cards (Settings > Agents, first-run onboarding)

**Location:** `src-tauri/src/health.rs`, `src-tauri/src/onboarding.rs`, `src-tauri/src/auth.rs`, `src/utils/agentHealth.ts`, `src/panels/Settings/AgentsSection.tsx`

One card per adapter in Settings, answering the question a new user actually has: *which of my agents does this thing work with?* Per adapter it reports whether the CLI is installed, its version, whether the sessions directory exists, what Sway can do with it, and the override file path when a user TOML replaced a bundled definition.

## Responsibilities

- **Probe, per adapter** (`health.rs`): resolve the launch binary against the captured login PATH ([[concept_login_shell_path_capture]]), run `--version` and extract the first semver-looking token, stat the discovery dir, and report the capability flags. Results are memoized per app run and never block the UI.
- **Every spawn is bounded.** All three probes go through `env::output_with_timeout` (5s), which waits on a worker thread rather than polling `try_wait`: polling without draining stdout deadlocks on a child that outruns the pipe buffer, and a verbose-banner `--version` is exactly that case. stdin is `/dev/null` so a CLI that prompts hits EOF instead of blocking on a terminal it can never get.
- **Four outcomes, deliberately not three**: `not_found`, `version_match`, `version_drift`, `version_unknown`. `version_unknown` covers two distinct situations that the copy splits on: an agent that reports no version at all, and an agent that reports one Sway has no `verified_against` to compare it to.
- **First-run gate** (`onboarding.rs`): show the Agents view once, when a synchronous scan of every adapter's discovery dir finds zero sessions **and** a persisted flag is unset. The scan is synchronous by design, so there is no async scanner to race, and it reads real directories so a cold mtime cache cannot fake emptiness. The flag lives in a new `state.json`, not `settings.json`: the latter is hand-editable preference, and "have we shown this" is app state.

## The sweep became invalidatable, and grew a sign-in axis (2026-08-14)

**The lifetime `OnceLock` became wrong the moment install and login happened in-app**, so it is now a `HealthCache` that takes its sweep as a parameter (tested without a PATH, and tests own a local instance instead of racing the global one). It recovers from a poisoned lock rather than propagating, because a panicking probe should not leave the Agents panel broken until restart, and it deliberately holds the lock across the sweep so a queued caller waits for one sweep instead of starting a second. Probes stay bounded, per [[gotcha_a_subprocess_probe_inside_a_memoized_sweep_must_be_bounded]].

**That correctness fix silently made a piece of UI copy false.** The not-installed card said "Install `claude` and **reopen Sway** to pick it up", which was true only because the sweep was a lifetime memo. Nothing would have failed. Worth remembering as a shape: *a correctness fix can silently invalidate instructions written against the old limitation.* Now pinned by a test asserting the card no longer says "reopen Sway".

**Sign-in rides this sweep rather than getting a cache of its own.** The two questions are asked by the same screens at the same moments and invalidated by the same events, so a second cache would be a second thing to remember to invalidate and a second chance for the picker and the cards to disagree. Cost is one more bounded subprocess per adapter that declares a probe.

**Unknown health counts as ready**, and the asymmetry is the argument: a wrong yes costs one clear spawn failure, a wrong no makes a working harness unreachable with nothing on screen explaining why. `agentReady` says yes before the sweep lands, when it fails, and for an adapter with no row; it returns false only for a *definite* signed-out. Drift stays a warning: still ready, still offered, still starts.

**The health type moved to `src/utils/agentHealth.ts`** so the chat agent picker and the Settings cards read one answer and cannot disagree about what is installed.

## The catalogue half

Since "Model catalogues from the harnesses themselves" (branch `settings-and-chat`) each card also says **how many distinct models the harness named**, and the detail page lists them. That data is [[component_catalog_probe]]'s, not `health.rs`'s, and the two are deliberately different questions: health asks whether the binary is there, the probe asks what it can run.

- The card's count exists only where a probe answered. Never probed shows nothing (not "0 models"), a failure with no earlier answer shows "Error", and a failure *after* an answer keeps showing the old count.
- The section's **"Check models"** disables itself when nothing is due, rather than flashing and doing nothing.
- The detail page's button is **"Ask again", not "Check again"**: the one above it re-probes the binary, this one re-asks the harness what it can run, and two controls under one label are two actions with one name. An existing test caught the collision by finding two buttons with the same name.
- The Models section is gated on the harness declaring a `[chat]` table, so a terminal-only adapter does not get a heading, an "unasked" line and a button whose only outcome could be "Sway cannot ask this".
- Below the list: provenance ("Asked Claude 2.1.231, <date>"), the multi-account caveat when the harness named an account, a stale note when the recorded version is not the installed one, and a read-only preview of the harness's own options ([[concept_generic_config_mirror]]).

## Key files & entry points

- `src-tauri/src/health.rs` - `agent_health()`, the probes, the outcome enum.
- `src-tauri/src/env.rs` - `output_with_timeout`, the bounded-spawn primitive.
- `src-tauri/src/onboarding.rs` - `onboarding_should_show()`, `state.json`.
- `src/panels/Settings/AgentsSection.tsx:39` - the status-dot mapping (see the lesson below).

## Connections

- Built on [[concept_login_shell_path_capture]]; without it the cards would confidently misreport.
- Reads [[component_agent_adapter_registry]] for the adapter set, launch binaries, discovery dirs, and capabilities.
- Renders [[component_catalog_probe]]'s answers; opening Settings reads that cache and **never** probes.
- [[lesson_status_color_encodes_the_users_question]] came out of this component's status dot and is the most portable thing in it.

## Known gaps

- ~~Neither `claude.toml` nor `pi.toml` carries `verified_against`~~ **Closed 2026-08-14.** All four bundled adapters now carry one, so every adapter exercises the match/drift path. `codex.toml` carries two versions in one string (`codex-cli 0.147.0 with @agentclientprotocol/codex-acp 1.2.0`) because two binaries are involved, and `health.rs` reads the first semver-looking token, so the `codex-cli` version has to come first.
- The rendered cards and the once-only onboarding trigger were **never visually verified**; the data path is covered by 17 unit tests plus a real-machine dump.

## The sweep grew accounts, and the card grew controls (2026-09-05)

**Per-account sign-in rides the sweep.** `AgentHealth.profiles` carries a `ProfileHealth` per account (id, label, sign-in, account, api key source), one bounded `whoami` each, so `profileSignedOut(agent, profile)` answers without a subprocess per palette open and `agent_accounts` reads that cache instead of spawning `claude auth status` per profile on every Settings open. `status_of` lost its binary-path parameter entirely, so "no probe here" is structural rather than a comment.

**The accounts card is now the place an account is managed.** The name is the rename control (click it, type, Enter; Escape abandons), and the default account renames too: it has no stored record, so `accounts.json` carries its label in `default_labels` and the account itself stays the home variable left unset. Signing out asks first, and that dialog carries removal as a checkbox beside the profile home it would delete, which is why there is one icon control per row rather than two buttons. Adding is a `+` in the heading. A Default radio per row picks which account new sessions start on, and the row names that account's plan and model count from its own catalogue.

**Models are tabs, not blocks.** The detail page shows one account's list at a time, named by a lit tab beside the section rule, because a block per account down the page reads as repetition rather than as a choice.

Two traps this section paid for: the page keeps its **own** `createResource` copy of the sweep, so refreshing the shared store alone leaves it stale ([[gotcha_the_agents_page_holds_its_own_copy_of_the_health_sweep]]), and dropping the catalogue store without reading it back leaves every account reading "unknown" ([[gotcha_a_catalogue_keyed_per_account_has_no_row_for_an_account_added_this_run]]).

**Source:** plan "Multi-account: pick, lock and default an account per session" (personal/sway, branch `multiaccount`), phases 1 to 4 plus follow-on · commits `8e670fb`, `7b33143`, `6f9eb8f`, `ae1d87e` · `src-tauri/src/health.rs`, `src-tauri/src/accounts.rs`, `src/panels/Settings/panes/AgentsPane/`

## The account card also owns the quota controls (2026-09-06)

A quota window belongs to a login, so the controls for one moved onto the account rather than the agent, and the old per-agent Usage section (with `AgentUsage.tsx`) is gone. Each account card's body now carries a box per window Sway can name for that login (level, bar, when it empties), the titlebar-preview chips that decide which of them reach the strip **and** how deep Sway reads for it (`WindowChips`, `AgentAccounts.tsx:279`), a warn-at stepper that shows and follows Chat > Warn at until it is moved (:321), the notify switch, and the danger area.

Every card now arrives **collapsed**, the signed-in one included (:372). The head says who the account is, which is what the list is scanned for; the body is a screen of its own, and an install with three logins opened with three of them.

**Source:** Agent usage preview plan (personal/sway, branch `agent-usage`), phase 2 and the design pass after phase 5 . PR #169 . `src/panels/Settings/panes/AgentsPane/AgentAccounts.tsx`

## Related

- [[concept_quota_is_an_account_fact]] - why the quota controls live on the account and not on the agent
- [[component_usage_pipeline]] - what the chips authorise, and what fills the boxes
- [[component_usage_strip]] - the titlebar surface these chips feed
