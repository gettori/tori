---
summary: quota windows come from a source ladder, passive harness events first, an account token read only as a per agent opt in
status: current
updated: 2026-09-06
source: Agent usage preview plan (personal/tori, branch `agent-usage`) . `src-tauri/src/chat/claude.rs` `map_rate_limit` . `dev/fixtures/claude/*.jsonl` `rate_limit_event` frames . CodexBar `docs/claude.md` and `docs/codex.md` as the surveyed alternative
---

# Usage is read from what the harness says, and reading an account token is a per-agent opt-in

Tori shows quota windows (5-hour, weekly, model-scoped) per (agent, account) in the titlebar. We decided the data comes from a **cumulative source ladder** declared per adapter: passive events the harness already emits (Claude's `rate_limit_event`, which carries `unifiedWindows` with utilization and reset per window) are always merged; a harness's own documented read path (Codex `app-server` with `account/rateLimits/read`) fills gaps while idle; and reading the account's OAuth token to call a usage endpoint exists only as an explicit **per-agent opt-in** that the user turns on knowing it triggers a Keychain prompt. The default never touches a credential, so the titlebar works on day one for every Claude account with a chat open, and the custody boundary in [[adr_credential_custody]] stays the default state rather than a rule with a silent hole in it.

The rung exists because it is the only route to the model-scoped weekly window and extra-usage figures; the passive frames carry only the two generic windows. It is not the default because the endpoint is undocumented, the token requires a scope the CLI is not guaranteed to hold, the Keychain item is owned by another program so macOS prompts in Tori's name, and Tori ships unsigned, so the allow decision binds to the exact binary rather than to the app. Measured 2026-09-06: a read from a binary the item's ACL does not know blocks on a dialog, Allow grants that one read, Always Allow silences later reads of the same build, and a rebuild at the same path asks again. The opt-in copy says so, because a prompt returning after an update reads as a bug otherwise.

## Considered Options

- **Keychain read as the default source** (CodexBar's shape): richest data with no chat open, rejected because it makes a foreign-credential read the price of a gauge, prompts every profile on first launch, and contradicts the custody boundary already decided.
- **PTY scrape of `/usage`**: rejected outright; it spawns a real session, writes transcripts into the user's history, and parses rendered text.
- **Direct `wham/usage` with the token in `~/.codex/auth.json`**: no prompt, rejected in favour of `app-server` because Tori would hold a token whose refresh it does not own; the CLI's protocol is documented and refreshes for us.
- **Probe turn** (a headless one-turn session to provoke the event): kept as a candidate rung behind a measurement, because it spends the quota it measures and provides nothing the passive rung lacks except a reading while idle.

## Amended 2026-09-06: the ladder is not a control, the chips are

The decision above is about **where readings come from** and it stands. What changed is everything the user touches. Shipped, there is no source setting: the ladder became an implementation detail derived from which windows an account shows.

- **Which windows an account puts in the titlebar is also how deep Tori reads for it.** Nothing lit means nothing is read; the two generic windows come off the cheapest declared rung; the model-scoped weekly window is the one thing only the account token can answer, so lighting that chip **is** the opt-in, and it is the only one. `usageRungFor` derives the rung and nothing stores it (`src/utils/usageSettings.ts:103`). The Keychain prompt now arrives when the user asks for the thing it buys, rather than minutes later on a tick.
- **The gate reads the stored chip, not the frontend.** `wants_model_window` (`src-tauri/src/settings.rs:595`) is what `usage_token.rs:216` consults before the vault is touched, so nothing enters the vault on the frontend's word. The one-file custody exemption and its two runtime tests are unchanged.
- **Everything usage-related is per account, not per agent.** A quota window belongs to a login, so the chips, the warn point and the notify switch all moved onto the account's own card, and one login asking for the token read cannot drag a second into a Keychain prompt it never asked for. See [[concept_quota_is_an_account_fact]].
- **"Every surface shows source and sample time" is weakened.** The store still records both on every reading, and the strip's accessible name still carries them, but the card shows one freshness stamp for the account rather than a rung and a clock per row. The rung is no longer a thing the user chose, so naming it on every row was explaining a control that no longer exists.
- **No history, and the probe rung does not ship.** Measured: a headless one-turn probe does return a full `rate_limit_event`, so the rung would work, and it was still rejected because it spends the quota it measures. The 7-day view and the snapshot ring behind it were built and then deleted, because Tori's samples record what Tori read while the window keeps moving with Tori shut. See [[lesson_history_of_what_you_only_sometimes_watch]].
- **The Keychain trust binds to the binary's contents.** The paragraph above said "binds to the exact binary rather than to the app", which is right; what the opt-in copy needs to add is that a rebuild at the same path asks again, so an unsigned build re-prompts after every update.

## Consequences

- Amends [[adr_credential_custody]]: the custody scan keeps every needle and exempts exactly **one file by name**, `src-tauri/src/usage_token.rs`. A static scan cannot say *when* code runs, so the exemption is paid for at runtime instead: `the_setting_is_the_gate` counts vault lookups and requires zero for every source but `token` and exactly one for that one, and `no_file_under_the_data_dir_holds_the_token` drives a read and then searches the snapshot store for the token. The scan's own test proves it still catches a second reader, so the exemption cannot quietly become a hole. The token is read into memory for the request and never written to disk, logged, or cached across launches.
- Adapter TOML declares which rungs it supports (schema v4). A rung the adapter does not declare is rendered greyed with its reason, never inferred from the binary.
- Every reading carries its source and sample time, and every surface shows them; a passive reading a day old must say so rather than pose as live.
- A window the source does not return is absent, not zero. A Pro account never shows an empty model-scoped bar.

## Related

- [[adr_credential_custody]] - the custody boundary this amends with one gated exception
- [[concept_transport_neutral_event_model]] - `ChatEvent::RateLimit` grows the utilization fields under the generated-fixture guard
- [[component_agent_adapter_registry]] - where the per-adapter `[usage]` table lives
- [[concept_spend_ceilings]] - Tori's own ceilings, which share the three-state vocabulary but not the source
- [[concept_quota_is_an_account_fact]] - the model the shipped implementation settled on, and where the chips replaced this ladder as a control
- [[component_usage_pipeline]] - the sources, store and scheduler this decision governs
- [[component_usage_strip]] - the surfaces that draw the result
- [[lesson_history_of_what_you_only_sometimes_watch]] - why the history this decision assumed was possible is not
