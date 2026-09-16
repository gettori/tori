---
summary: lists 31 agents Sway could launch over ACP but never has, and a catalog entry claims only that a launch command exists
status: current
updated: 2026-08-15
source: "\"Defer permissions to the harness, and grow to four harnesses\" (phases 6 and 8, branch `chat-fix`), then \"Make a harness installable, signed in, and discoverable\" (phase 5, branch `harness-lifecycle`); upstream `github.com/agentclientprotocol/registry`"
---

# ACP launch catalog

**Location:** `src-tauri/src/catalog.rs`, `src-tauri/src/install.rs`, `dev/acp-catalog.mjs`, `src/panels/Settings/AgentsSection.tsx` (`CatalogList`, `CatalogRowItem`)

The list of agents Sway *could* drive over ACP but has never run. 31 launchable entries, generated from the official ACP Registry rather than hand-maintained, committed with the upstream commit and date so the list cannot rot silently.

Its whole reason for existing separately is a distinction that is easy to lose: **a catalog entry is not a supported harness.** An entry offers a launch command; a harness has a measured capability tier. Conflating them is how a listing ends up promising what nobody tested.

## Responsibilities

- Read the registry snapshot, drop the entries Sway already ships an adapter for, and hand the rest to Settings with no status dot, no capability list and no version of Sway's own.
- **It does not start anything.** The rows appear in Settings, not in any launch picker, because starting a catalog entry means writing its adapter - which is also the moment somebody decides it is worth trusting.
- It does not claim the agent works. It claims only that this is how you would launch it.

## Key files & entry points

- `catalog.rs:174` — `acp_catalog`, the rows; `:201` — `acp_catalog_source`, the provenance.
- `catalog.rs:154` — `launch_identity`, which sees through a package runner to the package.
- `dev/acp-catalog.mjs` — regenerates from upstream; `--check` says whether the registry has moved.

## The three rules that make the list honest

**Quarantined agents are excluded, with the reasons committed.** The first draft shipped all 39 entries including the **8 the registry itself quarantines** ("ACP initialize fails", "npx cannot determine executable to run", a postinstall script). A catalog entry claims only *untested by Sway*; a quarantined agent is *known broken by the people who curate it*, and putting one in the same list launders the stronger claim into the weaker one.

**A row is matched to an adapter by id *or* by launch identity, because each alone has a counterexample.** Program alone misses Gemini: the registry launches it as `npx -y @google/gemini-cli@0.55.1 --acp` while `gemini.toml` launches an installed `gemini` — same agent, two legitimate launches, no shared program. Id alone misses Cursor: the registry calls that entry `cursor` while its binary is `cursor-agent`.

**`launch_identity` sees the package, not the runner** (`catalog.rs:154`), and this was a silent near-miss. `codex.toml` is the first bundled adapter whose **chat** binary is not its launch binary: it launches `codex` and chats through `npx -y @agentclientprotocol/codex-acp@1.2.0`. Comparing programs would have made **every `npx` row in the registry** - the bulk of it - read as "already covered by Codex", and the catalog would have quietly stopped offering agents Sway has never measured. The function skips flags, takes the first bare argument, and strips the version pin. `agentIdForProgram` on the frontend still has the same weakness, left with the limitation named at the code because Codex is the only such adapter today. See [[gotcha_a_chat_binary_that_is_a_package_runner_breaks_any_comparison_by_program]].

**What Sway can offer is what the registry's `cmd` gives**, so each row records how it would arrive: `needs: "npx"` (18 rows), `needs: "install"` (13, where the registry publishes a binary archive), or `needs: "on-path"`.

## Installing a row, and what that does not make it

Sway can download a `binary` distribution for the host. 13 of 31 rows offer it. The trust model is [[concept_registry_install_trust]]; what matters to this component is the shape.

**`builds` is carried whole rather than reduced to this machine.** The generator runs on one architecture and the binary it produces runs on others, so collapsing the platform map at generation time would make "there is no build for your machine" indistinguishable from "this agent ships no binaries". `build_for` returns three answers (`Ready` / `NoBuildHere` / `NotInstallable`) and `row_for` takes the platform as an argument, which is what lets an arm64 machine assert the Intel path in a test. `kimi` publishes no `darwin-x86_64`, so "unavailable rather than offered" is a live case, not a hypothetical.

**Installing produces no adapter, and the row still says untested.** An installed agent is a path plus a manifest under `Application Support/sway/installed-agents`, never on `PATH`; reaching a session still means a user writing the TOML that names it. `an_installable_row_is_still_an_untested_entry` asserts the serialized row carries no `verifiedAgainst`, no tier and no transport, so the distinction at the top of this page is structural rather than a convention somebody has to remember. The directory is `installed-agents` and not `agents` because `~/.config/sway/agents/` already holds the TOMLs a user writes: two directories with one name, one holding user files and one holding downloaded binaries, is worth a longer word.

**The published capability matrix is a prior with a name, not a tier.** `published_capabilities` says whose measurement it is in the field name, sits beside `matrix_source` carrying the URL, probe date and agent count, and renders as "the registry's own probe of 31 agents on <date>, not from anything Sway measured". Every field is `Option<bool>` so "the matrix did not say" stays distinct from "the matrix said no", and a catalog with no matrix at all still parses and still lists its agents. A tier remains what it was: `chatCapabilities.ts`, keyed on a transport Sway implements.

**A latent wire bug surfaced the moment this phase read fields nobody read before.** `CatalogRow` flattened the file's own snake_case struct, so `registryVersion` and `registryCommit` on the TypeScript side were reading keys nothing sent, invisible while the fields were declared and unused. The wire types are now spelled out rather than flattened, with `every_field_the_frontend_reads_is_sent_in_the_shape_it_reads_it` pinning each key. **A field that is declared and unused is not proven by the type system to arrive.**

## Connections

- Rendered by `AgentsSection`, beside the measured adapter cards it is deliberately kept apart from.
- Feeds nothing else; it is a read-only listing.
- Governed by [[adr_harness_breadth]] — this is the mechanism that shrank its maintenance-tax consequence.

## Related

- [[component_agent_adapter_registry]] — what a row becomes if somebody writes its TOML
- [[component_acp_transport]] — the client every one of these rows would drive
- [[concept_registry_install_trust]] — what installing one of these rows costs you
- [[concept_harness_capability_tiers]] — the tier a catalog row deliberately does not have
- [[gotcha_a_chat_binary_that_is_a_package_runner_breaks_any_comparison_by_program]]
