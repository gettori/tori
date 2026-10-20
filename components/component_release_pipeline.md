---
summary: a release is one PR whose notes come from merged PR bodies, then the Release workflow signs, notarizes, tags and publishes from the merge
status: current
updated: 2026-10-20
source: branch changelog-from-prs (commits eaeb37b4 to e3eb04d2); .github/workflows/release.yml; .github/scripts/*.sh; scripts/release.sh; docs/RELEASING.md; rehearsal run 38861320785; extension job from gettori/tickets#89 (branch `browser-extension`, commits 5fd3c397, e22ab1de), `.github/scripts/extension-zip.sh`, `.github/scripts/extension-upload.sh`
---

# Release pipeline (release PR, CI build, signed DMGs, cask)

**Location:** `scripts/release.sh`, `.github/workflows/release.yml`, `.github/workflows/changelog.yml`, `.github/workflows/cask.yml`, `.github/scripts/*.sh`, `.github/pull_request_template.md`, `CHANGELOG.md`, `docs/RELEASING.md`

Everything between "the features are merged" and "a stranger has Tori running": how the notes are collected, how the release PR is cut, and what GitHub Actions does once that PR lands on `main`. Nothing in the release path runs on a maintainer's Mac any more.

## Responsibilities

- **Every PR carries its own release notes.** The PR template has a `## Changelog` section: bullets written for a user, or the word `none`. `changelog.yml` runs `pr-changelog.sh` on every PR body (including `edited`, so fixing the body turns it green) and fails a missing, empty or non-bullet section. `CHANGELOG.md` is never edited between releases; a `## Unreleased` section is only for a note no single PR owns.
- **`prepare` assembles the version's section.** `scripts/release.sh prepare` lists the PRs merged into `main` since the last tag (`changelog-from-prs.sh`: a `gh pr list` by merge date, filtered to merge commits inside `last_tag..origin/main`, release branches skipped), pulls each `## Changelog` out with the same parser the check used, puts anything under `## Unreleased` above them, writes `## <version>`, bumps the five version files and both lockfiles, and opens the PR `Tori <version>`. A merged PR without a usable section stops it and is named with the `gh pr edit` that fixes it. `publish` is gone; `status` reads the workflow run.
- **The merge is the trigger, not a tag.** `release.yml` runs on every push to `main`. Its `gate` job releases only when `tauri.conf.json`'s version has a `## <version>` section and no `v<version>` tag exists yet; an ordinary merge ends there in seconds. A tag pushed with `github.token` starts no workflow, so the tag could never have been the trigger; it is made last instead.
- **One signed, notarized DMG per Mac architecture.** The `macos` matrix builds `aarch64-apple-darwin` natively and `x86_64-apple-darwin` cross-compiled, both on `macos-14`. `import-signing-identity.sh` puts the Developer ID into a keychain of its own together with Apple's G2 intermediate and hands Tauri the identity's hash, so no name has to match. Tauri signs the app and the DMG; `notarize.sh` submits the DMG (one submission covers the app inside), polls on its own schedule, and staples the DMG. `check-bundle.sh` fails any Mach-O that is not the one arch and any signature that does not verify `--deep --strict`. `cli-tarball.sh` re-signs the binary standalone, notarizes it as a zip, and packs `tori-cli-<version>-macos-<arm64|x64>.tar.gz`.
- **Android is arm64 only**, built on Ubuntu with the keystore written from secrets, verified with `apksigner`, named `Tori_<version>.apk`.
- **Publish only after every build passed.** The `publish` job tags the commit, drafts the release with the five files, checks the asset list, undrafts, and runs `update-cask.sh`, which rewrites `Casks/tori.rb` with `on_arm` and `on_intel` checksums and no quarantine workaround. A failed build leaves no tag and no draft; the next merge to `main` simply tries again under the same version.
- **The extension goes to the Chrome Web Store, staged.** The `extension` job runs after `publish` (`needs: [gate, publish]`, `!cancelled()`), builds the store zip with `extension-zip.sh`, and `extension-upload.sh --submit` uploads it and submits it for review as `STAGED_PUBLISH`, so an approved version waits for a Publish click in the dashboard. Nothing waits on the job: a store failure goes red on its own after the release is out, and the log names the step (token request, upload, status check, submit). A rehearsal keeps the zip as the `extension` artifact and uploads nothing. The v2 API cannot set listing fields or release a staged item, so those stay manual; see [[component_browser_extension]].
- **Secrets live on the `release` environment**, limited to `main` plus a rehearsal branch, and the notary credentials are given only to the two notarize steps. `workflow_dispatch` is the rehearsal: everything builds, artifacts are uploaded, nothing is published.

## What the rehearsals taught

- **Tauri's own signing hides the one thing worth knowing.** It imports the certificate into a private keychain and says only "failed to resolve signing identity". Importing in the open showed the keychain held zero Code Signing identities: the exported `.p12` was the wrong one. A leaf without its chain is also not a *valid* identity, so the G2 intermediate is imported alongside.
- **Build the `.p12` from files, not from a keychain.** The Developer ID key had ended up in the iCloud keychain, which `security` cannot read and Keychain Access would not export. `openssl genrsa` plus a CSR made from that key, and `openssl pkcs12 -export` with the leaf and the G2 intermediate, sidestepped every keychain question.
- **Notarize once per artifact, and never with a single `--wait`.** Apple's queue took 55 minutes, then over two hours; a dropped poll two and a half hours in killed the whole build. `notarize.sh` submits without `--wait`, polls `notarytool info` every minute, tolerates a failed poll and gives up after four hours.
- **A bundle executable is not a standalone binary.** Signed inside the bundle, the main executable's signature hashes `Info.plist` and the resources; copied out, Apple calls it invalid. The CLI is re-signed as a bare binary before its zip is submitted.
- **`bundle_dmg.sh` flakes.** It lays the DMG window out through Finder and AppleScript and now and then fails with no output on a GitHub runner. The build step retries up to three times; the Rust build is already done, so a retry costs seconds. `fail-fast` is off so one arch's flake does not throw away the other's notarization wait.
- **Artifacts keep their folders.** `upload-artifact` with two paths keeps `dmg/` and `cli/`, so the publish job attaches files found with `find`, not `assets/*`.

## Connections

- [[component_check_script]]: the same rule, "the list exists once", applied to release steps as scripts in `.github/scripts/` that run locally.
- [[lesson_privacy_claims_are_assertions_about_the_binary]]: the update check in `update.rs` is the other outbound call; it compares the latest tag and, on a Homebrew install, offers `brew upgrade --cask tori`.
- `docs/RELEASING.md` is the operator's page: the steps, the secrets table and where each comes from, the rehearsal, and the failure table.

## Known gaps

- **A release while the previous extension version is still in review**, or approved and unpublished, may get its upload or submit refused; the job goes red. Expected; publish or cancel the waiting one and re-run. The four `CWS_*` secrets depend on a production OAuth consent screen ([[gotcha_a_testing_oauth_app_mints_refresh_tokens_that_die_in_7_days]]).

- **The `publish` job has not run.** Every rehearsal is a `workflow_dispatch`, which skips it by design; the first real release is its first run. A failure there leaves at most a tag and a draft.
- **The PRs merged before the template changed have no `## Changelog`.** `prepare` stops on each (#283 first) until their bodies are edited.
- gettori/packs pins `tori-cli-<version>-macos-universal.tar.gz`; its `tori-support.json` needs the arm64 and x64 names at the first release. The download page on tori-web needs two links.
- Apple issued the Developer ID certificate for thirteen months (to Nov 15 2027), not the usual five years. Signatures and tickets outlive the certificate; the renewal is a calendar entry.
- `gettori/tori` is hardcoded in `update.rs` and in the scripts' defaults; a fork or rename silently checks the wrong repo.
