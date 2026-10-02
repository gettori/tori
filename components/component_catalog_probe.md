---
summary: catalog probe asks a harness what it can run before any chat exists, caching one file per agent and account
status: current
updated: 2026-09-05
source: plan "Model catalogues from the harnesses themselves" (all six phases, branch `settings-and-chat`); cache shape stamp and the per-model ACP sweep from plan "The composer offers every lever the agent published" (phases 1 to 3, branch `unified-chat`, commits 88713c9 / 7b9522b / 462d734); commits "Ask each harness for its own model catalogue", "Show the models a harness actually named", "Ask Codex what it can run, and write down what it said"
---

# Catalogue probe

**Location:** `src-tauri/src/catalog_probe.rs`, `src/utils/modelCatalog.ts`, `src/panels/Settings/AgentsSection.tsx`, `src/panels/Settings/HarnessDetail.tsx`

Asks a harness what it can run, before any chat exists, and remembers the answer. It is what replaced the `[[chat.models]]` tables: every model, mode, effort level and option Tori shows now comes from the harness that offers it. See [[lesson_a_declared_catalogue_describes_someone_elses_machine]] for why the tables had to go.

The mechanism is [[concept_no_turn_probe]]. This page is the module: its shape, its states, and the three surfaces that read it.

## Responsibilities

- Spawn a harness's **chat** binary, drive its transport far enough to read the catalogue, tear it down.
- Cache one file per harness under the data dir. Derived state, deletable without losing settings.
- Answer `model_catalogs()` (read-only, **never probes**) and `refresh_model_catalog(id)` (probes one harness).
- Merge the user's own configured models from `~/.claude/settings.json`, marked as theirs rather than mixed in.
- **Not** its business: deciding what to render. Which rows already have a bespoke control is the surface's call.

## Three states, kept apart

`neverProbed` | `failed(reason)` | `probed(catalogue)`, and the separation is the point.

- **`neverProbed` is not an empty catalogue.** A harness nobody has asked renders as no count at all; "0 models" for a fresh install reads as a broken one. Gemini lives here permanently (nobody on this project has it installed) and there is a dom test saying what that should look like.
- **A failure never clears a good catalogue.** `catalogue` and `lastFailure` are separate fields, so a signed-out moment shows the previous list with the failure explained on the detail page. Stale-but-real beats fresh-but-empty.
- **`unsupported` is a fact about Tori, not the binary**, so no surface renders it as the harness failing.

## Staleness is two comparisons, never a TTL

A catalogue decays when the **binary** changes or when **Tori** starts reading a field the cache does not carry. Never with time.

**The binary.** Both unknown-version cases answer not stale: absence of evidence is not evidence, and treating it as staleness would spawn a process per harness forever to learn nothing. A version-less binary comes back only through an explicit re-ask. The version is a **parameter** to `probe_with`, taken from the cached `agent_health` sweep, so the number recorded and the number compared against are one measurement.

**The cache's own shape**, which no version comparison can see: a catalogue written by an older Tori is missing fields this one reads, and the binary on disk need not have moved at all. `Catalogue.shape` carries a `CACHE_SHAPE` stamp, bumped once per field added to the cache that a surface depends on:

- **1** the stamp itself,
- **2** `supports_fast_mode` / `supports_adaptive_thinking` on every model row,
- **3** an ACP row's own option set and its own effort levels.

Three details are load-bearing:

- **An unstamped catalogue reads as 1, not as whatever is current.** Every cache on every machine was unstamped the day this shipped, so the mechanism landed **inert** and invalidated nothing; bumping the constant is the one action that makes anybody re-probe. Reading an old cache as current would make every future bump miss exactly the caches it exists to catch. The serde default is a separate function returning a literal `1` for that reason.
- **A cache stamped *above* this build is left alone.** A newer Tori's cache carries every field this one reads, so a downgrade is not a reason to spawn a binary.
- **The number lives twice and is pinned equal.** Rust writes it, `modelCatalog.ts::isStale` judges it, because a stamp has to be written where the probe runs and judged where the fields are read. Having Rust decide staleness too would be the second implementation of one rule that `isStale` was moved out of Rust to prevent. `modelCatalog.test.ts` imports `catalog_probe.rs?raw` and asserts the two constants match, so a bump landing in one language fails instead of half-applying.

Both rules live once, in `modelCatalog.ts::isStale`: Rust's copy of the version check was deleted when its only caller went away, rather than kept as a second implementation in a second language.

**Known and accepted:** a shape-stale catalogue also drops Tori's measured effort extras, because `cachedModels` strips them on any `isStale`. A shape bump says Tori changed rather than the binary, so the measurement did not strictly have to come off. It is bounded to the one probe round `refreshCatalogIfDue` takes to land, and splitting it would put a second staleness rule back in the module.

## Two transports, two very different probes

- **claude `stream-json`**: the `initialize` control response carries the whole catalogue and arrives before any session exists. ~1.6s against 2.1.231, and the ignored live test counts jsonl files under `~/.claude/projects` before and after to prove it wrote nothing.
- **ACP**: the catalogue exists **only** as part of `session/new`, so a probe opens a session. What it promises instead is [[concept_no_turn_probe]]'s weaker set: one session, in a directory that is nobody's project, no `session/prompt` in the code path at all, and `session/close` when the agent advertises it.

The ACP probe **shares** `initialize_request` and `new_session_request` with the transport rather than copying them. A probe that handshook with different client capabilities would be measuring an agent Tori never actually runs.

### The ACP probe sweeps every model before it closes

One `session/new` answer describes **one model**, because both measured agents re-cut their options when the model changes ([[concept_acp_config_options]]). So `per_model_options` switches to each model in turn inside that one session and keeps the set the agent answers with; each `CatalogModel` then carries its own effort levels and its own option set, and the catalogue-level set is what a row with no measurement of its own falls back to.

**In the probe rather than when the user picks a model, because the sweep is free.** Timed on OpenCode: handshake plus `session/new` alone is 4.4s, the same probe plus eight model switches is 4.3s. The whole cost is spawning the agent and opening the session, and a switch is one round trip down a pipe that is already open. Asking on selection would mean asking an agent that has no session, so it is spawn-open-switch-teardown *per pick*, paid while the user waits, which is the shape `probeOnHighlight`'s debounce already exists to prevent. A live chat does ask on selection and needs none of this: the agent answers every switch with its whole set and the mirror replaces wholesale.

Capped at `PER_MODEL_SWEEP_CAP` (24). Past the cap a row falls back to the opening set, which is what every row did before this existed, so a catalogue large enough to overrun `PROBE_DEADLINE` degrades to the old behaviour rather than failing the probe and rendering the agent as an error card. Both measured catalogues (OpenCode 15, Codex 4) sweep whole.

A model the agent refuses to switch to is simply absent from the map and falls back the same way: a refusal degrades one row rather than failing anything.

## Fan-out, not batch

`refresh_model_catalogs()` (sweep every due harness, return the lot) existed and was deleted. The frontend calls `refresh_model_catalog(id)` per harness instead, so each card fills as its own probe lands. See [[lesson_a_batch_answers_when_its_slowest_member_does]].

`isDue` treats a failure as **not an answer**: without that, a harness that was signed out once reads "Error" forever, because nothing would ask again after the user signed in. `unsupported` is the exception, which is why it is a *reason* check and not a state check.

## What reads it

- **The harness card** shows a distinct-model count, deduped by `resolvedModel` **falling back to `value`**. That fallback is load-bearing, not defensive: a user-configured row carries an empty `resolvedModel` on purpose, so keying on that field alone makes every configured model one model. Counts dedupe; pickers show every row.
- **The detail page** lists the models with the id a switch would send, a provenance line ("Asked Claude 2.1.231, <date>"), the multi-account caveat when the harness named an account, a stale note, and a preview of the harness's own options ([[concept_generic_config_mirror]]).
- **A chat opening** asks its **own** harness only. Opening a claude chat already launches claude, so asking costs nothing new; sweeping would spawn every other agent on the machine because a chat was opened. The all-at-once case is the Harnesses page's deliberate "Check models".

## Things that bite

- **Looking at Settings must never probe.** `ensureModelCatalogsLoaded` reads and nothing else; a dom test asserts opening Settings issues no probe command.
- The store's read latch is module state that outlives a test (`__resetModelCatalogsForTests`), the same trap `modelCaps` already had - see [[lesson_shared_state_makes_a_test_order_dependent]].
- [[gotcha_a_cached_promises_value_is_the_state_of_the_world_at_first_load]]
- [[gotcha_process_group_0_at_spawn_means_child_kill_signals_only_the_leader]]

## Related

- [[concept_no_turn_probe]] — the mechanism and its honesty problem
- [[concept_generic_config_mirror]] — what the probe's `options` field feeds
- [[component_chat_model_resolver]] — where a cached row meets a live one
- [[component_agent_health_cards]] — the surface this fills in
- [[concept_acp_config_options]] — what an ACP catalogue actually is on the wire
- [[component_acp_transport]] — whose handshake the ACP arm borrows

## One catalogue per (agent, account) (2026-09-05)

The cache was keyed on the agent alone, so on a two-login machine the picker showed whichever account probed last: measured, the default account on `max` and `globex` on `team`, with the Max catalogue served to both. The record now carries `profile_id` beside `agent_id` and the file is `{agent}__{profile}.json`, the default account keeping the bare `{agent}.json` so nothing already cached is orphaned. `load_from` checks that the record names the pair it was asked for and degrades to never-probed otherwise, because `sanitize_segment` can produce the `__` join from either id and two pairs can reach one path; a re-probe is cheaper than one account being handed another's models.

Three places went on answering as the wrong account after the file was split, and each is now the account's own: the probe's environment (extracted into `probe_spec`, so "this probe runs in that account's home" is assertable rather than a line to be read), the `whoami` behind `refine_signed_out`, and `user_configured_models`, which read the *process's* `CLAUDE_CONFIG_DIR` and credited the launching environment's pinned models to every account. Locks moved from per agent to per pair, so a re-check of one account cannot queue behind another's 45 second timeout. `remove_agent_account` deletes the account's catalogue with its home.

See [[concept_the_account_is_half_the_key]] for the keying as a rule, and [[gotcha_a_catalogue_keyed_per_account_has_no_row_for_an_account_added_this_run]] for the trap it introduced.

**Source:** plan "Multi-account: pick, lock and default an account per session" (personal/tori, branch `multiaccount`), phase 2 · commit `aa084e0` · `src-tauri/src/catalog_probe.rs`, `src/utils/modelCatalog.ts`
