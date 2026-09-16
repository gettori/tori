---
summary: profile homes sit under Application Support at 0700 holding transcripts, so custody means never spawning security
status: current
updated: 2026-08-15
source: Make a harness installable, signed in, and discoverable (personal/sway, branch `harness-lifecycle`); Phases 0, 2, 3; `src-tauri/src/accounts.rs`, `src-tauri/src/auth.rs`; `handoff_2026-07-27-multi-account-profiles` (deleted, absorbed)
---

# Profile homes live outside `~/.config`, and Sway never reads them

Multi-account support works by pointing an agent CLI at a Sway-created directory through its own isolation variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`). We decided those **profile homes live under macOS Application Support, created `0700`, and never under `~/.config/sway`**, while `accounts.json` (labels and emails only) stays in `~/.config/sway` beside `settings.json`.

The reason survived a measurement that changed what these directories are, and got stronger for it. They were called *credential homes* on the assumption that the CLI writes OAuth tokens into them. On macOS it does not: the directory fills with the harness's own **session transcripts**, and `~/.config` is commonly a dotfile repo, so the exposure is publishing a machine's conversation history rather than leaking a token. Same decision, honest name. Calling them credential homes would have stated a custody Sway does not have.

Sway's custody boundary is that it chooses the location and creates the directory, and never reads, copies or stores its contents. The default account is the isolation variable left **unset**, so an existing login is inherited with no migration and no credential handling at all.

## Where the secrets actually are, measured

Measured 2026-08-14 on macOS 25.6.0 with `claude` 2.1.232, by shadowing `security` on `PATH` with a logging shim. Credentials are in the **login Keychain**, and the service name is namespaced by the config dir:

```
service = "Claude Code-credentials-" + sha256(CLAUDE_CONFIG_DIR)[:8]   # hex, first 8 chars
        = "Claude Code-credentials"                                     # default home, no suffix
```

The account argument is always the OS username, never the Anthropic account. That namespacing **is** the isolation mechanism: two profiles cannot clobber each other because they address different Keychain items, confirmed by holding two simultaneous `loggedIn:true` sessions for one account. It is why `supports_isolation` is `true` for Claude on darwin, on evidence rather than on hope.

Identity and secret are already split by the tool: `oauthAccount` (email, org, seat tier) sits in plain `.claude.json`, tokens sit in the Keychain. Sway's split by sensitivity mirrors a boundary the harness already draws.

**Corrected here:** an earlier version of this page said the isolated home receives "a `backups/` directory holding a timestamped credential copy". That was wrong. The backup is 50 bytes holding exactly one key, `firstStartTime`, a pre-write copy of the bootstrap config. Nothing under an isolated home holds a secret.

## Considered Options

- **Keep everything under `~/.config/sway`** for consistency with settings and user adapters (rejected: the dotfile-repo exposure is a routine, high-consequence accident, and consistency is not worth it).
- **Exclude profile homes from machine backup** (rejected: it addresses local encrypted backup, a materially weaker threat than a public dotfile repo, which the location change already closes; and it would silently cost the user every added account on a restore).

## Consequences

- **The custody test cannot inspect the profile home**, because that directory holds no credentials. The assertion that means something is that Sway **never spawns `security`** and never names a `Claude Code-credentials*` service. Keep a file-custody assertion only for adapters that really do store tokens on disk.
- **The hash is taken over the raw env-var string, not a canonical path.** `.../home-C` and `.../home-C/` are two different Keychain items for one directory, so Sway canonicalizes before storing or spawning. See [[concept_one_directory_two_spellings]].
- This is a **darwin-only** finding. Linux has no login Keychain, so the file fallback is presumably the live path there and the namespacing question must be re-measured before `supports_isolation` is claimed off-darwin.
- The config dir relocates `.claude.json` asymmetrically: by default it sits at `~/.claude.json` *outside* `~/.claude`, but under `CLAUDE_CONFIG_DIR` it is written *inside* the isolated dir. Any code locating a profile's `.claude.json` needs that special case.
- An adapter that declares no `logout_args` cannot revoke on removal, so deleting its profile leaves tokens valid until expiry. That requires explicit confirmation rather than a silent delete.
- Account isolation is per-adapter and unavailable for most of the ACP tail, published through `supports_isolation` rather than hidden. Codex and OpenCode relocate a credential store but claim **no** isolation, because nobody has run two accounts side by side on either.
- **While an inherited `ANTHROPIC_API_KEY` is in force there is no email**, so duplicate-account detection cannot work. A real gap, visible on screen rather than papered over.

## Related

- [[component_agent_adapter_registry]] - where the `[accounts]` schema-v3 table lives
- [[concept_shell_hosted_tabs]] - the login-in-a-tab path an interactive OAuth flow uses
- [[concept_one_directory_two_spellings]] - why the config dir is canonicalized before it is stored
- [[adr_three_session_stores]] - the sibling decision from the same plan
- [[lesson_pure_core_for_global_stores]] - the shape `create_profile_home_in` follows so `0700` is assertable
- [[adr_usage_source_ladder]] - amends this boundary with one gated exception: an opt-in usage source may read the Keychain token, and the custody test asserts it never does while the setting is off
