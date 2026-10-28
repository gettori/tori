---
summary: a worktree's .tori/project.json is a proposal, accepted per trust scope plus sha256; the user's value wins field by field
status: current
updated: 2026-10-28
source: plan "Shareable project config in the repository, trust-gated" (branch shareable-project-config, gettori/tickets#49); commits ef60287f, d944ce30, e8de60e9, 70a3fb0c; src-tauri/src/project_config.rs, src-tauri/src/setup.rs (command_for), src/utils/proposals.ts
---

# Repo proposals

A repository can say how its worktrees are set up by committing `.tori/project.json` (`setupCommand`, `runCommand`, `teardownCommand`, `ports` 1 to 10, `checks`). Tori treats it as a proposal from a stranger: nothing in it runs until the user has seen that exact content and accepted it, and any value the user set in Tori wins over it. The decision and what was rejected are in [[adr_repo_config_is_a_digest_keyed_proposal]].

## How it works

- **Reading** (`project_config::read`): a plain fs read of the worktree's own file, json5, unknown or mistyped keys dropped, `ports` outside 1..=10 dropped. A file with nothing usable, or not UTF-8, is `none`. The digest is sha256 of the raw bytes, from the same read as the values, so what is shown and what is keyed cannot differ.
- **State** (`state_at`): untrusted first, then fork (`worktree::not_a_fork`), then the file. So an untrusted project never reads it and never prompts. Six states: `none`, `untrusted`, `fork`, `unaccepted`, `declined`, `accepted`. `Proposal::word()` is what the socket and the CLI print.
- **Consent** lives in `~/.config/tori/proposals.json` as `{ scope: { accepted: {digest: content}, declined: [digest], last } }`, scope being `trust::scope_of`. Worktrees with equal content share one answer. `last` is what the Review dialog diffs against. The only writer is the private `consent` module, which re-reads the file and refuses a digest that no longer matches, so a caller never supplies the content that gets stored.
- **Precedence**, per field: the user's non-empty value, else the accepted value, else nothing (ports: 10, checks: the built-in list). `setup::command_for` is the one resolver for setup, run and teardown, and records the `Source` on the report. `ports::width` and `verification::entries_in` do the same for their fields. `setupWait`, `runOnCreate` and `openBrowser` stay user only.
- **Asking**: `noticeProposal` toasts on selection, once per worktree per launch and once per digest, because a warm worktree switch is held to an invoke budget. A declined digest never toasts; Tooling's Repo proposals lists it. Accept answers with the source of the setup in force, and Run setup now is offered only when that is the repo's.

## Why it is this way

- **Not on the socket.** `accept_proposal` and `decline_proposal` are Tauri commands only, so an agent cannot accept a file it wrote. `the_socket_cannot_reach_consent` scans `src/rpc/**.rs` text for the names, so even a comment saying "consent" there trips it.
- **Tests never touch the real store.** Under `cfg(test)` `proposal()` answers only from a per-thread, per-worktree seam (`seam`, `seam_accepted`), like [[component_worktree_setup]]'s `seam`.
- **Schema**: `tori-project.schema.json` rides the settings associations ([[concept_schema_backed_json]]), and a Rust test holds its keys and the ports bound equal to `parse`.

## Related

- [[adr_repo_config_is_a_digest_keyed_proposal]] the decision
- [[component_worktree_setup]] the runner that resolves through `command_for`
- [[component_ports]] the width
- [[component_verification]] the checks tier
- [[component_project_settings_dialog]] where accepted values are shown with a repo mark
- [[gotcha_tori_is_in_info_exclude_so_a_new_project_json_needs_add_f]] why a user cannot see the file they just made
- [[concept_workspace_settings_overlay]] the other repo file, which may only turn things off
