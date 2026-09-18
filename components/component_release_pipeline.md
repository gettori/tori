---
summary: release scripts run locally before a tag is pushed, since an empty release body is only discoverable after the fact
status: current
updated: 2026-07-19
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/tori, branch `topbar`); Phase 2; commits 7bbae18, 6bb45b3"
---

# Release pipeline (tagged build, arch sweep, check-only update)

**Location:** `.github/workflows/release.yml`, `.github/scripts/*.sh`, `src-tauri/src/update.rs`, `CHANGELOG.md`, `docs/INSTALL.md`

Everything between "push a `v*` tag" and "a stranger has Tori running": the GitHub Actions build, the checks that stop a bad release before it exists, the DMG, and the in-app notice that a newer one is out.

## Responsibilities

- **Release logic lives in `.github/scripts/*.sh`, not inline YAML.** This is the load-bearing structural choice: an empty release body or a decorative arch check is otherwise only discoverable *after* a tag is pushed, which is the worst possible moment. Both scripts run locally. `changelog-section.sh <version>` extracts that version's section, stops at the next `## `, trims edge blank lines, and exits nonzero when the section is missing. `check-universal.sh <app>` sweeps every Mach-O in the bundle.
- **Two cheap checks run before the long build.** A tag that disagrees with `tauri.conf.json`'s version ships a build that reports the wrong version to its own update check and looks for the wrong changelog section; a missing changelog section publishes an empty release. Both fail in seconds rather than after a full universal compile.
- **The arch sweep covers resources, not just the main binary.** `lipo -archs` on `Contents/MacOS/Tori` proves nothing about npm-installed native deps under `resources/lsp`. Today `resources/lsp` pulls only `typescript` + `typescript-language-server`, both pure JS, so the sweep is a **regression guard rather than a fix for a live problem**, and it is written to fail loudly on a planted single-arch dylib and to refuse a bundle containing no Mach-O at all (a wrong path would otherwise make it silently pass).
- **The release is left as a draft**, on purpose: an unsigned build needs the Gatekeeper note published alongside it, and that is a human's call.
- **Update check is check-only, and always will be while unsigned** (`update.rs`): fetch the latest tag, compare semver, show a dismissible pill. Replacing an unsigned bundle re-triggers quarantine, so an auto-updater would not save the user the Gatekeeper step it would cost them.
- **The throttle stores a deadline, not a last-check time.** A pessimistic 1h retry deadline is written *before* the request and upgraded to 24h only once GitHub actually answers. Storing the deadline rather than the timestamp is what lets one field encode both outcomes, and it is why a laptop opened before wifi connects does not go silent for 24h.
- **`open_releases_page` is a fixed-destination command**, not a general `open_url(url)`, so the frontend cannot be induced to open something arbitrary.

## Tauri threading (verified against the v2 docs, not assumed)

Async commands run via `async_runtime::spawn`, but commands **without** `async` run on the **main thread**, so blocking I/O in a sync command freezes the window. `check_for_update`, `agent_health`, and `onboarding_should_show` are all `async fn` for this reason; `open_releases_page` stays sync because `spawn()` returns immediately. See [[gotcha_a_tauri_command_without_async_runs_on_the_main_thread]], which this rule later caught a live violation of.

## Connections

- [[component_agent_health_cards]] - the update pill is suppressed while the first-run Agents view is open.
- `docs/INSTALL.md` is the user-facing half: the macOS 15+ Gatekeeper steps, since the right-click-Open bypass was removed in Sequoia.

## Known gaps

- **The workflow has never run.** No tag has been pushed to `gettori/tori`, so the DMG build, the universal-binary result, and the release upload are all unexercised, and the Gatekeeper steps have never been reproduced on a real quarantined DMG.
- `gettori/tori` is hardcoded in `update.rs`; a fork or rename silently checks the wrong repo.
