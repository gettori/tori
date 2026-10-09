# Releasing Tori

`main` takes no direct push, so a release is a pull request like any other
change, and the build happens after it merges. One script does both halves:

```sh
scripts/release.sh status     # which step is next
scripts/release.sh prepare    # open the release PR
# merge the PR on GitHub
scripts/release.sh publish    # build, tag, publish, bump the cask
```

This page is written for a person and for a coding agent alike. Every step
either finishes or stops with one `error:` line that says what to fix.

## Before you start

- Everything that should ship is merged into `main`.
- `CHANGELOG.md` on `main` has a `## Unreleased` section describing it. That
  section becomes the release notes, word for word. If it is missing, write it
  and merge it first.
- To change stage (alpha to beta, beta to stable), change the suffix of
  `version` in `src-tauri/tauri.conf.json` and the four files that mirror it,
  in an ordinary PR. The script carries whatever suffix it finds.

## 1. Prepare

```sh
scripts/release.sh prepare
```

Run it from any checkout, on any branch, clean or not. It works in a throwaway
worktree of `origin/main` and leaves yours alone. It:

1. picks the version, `YY.MDD.patch` from today's UTC date plus the current
   suffix (the second release of a day gets patch 1),
2. renames `## Unreleased` to `## <version>` in the changelog,
3. writes the version into the five files that carry it and both lockfiles,
4. commits that as `Tori <version>` on a branch `release/<version>`, pushes it,
   and opens the pull request with the notes as its body.

It shows the version and the notes and asks before it pushes anything.

It refuses when a release PR is already open, when the branch already exists,
or when the changelog has no section to release.

## 2. Merge

Merge the release PR on GitHub once its checks pass. Merge nothing else until
the release is published: `publish` insists that the release commit is the tip
of `main`, because anything merged after it would ship under that version
without being in its notes.

## 3. Publish

```sh
cd <a checkout of main>
git pull
scripts/release.sh publish
```

This one must run in a checkout that sits exactly on `origin/main` with a clean
tree. It builds what is on disk, and the tag has to name the commit that was
built. It:

1. checks the Android toolchain, the signing keystore, and that the repo is
   public, before any long build,
2. builds the universal macOS app and checks every binary in it is universal,
3. builds and signs the Android APK,
4. tags the commit `v<version>` and pushes the tag,
5. creates the GitHub release as a draft, confirms both files are attached,
   then publishes it,
6. points the Homebrew cask at the new DMG.

It needs, on this Mac: Rust with `rustup`, Node 22 and pnpm, a JDK 17, the
Android SDK and NDK, `mobile/src-tauri/gen/android/keystore.properties` with
the release keystore, and `gh` logged in with write access to `gettori/tori`
and `gettori/homebrew-tap`. Expect twenty minutes or more.

## Running it without a prompt

`prepare` and `publish` ask one yes or no question. With `--yes` they do not:

```sh
scripts/release.sh prepare --yes
scripts/release.sh publish --yes
```

Without a terminal the flag is required, and the script stops rather than
guess. An agent asked to cut a release should run `status` first, then the step
it names, with `--yes`, and should not merge the release PR itself unless told
to.

## When a step stops halfway

Run `scripts/release.sh status`. Then:

| What happened | What is left behind | What to do |
|---|---|---|
| `prepare` failed before the PR | nothing, or a `release/<version>` branch on GitHub | delete that branch if it exists, run `prepare` again |
| The release PR is wrong | an open PR | close it, delete its branch, fix `main`, run `prepare` again |
| `publish` failed during a build | nothing: the tag is made only after both builds | fix the cause, run `publish` again |
| The APK build says `Unresolved reference: TauriActivity` | nothing | the identifier changed since the last Android build on this machine, and Tauri's build script did not notice: `cargo clean -p tauri --release --target <triple>` for the four Android triples, delete the stale `gen/android/app/src/main/java/<old package path>`, run `publish` again |
| `publish` failed during upload | the tag and a draft release | run `publish` again, it replaces the draft |
| `publish` failed at the cask | a published release, the old cask | `publish` will not run again on a published release, so dispatch the `Update cask` workflow or edit the cask by hand |
| Something merged after the release PR | `publish` refuses | run `prepare` again for a new version that includes it |

A tag that has been pushed is never moved. If a published release is bad, cut
the next one.

## Packs

Every release carries `tori validate-pack` and `tori packs-index`, and
gettori/packs runs them in CI from a released binary. So a release that changes
what a loader accepts is also a change to what packs CI accepts:

- Run `tori validate-pack src-tauri/packs` before tagging. It checks every
  bundled pack the way a contribution is checked, offline; add `--assets
  --registry` to also download each release asset and look up each pinned
  package. nix, gemini and kimi fail it until someone measures them; each
  file's header says why.
- A new `schema_version` for any kind needs a line in gettori/packs'
  `tori-support.json` naming this release, after it is published. Until then
  `tori packs-index` refuses a pack written at that version.
- `packs-index` signs with an Ed25519 key in PKCS#8 PEM. macOS's own `openssl`
  (LibreSSL) cannot make one; use Homebrew's: `$(brew --prefix
  openssl@3)/bin/openssl genpkey -algorithm ed25519`.

## The workflows

`.github/workflows/release.yml` builds a DMG from a pushed tag. It is not the
release path yet, since it cannot sign the APK, and it must stay disabled while
this script is: both would try to create the same release. Enable it only to
rehearse by manual dispatch, and disable it again afterwards.
