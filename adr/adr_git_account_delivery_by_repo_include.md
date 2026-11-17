---
summary: an account reaches every git client through its own config file included at the end of the repo config, and its ssh key through a host-scoped wrapper
status: current
updated: 2026-11-16
source: plan "Git accounts: identity, keys and a pick at clone" (personal/tori, branch `multi-git-account`); commits a1fecbef, 8935f287, 83f047dc, 86614ab1, 8acbb064, 66d873d8; `src-tauri/src/forge/identity.rs:94`, `src-tauri/src/forge/identity.rs:67`
---

# A git account is delivered by a repo include and an ssh wrapper

## Context

A repo's account (its remote's pick, the host default, or the only account) has to decide the commit author, the SSH key and the signing key for every git client in the repo, not only Tori's own git: the user's terminal, editor, agents and linked worktrees too. Tori already answers HTTPS credentials through its helper ([[adr_git_integration_auth]], [[concept_askpass_bridge]]), but nothing set identity or keys.

## Decision

Each account with an author or a key gets a Tori-owned git config file at `<config dir>/git-accounts/<id>.gitconfig`. Every known, trusted repo that resolves to the account gets one `[include] path = ...` appended by hand to the very end of its common config, so it outranks the repo's own values. Editing the account rewrites only its file.

The SSH key goes in through `core.sshCommand` pointing at a per-account `sh` script named `ssh`. The script finds the destination in git's argv, resolves it with `ssh -G`, and adds `-i <key> -o IdentitiesOnly=yes` only when the hostname is the account's host. Signing sets `gpg.format=ssh`, `user.signingkey` and `commit.gpgsign` in the same file.

The account wins over a repo's own author once the user chooses it. Automatic application never touches a repo that already sets its own author: that repo waits as needing a choice.

## Alternatives rejected

- **Env per process** (`GIT_AUTHOR_*`, `GIT_SSH_COMMAND` on spawn): a terminal that changes directory into another repo commits as the wrong author, and git outside Tori never sees it.
- **Global `includeIf "hasconfig:remote.*.url:..."`**: glob matching across https, scp-style and ssh:// spellings and aliases fails silently, so a repo quietly commits as the global author.
- **`-i` with `IdentitiesOnly` for the whole repo**: breaks a submodule or second remote on another host.
- **`-i` without `IdentitiesOnly`**: offers the account key to every host.
- **An ssh `-F` config with `Match final`**: measured to list the account key after the user's own keys, so the wrong account logs in. See [[gotcha_ssh_identityfile_only_accumulates]].

## Consequences

- Tori writes into user repos, so it refuses untrusted folders and anything `rev-parse --git-common-dir` will not answer ([[gotcha_exec_common_dir_falls_back_to_the_folder_itself]]).
- An unset include can leave an empty `[include]` header behind.
- An uninstall leaves includes pointing at a missing file, which git ignores. Removing an account through Tori repoints or clears every known repo first.
- The wrapper is plain `sh` and does not depend on Tori's binary. It is named `ssh`, so Tori still treats it as OpenSSH and appends its own options.
- A clone needs the file from its first fetch, so it runs `git clone -c include.path=...`, which lands the include in the wrong place ([[gotcha_clone_c_include_lands_above_the_remote_section]]).
- Submodules and repos Tori does not know are not covered.

## Related

- [[component_git_account_identity]] - the module that implements it
- [[component_forge_client]] - where accounts and picks live
- [[concept_naming_an_account_needs_two]] - why most of the UI stays silent with one account
