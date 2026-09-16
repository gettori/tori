---
summary: git shells out to the system binary with an askpass and editor bridge so any provider works with zero provider code
status: current
updated: 2026-07-10
source: Git-integration & auth strategy interview (personal/sway, branch code-mirror-6); credential half built; commit 3fff674
---

# ADR: In-app git runs on the system git binary via askpass + editor bridges; provider API-auth is deferred and pluggable

**Status note:** accepted; **credential half implemented** (editor bridge still deferred)

> **Implementation note (2026-07-10):** the **askpass credential bridge** is built - see [[concept_askpass_bridge]] / [[component_askpass]]. Native backgrounded git ops now prompt via an in-app dialog over a private Unix socket (no terminal tab), fail-closed, provider-agnostic, with SSH host-key `accept-new`. Still deferred: the **editor bridge** (`GIT_EDITOR`/`GIT_SEQUENCE_EDITOR`) and provider API-auth (OAuth).

## Context

Sway is growing a VSCode-like git surface in the right-hand pane (commit / push / pull / fetch / merge / rebase on top of the existing file tree). Today the app splits git into two worlds: fast, no-auth native ops in `git.rs`, and **auth'd or long ops run in a terminal tab** for ambient credential prompts (see [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]]). A tab-per-auth'd-op does not scale to a full git UI, and the immediate trigger (a background "load origin" for a remote-branch picker) has no TTY, so it would hang on any repo that needs a credential prompt. We need one durable foundation, spanning credentials **and** the interactive editor prompts git ops raise, that every future git feature can build on across hosting providers.

## Decisions

- **Shell out to the system `git` binary for all git operations** (extend `git.rs`), not a git library (libgit2/gitoxide). This is what VSCode does, and it inherits git's credential helpers and ssh-agent for free. A library would force us to own credential handling and lose helper/askpass integration. System `git` becomes a required runtime dependency (already effectively true).
- **Credential auth via an askpass bridge.** Point `GIT_ASKPASS` / `SSH_ASKPASS` at a small helper that round-trips git's credential/passphrase prompt into a native in-app dialog (reusing the `PromptModal` pattern) and returns the answer to git. `GIT_ASKPASS` is called directly by git and is reliable for HTTPS. `SSH_ASKPASS` is more conditional: it must be forced with `SSH_ASKPASS_REQUIRE=force` (OpenSSH >= 8.4) and only fires without a controlling terminal, so the helper must set that explicitly, not merely export the env var.
- **An editor bridge is a peer decision, not an afterthought.** Credential askpass does not cover the interactive **editor** prompts git raises: `git commit` (no `-m`), the message on `merge`/`rebase --continue`, and interactive rebase's sequence list. Point `GIT_EDITOR` / `GIT_SEQUENCE_EDITOR` at a bridge (or drive every op non-interactively with `-m`/`-F`/`--no-edit` and a scripted sequencer) so a backgrounded op never hangs waiting on `vim`. Interactive rebase (reorder/squash) specifically requires the `GIT_SEQUENCE_EDITOR` bridge or is scoped out until it exists.
- **Host-key verification is handled explicitly, not assumed.** A first SSH connection to a host absent from `known_hosts` prompts `Are you sure you want to continue connecting?`, which `SSH_ASKPASS` does **not** answer; a no-TTY backgrounded ssh then aborts with `Host key verification failed`. We must route this through the bridge or choose an explicit `StrictHostKeyChecking` policy (e.g. `accept-new`), rather than assume SSH "just works."
- **The bridge is provider-agnostic by construction.** Because it is just git's own credential/editor mechanism, GitHub, Bitbucket, GitLab, Azure DevOps, GitHub Enterprise, and self-hosted remotes over SSH or HTTPS all work with **zero provider-specific code** (modulo the host-key and `SSH_ASKPASS_REQUIRE` handling above). Provider support is not a per-provider feature at this layer.
- **The app persists no credentials itself.** Secrets stay in git's credential helper (macOS `osxkeychain`) and ssh-agent; Sway only relays prompts. Caching across ops therefore depends on a configured credential helper: with none, git re-prompts every op, so the app should ensure/offer a helper rather than assume one. Relaying cleartext secrets over the local transport is still a real (smaller) security-review surface, see Consequences.
- **Provider API-auth (OAuth) is deferred and pluggable.** A token/OAuth layer is needed **only** for provider *API* features (PR lists, checks, reviews), never for core git. It is GitHub-!=-Bitbucket-!=-GitLab-specific, so it is left out of this ADR and, when built, designed as a per-provider plug-in (its own app registration, endpoints, scopes, Keychain-stored token), not baked into the git layer.
- **Terminal tabs stop being the auth mechanism.** Once the bridges land, tabs are no longer required for credentials or editors; they remain an *optional* choice for showing live streaming progress on long ops. This **supersedes** the tab-for-auth rationale in [[adr_attached_branch_model]] (the "fetch/attach decoupled across the tab boundary" bullet), [[adr_sidebar_project_manager]] (the "terminal tab for auth/destructive ops" bullet), [[component_project_discovery]] (its "no-auth git ops ... auth ops go to a terminal tab" framing), and the auth rationale of [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]]. The injection-safety (positional args) and clone-cleanup (`|| rm -rf`, `incomplete`-stub) parts of that gotcha still stand.

## Consequences

- Every future git feature (commit/push/pull/merge/rebase, the remote-branch picker) builds on one auth + editor path and can run without spawning a tab.
- Sway hard-depends on a working `git` install; seamless background auth further depends on a configured credential helper / ssh-agent. A user with neither gets the askpass dialog per op (not cached) until a helper is configured, and a first-time SSH host needs host-key acceptance.
- **HTTPS wants a token, not a password.** GitHub/GitLab reject account passwords over HTTPS; the askpass dialog relays whatever is typed, so the UI should hint "personal access token" rather than present a bare password field (this is part of why VSCode adds GitHub OAuth for github.com).
- The askpass/editor helpers need a secure local transport (socket/pipe) between helper process and app, and must **fail closed** (cancel = git sees an empty credential / aborted edit, op aborts) rather than hang. Cleartext secrets transit app memory and that transport, so it is a security-review surface even though nothing is persisted.
- Provider API features arrive later and per-provider; the core git surface never blocks on them.

## Considered options

- **Git library (libgit2/gitoxide)** - rejected: reimplements credential handling, loses helper/ssh-agent/askpass integration, and each provider's auth becomes our problem.
- **GitHub OAuth as the auth foundation** - rejected: GitHub-HTTPS-only, useless for SSH and non-GitHub hosts, and reinvents the credential helper. It is the wrong layer; it belongs above core git, per-provider, for API features only.
- **Keep tab-per-auth'd-op** - rejected: does not scale to a full git UI and cannot serve backgrounded ops.

## Related

- [[component_project_discovery]] - the `git.rs` native-ops hub this extends (and whose no-auth/tab framing it supersedes)
- [[adr_attached_branch_model]] - the fetch/attach tab-boundary decoupling this supersedes
- [[adr_sidebar_project_manager]] - the native-vs-tab split this revises, and the broader sidebar/pane-as-git-workflow direction
- [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]] - the ambient-auth rationale this replaces (injection-safety + clone-cleanup parts still hold)
