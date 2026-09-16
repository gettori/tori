---
summary: Sway caches harness state keyed on (agent, account); catalogFor never falls back to default while profileSignedOut does
status: current
updated: 2026-09-05
source: "plan \"Multi-account: pick, lock and default an account per session\" (personal/sway, branch `multiaccount`), phases 2 to 4; `src-tauri/src/catalog_probe.rs`, `src/utils/modelCatalog.ts`, `src/utils/agentHealth.ts`"
---

# The account is half the key

Everything Sway remembers about an agent is remembered per **(agent, account)**, not per agent: the model catalogue, the probe lock, the sign-in answer, the transcript root, the spawn environment, and the project's remembered pick. An account is a login of one binary, and two logins can sit on different plans, offer different models and answer `whoami` differently, so an answer filed under the agent alone is whichever account happened to answer last.

## How it works

- **The catalogue file** is `{agent}.json` for the default account and `{agent}__{profile}.json` for an added one (`catalog_probe.rs`). The default keeps the bare name, so nothing already cached is orphaned. `ModelCatalog` carries `profile_id` beside `agent_id`, and `load_from` checks the record names the pair it was asked for, degrading to never-probed when it does not: `sanitize_segment` can produce `__` from either id, so two pairs can reach one path, and a re-probe is cheaper than serving one account the other's models.
- **The probe locks** are keyed on the pair. An agent-wide lock would make a re-check of one account queue behind another's 45 second timeout for nothing.
- **The frontend keys** on `catalogKey(agentId, profile)`, a space-joined pair, used by `catalogFor`, `isProbing`, `refreshCatalog` and the palette row's `key`.
- **The sweep** carries `profiles[]` per agent, one bounded `whoami` each, so `profileSignedOut(agent, profile)` answers without a subprocess per palette open.

## Why it's this way

Measured on 2026-09-05: the default account is on `max`, the `fonn` account on `team`, and the cached catalogue was whichever probed last, so the picker offered one account's models under the other's login. Three places leaked the wrong account even after the file was split: the probe's own env, the `whoami` behind a failure verdict (it asked with no home, so a Fonn failure was graded by the personal account's sign-in), and `user_configured_models`, which read the *process's* `CLAUDE_CONFIG_DIR` and credited the launching environment's pinned models to every account.

`catalogFor` deliberately does **not** fall back to the default account, while `profileSignedOut` does. The asymmetry is the point: ignorance about sign-in must not block, ignorance about models must not invent.

## Related

- [[component_catalog_probe]] - the module this keying lives in
- [[concept_one_directory_two_spellings]] - the same account has two names, and the crossings that keep it to one
- [[concept_naming_an_account_needs_two]] - when an account is worth naming on screen
- [[adr_account_is_session_identity]] - why a session is bound to one account
- [[gotcha_a_catalogue_keyed_per_account_has_no_row_for_an_account_added_this_run]]
