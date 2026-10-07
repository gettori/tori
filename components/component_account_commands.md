---
summary: added accounts get a claude-<name> script in ~/.local/bin, marked per build, reconciled at launch and on every account change
status: current
updated: 2026-10-08
source: "plan \"Shell command per Claude account\" (personal/tori, branch `phase-1-block-1`, gettori/tickets#16); `src-tauri/src/account_commands.rs`, `src-tauri/src/accounts.rs:567` (`lock_store`)"
---

# Account commands

`src-tauri/src/account_commands.rs` gives every added account of an agent with a home variable a shell command, so a terminal outside Tori can run the agent as that account: `claude-work` runs `claude` with the Work profile home.

## Responsibility

It owns the scripts in `~/.local/bin` and the `command` field each stored `Profile` carries. It does not own the default account, which has no script: that account is the home variable left unset, so its command is the agent's own binary ([[adr_account_is_session_identity]]). It never edits a dotfile. When `~/.local/bin` is not on the login PATH ([[concept_login_shell_path_capture]]), the card says so and the user fixes it.

- **Script shape** (`script_text`, `account_commands.rs:73`): `#!/bin/sh`, then the marker `# tori-account <build>/<adapter>/<profile-id>`, then `export <home_env>='<home>'` and `exec <program> "$@"`. The home is single quoted, with `'` escaped, because an adopted home is any folder the user picked.
- **Ownership**: `sync_in` (`:209`) writes and deletes only files whose marker names this build. A user's own `claude-x` blocks that name and is never touched. A script from the other build is left alone ([[gotcha_debug_and_release_builds_share_local_bin_but_not_accounts]]).
- **Names**: `command_slug` (`:44`) lowercases the label and folds everything else to `-`, falling back to the profile id. On add or backfill, `assign_commands` (`:132`) suffixes `-2`, `-3` past a taken name. On rename, `retarget_command` (`:155`) refuses a taken name instead, because the user asked for that one.
- **Stored, not derived**: `Profile.command` persists, so a rename that leaves the box unticked keeps the old command working.

## Interface

- `sync()` (`:273`) runs on a thread at launch, and through `sync_quietly` after add, remove and rename. It backfills `command` for profiles stored before the field existed, then brings the directory in line. A failure is logged, never surfaced as a failed account change.
- `rename_agent_account(adapterId, profileId, label, renameCommand)` takes the command along through `rename_with_command`.
- `command_for` (`:252`) feeds `ProfileStatus.command`. It names an added account's command only while this build's script is really there, so the card never advertises a name a foreign file holds.
- `AccountsView` carries `program`, `commandDir` and `commandDirOnPath` for the card and the rename dialog's preview. The TS `commandSlug` in `RenameAccountDialog.tsx` mirrors the Rust slug for that preview only.
- Every writer of `accounts.json` holds `accounts::lock_store()` from load to save, because the launch backfill runs beside the Settings commands.

## Related

- [[adr_credential_custody]] - the home path now also lives in a script, which is a path and not a secret
- [[gotcha_local_bin_holds_the_agent_binaries]] - why the marker read is bounded
- [[concept_naming_an_account_needs_two]] - the default row's command is the bare binary, matching the single-account silence
