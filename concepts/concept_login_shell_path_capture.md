---
summary: captures the login shell's own PATH once at startup so health checks never trust the GUI process's minimal one
status: current
updated: 2026-07-19
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/sway, branch `topbar`); Phase 1; `src-tauri/src/env.rs`"
---

# Login-shell PATH capture

How Sway answers "is this agent's binary actually installed?" A Finder-launched GUI process inherits a minimal PATH that omits nearly every place a developer's tools live, so a naive `which` is not a wrong-ish answer, it is a confidently wrong one. Sway captures the **login shell's** PATH once at startup and resolves every agent binary against that, never against its own process PATH.

## How it works

- **One capture, sentinel-delimited.** `$SHELL -lic 'printf "<<<%s>>>" "$PATH"'`, with the value extracted from between the markers. The markers exist because a login shell is not a clean pipe: rc files print banners, version-manager hooks, motd, direnv notices. Reading stdout raw would splice that noise into PATH and produce directories that do not exist. The sentinel makes the parse total rather than best-effort.
- **A fallback that degrades to per-binary probes.** If the sentinel parse fails for any reason, Sway falls back to `$SHELL -lic 'command -v <bin>'` per binary. Slower (one shell spawn each) but it answers the only question that matters, and it is the shell's own resolution rather than Sway's guess at it.
- **`resolve_in_path` is a pure function**, split out for exactly one reason: so the nvm/volta case (a binary that exists only in a version-manager shim dir) is unit-testable without spawning a real login shell.
- **Bounded, always.** Every probe goes through `env::output_with_timeout` (5s). See [[gotcha_a_subprocess_probe_inside_a_memoized_sweep_must_be_bounded]].

## Why it's this way

The real-machine dump is what justified the whole approach rather than a simpler one: on the dev machine `claude` resolves at `~/.local/bin` and `pi` at `~/.volta/bin`, and **neither directory is on a Finder-launched process's PATH**. A naive check would have told a user with a perfectly working setup that two of their three bundled agents were not installed, which is worse than not shipping the feature.

This coexists with, and is deliberately separate from, the older `env::augmented_path`. That one **guesses** likely directories and prepends them so a spawned agent can find `node`; this one **asks the shell** and is used for health checks, where a guess would be indistinguishable from a fact. They live in the same file with a comment on why the health path must never use the guessing one.

## Related

- [[component_agent_health_cards]] - the consumer; the cards are only trustworthy because this is.
- [[gotcha_gui_launched_processes_inherit_a_minimal_path]] - the underlying trap, and `augmented_path`, the other half of the response to it.
- [[component_agent_adapter_registry]] - supplies the launch binary per adapter that this resolves.
