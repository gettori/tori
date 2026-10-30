---
summary: macOS, Android and the extension each ship on a <platform>-v tag only when their derived inputs changed; arches stay assets
status: current
updated: 2026-10-31
source: release-per-component plan (branch release-per-component), interview and adversary pass 2026-10-30; commits d90b2678, 9e2a4c63, e42c2b91, 0fa86202 and the phone-protocol commit; .github/scripts/components.sh:32; scripts/release.sh:362; src-tauri/src/update.rs:241; src-tauri/src/rpc/phone.rs:24; mobile/src/remote.ts:51; docs/RELEASING.md
---

# Each component releases on its own tag, only when it changed

**A release ships only the components whose real inputs changed since the tag of the version each one carries.** Each component keeps its own version and ships when that version equals the release version (the first versioned section of CHANGELOG.md, stage suffix stripped where the component drops it) and no tag has released it yet: its `<platform>-v<version>` tag, or the `v<release>` every release before the switch carried. Tags are per platform (`macos-v`, `android-v`, `extension-v`, later `windows-v`, `linux-v`, `ios-v`); architectures are assets inside one release.

## Why

Building and notarizing a Mac app for a phone-only change wastes an hour of CI and publishes a release with nothing new in it. The extension already worked this way; the phone and the Mac did not. With Windows, Linux and iOS coming, one shared `v*` stream and one GitHub "latest" cannot serve every platform.

## Considered Options

- **One release with partial assets.** Every consumer of `/releases/latest` would have to search back for the newest release holding its asset.
- **Always build macOS, skip only the others.** Smallest change, but not the goal.
- **Per platform and arch tags.** Silicon and Intel share source and trigger, so they never ship apart.
- **Hand path lists for detection.** The phone imports from `../../src`, so a list drifts silently; inputs come from vite's module graph and `cargo metadata` instead, plus the lockfile versions of bundled packages ([[concept_derived_release_inputs]]).
- **Built output hashes.** Exact for the web half, but Rust builds are not reproducible.
- **A shared version that only skips builds.** Versions would stop meaning anything. Separate release PRs per component would split the notes.
- **Keep `v*` for macOS forever.** Collides the day a second desktop needs its own latest.
- **The phone refusing a mismatched `caller`, like the extension host.** `RpcError` carries only a code and a message, so a refusal could not name the side to update without matching text, and the user-facing messages would live in Rust and TypeScript both.
- **Starting the phone protocol at 1, as the extension did.** Phones and daemons already in use send no number, which counts as 0, so a new app would show a false "update Tori" against every current Mac.

## Consequences

- An installed updater up to 26.1030.0 reads `/releases/latest` and strips only a leading `v`, so it cannot read `macos-v*`. The bridge, the first release after 26.1030.0, ships the updater that lists releases and reads both forms (`macos_version`, `update.rs:241`), under an ordinary `v*` tag; the switch waits two weeks of releases after it, no earlier than 2026-11-13. An install that skips the whole hold reinstalls by hand. `install.sh`, `update-cask.sh`, gettori/packs and tori-web read both forms, so they merge any time.
- Each publish job needs only the gate and its own build, so a skipped or failed sibling never skips it. macOS is GitHub's latest release, Android never is, and the extension's tag gets no GitHub release, since the store is its install path. The extension no longer waits for the Mac and Android builds.
- Desktops usually ship together, since nearly every change touches shared code; one desktop is skipped only when every change sits in another platform's own paths.
- Phone and daemon skew becomes routine, so they check a protocol range like [[adr_extension_protocol_range]], with the roles turned around: the phone sends its `PROTOCOL` with `caller`, the daemon judges it against `MIN_PHONE_PROTOCOL..=PHONE_PROTOCOL` and answers `update` (`app`, `tori` or null, `rpc/phone.rs:24`), and the app shows the side to update in its banner (`updateFrom`, `remote.ts:51`). A missing number on either side counts as 0, and all three numbers start at 0.
- The phone floor rises only in a release whose notes tell phone users to update the app, never on its own: a sideloaded APK never updates itself, so a floor raised with a release cuts off every phone nobody updated by hand.

Related: [[component_release_pipeline]], [[component_browser_extension]], [[component_remote_front]], [[concept_derived_release_inputs]].
