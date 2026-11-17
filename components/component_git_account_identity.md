---
summary: forge/identity.rs owns account git config files, repo includes, the reconcile and the removal preview; ssh_keys.rs lists and tests keys
status: current
updated: 2026-11-16
source: plan "Git accounts: identity, keys and a pick at clone" (personal/tori, branch `multi-git-account`); commits a1fecbef, 8935f287, 83f047dc, 86614ab1, 8acbb064, 66d873d8; `src-tauri/src/forge/identity.rs:401`, `src-tauri/src/forge/ssh_keys.rs:98`, `src-tauri/src/forge/commands.rs:926`
---

# Git account identity (Rust)

`src-tauri/src/forge/identity.rs` and `src-tauri/src/forge/ssh_keys.rs` put an account's author, SSH key and signing key into the repos that act as it. The decision behind the shape is [[adr_git_account_delivery_by_repo_include]].

## Responsibility

- **Account files.** `write_file_in` (`identity.rs:94`) writes `git-accounts/<id>.gitconfig` and, for an SSH key, the `<id>.ssh/ssh` wrapper (`identity.rs:67`). An account with nothing to set has no file. `agent-keys/` holds public halves of keys only an agent has.
- **Opening a repo.** `Repo::open` (`identity.rs:149`) refuses an untrusted folder and anything without a git common dir.
- **Classifying values.** `git config --show-scope --show-origin --get-all` entries are sorted by `Places::kind` (`identity.rs:326`) into Account (from `git-accounts/`), Plain (the global or system file itself), Repo (local or worktree) and Include (any other file, which covers `includeIf`).
- **Applying.** `Repo::apply` (`identity.rs:263`) unsets other account includes and appends the wanted one at the end of the file. `outranks_own` (`identity.rs:233`) re-appends it when a managed key (author, `core.sshCommand`, signing) comes after it.
- **Reconcile.** `reconcile()` (`identity.rs:401`) rewrites every account file, applies every known repo, then deletes files no account owns. It runs at launch, on every `tori.toml` change, and from the pick, default, remove, author and key commands, under one lock. A repo with its own author and no include is skipped and reported as `needsChoice` by `commit_identity` (`identity.rs:490`).
- **Removal preview.** `removal` (`identity.rs:616`) lists the known repos on an account by remote key, with the author each other account would give them.
- **Keys.** `ssh_keys::list` reads `~/.ssh/*.pub` and `ssh-add -L`, and checks for a passphrase by running `ssh-keygen -y -P ""` as a child, so Tori never reads a private key. `ssh_keys::test` runs `ssh -F /dev/null -T` and reads the login the host answers with.

It does not own resolution (`accounts::resolve`), the picks (`settings::edit_forge_picks`) or the HTTPS credential helper (`credential.rs`).

## Interface

- Commands in `forge/commands.rs`: `forge_commit_identity`, `forge_identity_use`, `forge_identity_stop`, `forge_identity_remove_own`, `forge_set_identity`, `forge_identity_hint`, `forge_ssh_keys`, `forge_set_keys`, `forge_test_ssh_key`, `forge_account_removal`, and for clones `forge_clone_accounts`, `forge_repo_access` and `forge_clone_prepare` (`commands.rs:926`). The last answers the account file for `git clone -c include.path`.
- `git::may_sign` (`git.rs:1181`) gives every git that can commit (commit, merge, rebase, continue) the askpass env, so a signing passphrase reaches Tori's dialog.
- The frontend: `AccountAuthor.tsx` and `AccountKeys.tsx` on the account card, "Commits as" in `BranchesSection.tsx`, `CloneAccount.tsx`, `RemoveAccountDialog.tsx`.

## Related

- [[adr_git_account_delivery_by_repo_include]]
- [[component_forge_client]]
- [[concept_askpass_bridge]] - signing passphrases ride it
- [[gotcha_clone_c_include_lands_above_the_remote_section]]
- [[gotcha_exec_common_dir_falls_back_to_the_folder_itself]]
- [[gotcha_ssh_identityfile_only_accumulates]]
