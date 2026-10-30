---
summary: release PR bumps only components whose inputs changed; CI builds, tags and publishes each on its own <platform>-v tag
status: current
updated: 2026-10-31
source: branch changelog-from-prs (commits eaeb37b4 to e3eb04d2); gettori/tickets#89 extension job (commits 5fd3c397, e22ab1de); release-per-component plan, branch release-per-component (commits d90b2678, 9e2a4c63, e42c2b91, 0fa86202); .github/workflows/release.yml; .github/scripts/*.sh; scripts/release.sh:199, :362; docs/RELEASING.md; rehearsal run 38861320785
---

# Release pipeline (release PR, per-component builds, tags, cask, store)

**Location:** `scripts/release.sh`, `.github/workflows/release.yml`, `.github/workflows/changelog.yml`, `.github/workflows/cask.yml`, `.github/scripts/*.sh`, `scripts/bundled-inputs.ts`, `.github/pull_request_template.md`, `CHANGELOG.md`, `docs/RELEASING.md`

Everything between "the features are merged" and "a stranger has Tori running": how the notes are collected, how the release PR is cut, and what GitHub Actions does once that PR lands on `main`. Nothing in the release path runs on a maintainer's Mac any more.

## Responsibilities

- **Every PR carries its own release notes.** The PR template has a `## Changelog` section: bullets written for a user, or the word `none`. `changelog.yml` runs `pr-changelog.sh` on every PR body (including `edited`, so fixing the body turns it green) and fails a missing, empty or non-bullet section. `CHANGELOG.md` is never edited between releases; a `## Unreleased` section is only for a note no single PR owns.
- **Each component carries its own version.** macOS in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`; Android in the two `mobile/src-tauri` files; the extension in `extension/package.json`, without the stage suffix, since Chrome reads four numbers. The file map and the tag rule live once, in `.github/scripts/components.sh`, which `release.sh` and `ships.sh` source. The release version is the first versioned section of `CHANGELOG.md`; the stage suffix is the desktop's.
- **`prepare` bumps only what changed.** `scripts/release.sh prepare` refuses version drift within a component, asks `ships.sh` about each one ([[concept_derived_release_inputs]]), and stops with "nothing to release" unless one ships or `--force <component>` names it. The notes are the `## Changelog` sections of the PRs merged since the newest tag of any kind (`changelog-from-prs.sh`), under anything in `## Unreleased`, plus one bullet naming what ships and what stays unchanged. Only the shipping components' files and lockfiles move. The patch scan reads `v<date>.*` and `*-v<date>.*` (`release.sh:199`), so one day's patch numbers stay shared across components and suffixes.
- **The merge is the trigger, and the gate picks components.** `release.yml` runs on every push to `main`. Its `gate` job is `scripts/release.sh gate` (`release.sh:362`): a component builds when it carries the release version and no `<platform>-v<version>` tag, or old `v<release>` tag, is on origin. It writes a flag and a version per component to `$GITHUB_OUTPUT`. An ordinary merge moves no version and builds nothing; a fix merged after a failed run builds only what no tag covers yet. A rehearsal follows the same rule, or builds all three with the `all` input. A tag pushed with `github.token` starts no workflow, so a tag could never have been the trigger.
- **One signed, notarized DMG per Mac architecture.** The `macos` matrix builds `aarch64-apple-darwin` natively and `x86_64-apple-darwin` cross-compiled, on the same macOS runner. `import-signing-identity.sh` puts the Developer ID into a keychain of its own together with Apple's G2 intermediate and hands Tauri the identity's hash, so no name has to match. Tauri signs the app and the DMG; `notarize.sh` submits the DMG (one submission covers the app inside), polls on its own schedule, and staples it. `check-bundle.sh` fails any Mach-O that is not the one arch and any signature that does not verify `--deep --strict`. `app-tarball.sh` packs the stapled app for the in-app updater; `cli-tarball.sh` re-signs the binary standalone, notarizes it as a zip, and packs `tori-cli-<version>-macos-<arm64|x64>.tar.gz`.
- **Android is arm64 only**, built on Ubuntu with the keystore written from secrets, verified with `apksigner`, named `Tori_<version>.apk`.
- **Each component publishes on its own.** `publish-macos` and `publish-android` need only the gate and their own build, so a sibling that does not ship, or fails, never holds them back; on a rehearsal they run up to their push-gated tag step. `.github/scripts/publish.sh` finds every named asset exactly once before it tags, drafts the release, confirms the asset list, and publishes. macOS (six files) is tagged `macos-v<version>` and made GitHub's latest release, then `update-cask.sh` points the cask at its two DMGs. Android (the APK) is tagged `android-v<version>` and never made latest. No release is ever a prerelease, since GitHub cannot make one its latest.
- **The extension goes to the Chrome Web Store, staged.** The `extension` job needs only the gate. It builds the store zip with `extension-zip.sh`, tags `extension-v<version>` (no GitHub release: the store is where it is installed from), and `extension-upload.sh --submit` uploads it and submits it for review as `STAGED_PUBLISH`, so an approved version waits for a Publish click in the dashboard. A store failure goes red on its own, and the log names the step (token request, upload, status check, submit). A rehearsal keeps the zip as the `extension` artifact and uploads nothing. The v2 API cannot set listing fields or release a staged item, so those stay manual; see [[component_browser_extension]].
- **`status` reads each component's tag**: not tagged yet, a draft, published, or tagged for the extension, and says what is next from what is not out.
- **Secrets live on the `release` environment**, limited to `main` plus a rehearsal branch, and the notary credentials are given only to the notarize steps.

## The switch to per-platform tags

Releases up to the bridge, the first release after 26.1030.0, were tagged `v<version>` and carried every component's files. Builds up to 26.1030.0 read `/releases/latest` and strip only a leading `v`, so the bridge taught `update.rs` (it lists releases a page at a time until one holds a macOS tag, and takes the newest `macos-v` or `v` release with this Mac's tarball), `install.sh` and `update-cask.sh` both forms. Per-platform tags start two weeks of releases after the bridge, no earlier than 2026-11-13. gettori/packs' `tori-cli.sh` and tori-web's `fetch-packs.mjs` read both forms as well. An install that skipped every release of the hold reinstalls by hand. See [[adr_each_component_releases_on_its_own_tag]].

## What the rehearsals taught

- **Tauri's own signing hides the one thing worth knowing.** It imports the certificate into a private keychain and says only "failed to resolve signing identity". Importing in the open showed the keychain held zero Code Signing identities: the exported `.p12` was the wrong one. A leaf without its chain is also not a *valid* identity, so the G2 intermediate is imported alongside.
- **Build the `.p12` from files, not from a keychain.** The Developer ID key had ended up in the iCloud keychain, which `security` cannot read and Keychain Access would not export. `openssl genrsa` plus a CSR made from that key, and `openssl pkcs12 -export` with the leaf and the G2 intermediate, sidestepped every keychain question.
- **Notarize once per artifact, and never with a single `--wait`.** Apple's queue took 55 minutes, then over two hours; a dropped poll two and a half hours in killed the whole build. `notarize.sh` submits without `--wait`, polls `notarytool info` every minute, tolerates a failed poll and gives up after four hours.
- **A bundle executable is not a standalone binary.** Signed inside the bundle, the main executable's signature hashes `Info.plist` and the resources; copied out, Apple calls it invalid. The CLI is re-signed as a bare binary before its zip is submitted.
- **`bundle_dmg.sh` flakes.** It lays the DMG window out through Finder and AppleScript and now and then fails with no output on a GitHub runner. The build step retries up to three times; the Rust build is already done, so a retry costs seconds. `fail-fast` is off so one arch's flake does not throw away the other's notarization wait.
- **Artifacts keep their folders.** `upload-artifact` with several paths keeps `dmg/`, `updater/` and `cli/`, so `publish.sh` finds each named file with `find`, not `assets/*`.

## Connections

- [[component_check_script]]: the same rule, "the list exists once", applied to release steps as scripts in `.github/scripts/` that run locally.
- [[concept_derived_release_inputs]]: how `ships.sh` decides that a component changed.
- [[adr_each_component_releases_on_its_own_tag]]: why each component has its own version and tag.
- [[lesson_privacy_claims_are_assertions_about_the_binary]]: the update check in `update.rs` is the other outbound call; it lists the releases and takes the newest macOS one with this Mac's tarball.
- `docs/RELEASING.md` is the operator's page: the steps, the secrets table and where each comes from, the rehearsal, the failure table, and the extension and phone protocol rules.

## Known gaps

- **The per-component jobs have not run on GitHub.** The gate, `publish.sh` and the job conditions were checked against a scratch remote, a fake `gh` and actionlint; the first rehearsal after the switch is their first real run.
- **A release while the previous extension version is still in review**, or approved and unpublished, may get its upload or submit refused; the job goes red. Expected; publish or cancel the waiting one and re-run. The four `CWS_*` secrets depend on a production OAuth consent screen ([[gotcha_a_testing_oauth_app_mints_refresh_tokens_that_die_in_7_days]]).
- **The PRs merged before the template changed have no `## Changelog`.** `prepare` stops on each (#283 first) until their bodies are edited.
- Apple issued the Developer ID certificate for thirteen months (to Nov 15 2027), not the usual five years. Signatures and tickets outlive the certificate; the renewal is a calendar entry.
- `gettori/tori` is hardcoded in `update.rs` and in the scripts' defaults; a fork or rename silently checks the wrong repo.
