---
summary: ships.sh builds a component, diffs what vite bundled and cargo resolved against its tag, version-checks lockfiles
status: current
updated: 2026-10-31
source: release-per-component plan, branch release-per-component (commits d90b2678, 9e2a4c63, 0fa86202); scripts/bundled-inputs.ts:23; .github/scripts/ships.sh:62, :101, :118; .github/scripts/components.sh:32
---

# A component ships when what its build read changed

`.github/scripts/ships.sh <macos|android|extension> [since-tag] [--force]` prints the component's name when anything its build was made from differs from the tag of the version it carries, and nothing otherwise, with the reason on stderr. `scripts/release.sh prepare` runs it for each component in its throwaway worktree of origin/main. Nothing lists by hand what a component is built from: the phone imports chat components straight from `../../src`, so a path list would drift silently.

## How it works

- **The web half lists itself.** `scripts/bundled-inputs.ts:23` is a vite plugin in the desktop, mobile and extension configs. At `buildEnd` it walks `this.getModuleIds()` and writes `node_modules/.tori/inputs/<build>.tsv`: `file` lines (repo relative), `package` lines (`name@version`, read off the pnpm store directory name) and `unknown` for an id that is neither. An `unknown` line fails the decision, not the build. The config file, `publicDir`, `tsconfig.json` and an `extra` list (the extension's manifests and icons, which its config reads rather than imports) come from the resolved config. A worker is its own build, so the plugin sits in `worker.plugins` too ([[gotcha_a_vite_worker_is_its_own_build_so_a_plugin_misses_its_modules]]).
- **The Rust half comes from cargo.** `cargo metadata --locked --filter-platform <triple>` (both apple-darwin triples for macOS, aarch64-linux-android for Android) gives the path packages, diffed as directories with `Cargo.lock` left out, and the registry crates.
- **Lockfiles are checked, not diffed**, since they move on nearly every release. Every bundled `name@version` must be in the tag's `pnpm-lock.yaml` or `Cargo.lock`, and no version the tag held may be gone for a name the build uses. The second check catches a move to a version the tag already had for another consumer (`lock_drift`, `ships.sh:101`).
- **The baseline** is the tag that released the version the component carries (`released_tag`, `components.sh:32`), an old `v<release>` tag included. With none, because a release never finished, the newest reachable `<component>-v*` and then `v*` stand in (`baseline_tag`, `ships.sh:62`).
- It installs with `--frozen-lockfile --prefer-offline --ignore-scripts` (`ships.sh:118`) and builds the checkout it lives in: about 7 s to install cold, then 10 s for the desktop, 6 s for the phone, 1 s for the extension.

## Why it is this way

- Rejected: hand path lists (they drift as the phone imports more of `src/`); hashes of the built output (Rust builds are not reproducible); counting lockfile diff lines that name a bundled package (a dev tool bump that lists solid-js would ship everything); `this.error` on an unplaceable module (it fails every build, where `unknown` fails only the decision).
- The extension's `package.json` is not an input, so its bumped version alone never ships it again.

## Related

- [[component_release_pipeline]] where `prepare` and the gate use it
- [[adr_each_component_releases_on_its_own_tag]] the decision it serves
- [[gotcha_a_vite_worker_is_its_own_build_so_a_plugin_misses_its_modules]] the trap the plugin hit
