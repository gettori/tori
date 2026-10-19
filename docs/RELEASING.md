# Releasing Tori

`main` takes no direct push, so a release is a pull request like any other
change, and the build happens after it merges, on GitHub Actions. One script
opens that PR; merging it is the last human step.

```sh
scripts/release.sh status     # where the release stands
scripts/release.sh prepare    # open the release PR
# merge the PR on GitHub; the Release workflow builds, signs, tags and publishes
```

This page is written for a person and for a coding agent alike. Every step
either finishes or stops with one `error:` line that says what to fix.

## Before you start

- Everything that should ship is merged into `main`.
- Every merged PR has a `## Changelog` section in its body: the bullets a
  user should read, or `none`. The `Changelog` check holds every PR to that,
  so this is normally already true. `prepare` collects those sections, oldest
  first, and they become the release notes word for word. A PR that slipped
  through can be fixed after the fact with `gh pr edit <number>`; nothing
  needs to merge. A note no single PR owns goes under `## Unreleased` in
  `CHANGELOG.md`, in an ordinary PR, and lands above the collected bullets.
- The pack snapshot is current. Run `scripts/sync-packs.sh` and, if it
  changed anything, merge that in an ordinary PR. `src-tauri/packs.lock` names
  the gettori/packs commit the release embeds.
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
2. collects the `## Changelog` section of every PR merged into `main` since
   the last tag and writes them as `## <version>` in the changelog, under
   whatever `## Unreleased` held,
3. writes the version into the five files that carry it and both lockfiles,
4. commits that as `Tori <version>` on a branch `release/<version>`, pushes it,
   and opens the pull request with the notes as its body.

It shows the version and the notes and asks before it pushes anything.

It refuses when a release PR is already open, when the branch already exists,
when a merged PR has no usable `## Changelog` section (it names the PR and the
`gh pr edit` that fixes it), or when there is nothing to release.

## 2. Merge

Merge the release PR on GitHub once its checks pass. Merge nothing else until
the release is published: anything merged after it would ship under that
version without being in its notes, because the workflow builds whatever
commit it runs on.

## 3. The Release workflow

Merging pushes the release commit to `main`, and `.github/workflows/release.yml`
runs on every push to `main`. Its first job decides whether this push is a
release: the version in `tauri.conf.json` has a `## <version>` section in the
changelog and no `v<version>` tag yet. An ordinary merge fails that test in a
few seconds and the run ends there. A release commit goes on to, in parallel:

- **macOS, twice**, one job per architecture (`aarch64-apple-darwin` on the
  runner's own arch, `x86_64-apple-darwin` cross-compiled on the same runner).
  Each builds the app, signs it with the Developer ID under the hardened
  runtime, checks every Mach-O inside is for that arch alone and that the
  signature verifies all the way down, then notarizes the DMG (one
  submission covers the app inside it) and staples the ticket to it. It packs
  the binary as `tori-cli-<version>-macos-<arm64|x64>.tar.gz`, notarized as
  a zip, after checking it answers as the CLI. The arm64 job also runs the
  binary's `tori packs-catalog --check`, which fetches the live index from
  gettori.app and verifies it with the keys this build trusts. Apple's queue
  decides most of the job's length: minutes on a good day, hours on a bad
  one; the wait gives up after four.
- **Android**, arm64 only, on Linux. It writes the keystore from secrets,
  builds, checks the APK is signed, and names it `Tori_<version>.apk`.

Only when all three have passed does the `publish` job tag the commit
`v<version>`, create the GitHub release as a draft with all five files,
confirm each is attached, publish it, and point the Homebrew cask at the two
DMGs. A failed build therefore leaves nothing behind: no tag, no draft.

Expect 25 minutes with warm caches, up to 45 after a quiet week.

`scripts/release.sh status` shows the run and says what, if anything, is next.

## Secrets

The `release` environment on the repo (Settings, Environments) holds them,
with its deployment branches limited to `main` plus any branch you rehearse
from. A workflow run from a PR branch never sees them.

| Secret | What it is | Where it comes from |
|---|---|---|
| `APPLE_CERTIFICATE` | the Developer ID Application certificate, as a base64 `.p12` | Keychain Access, export the certificate with its private key; `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the password set on that export | you chose it |
| `APPLE_API_KEY` | the App Store Connect API key's ID | App Store Connect, Users and Access, Integrations, Team Keys; role Developer |
| `APPLE_API_ISSUER` | that key's Issuer ID | same page |
| `APPLE_API_KEY_CONTENT` | the `.p8` file's text | downloaded once when the key is made |
| `ANDROID_KEYSTORE` | the release keystore, base64 | `base64 -i release.jks \| pbcopy` |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | what `keystore.properties` held locally | same file |
| `TAP_TOKEN` | fine-grained PAT, Contents read and write on `gettori/homebrew-tap` only | GitHub, Settings, Developer settings |

The API key is only the notary service's login; nothing goes to the App
Store. Notarization itself has no fee beyond the developer membership. The
signing identity is not a secret: the workflow imports the certificate into
its own keychain and reads the identity's hash from there, so the name never
has to match anything.

A ruleset on tags `v*` that blocks deletion and non-fast-forward updates is
worth adding. It must not block creation, since the workflow creates the tag
with `github.token`.

## Rehearsing

The workflow can be dispatched by hand from any branch the environment allows.
A dispatched run builds everything a real one does, uploads the DMGs, the
tarballs and the APK as run artifacts, and publishes nothing: no tag, no
release, no cask. Download the DMG onto a Mac that has never seen Tori and
check `spctl -a -vv /Applications/Tori.app` says
`accepted, source=Notarized Developer ID`; the app then opens without a
dialog. Do this before the first real release after any change to signing,
the bundle's contents, or the workflow.

## Running it without a prompt

`prepare` asks one yes or no question. With `--yes` it does not:

```sh
scripts/release.sh prepare --yes
```

Without a terminal the flag is required, and the script stops rather than
guess. An agent asked to cut a release should run `status` first, then
`prepare` if that is what it names, with `--yes`, and should not merge the
release PR itself unless told to.

## When a step stops halfway

Run `scripts/release.sh status`. Then:

| What happened | What is left behind | What to do |
|---|---|---|
| `prepare` failed before the PR | nothing, or a `release/<version>` branch on GitHub | delete that branch if it exists, run `prepare` again |
| `prepare` names a merged PR with no `## Changelog` | nothing | `gh pr edit <number> --body-file <file>` with the section added, run `prepare` again |
| The release PR is wrong | an open PR | close it, delete its branch, fix `main`, run `prepare` again |
| A build job failed | nothing: the tag is made only after every build | fix the cause in an ordinary PR; merging it runs the release again, from the fix commit, under the same version |
| `packs-catalog --check` failed | nothing | the index on gettori.app is missing, expired, or signed with a key this build does not trust: run gettori/packs' Publish workflow, or ship the key first (gettori/packs MAINTAINING.md), then re-run the failed jobs |
| Notarization was refused | nothing | the run prints Apple's log, which names the file; fix and re-run |
| `publish` failed after tagging | the tag and maybe a draft release | re-run the failed jobs from the run page; the draft is replaced |
| `publish` failed at the cask | a published release, the old cask | dispatch the `Update cask` workflow with the version |
| Something merged after the release PR, before its run finished | nothing yet | once the tag exists the gate ignores every later push, so a release that succeeded is unaffected; if its run had failed, the next merge ships under that version with the extra change unlisted, so either accept that or run `prepare` again for a new version |

A tag that has been pushed is never moved. If a published release is bad, cut
the next one.

## Packs

Every release carries `tori validate-pack` and `tori packs-index`, and
gettori/packs runs them in CI from the release's
`tori-cli-<version>-macos-<arm64|x64>.tar.gz`, a tarball holding the app's
own binary as `tori`. Packs CI pins that asset by tag in its
`tori-support.json`, so a missing asset breaks packs CI for that release. A
release that changes what a loader accepts is also a change to what packs CI
accepts:

- Run `tori validate-pack src-tauri/packs` before tagging. It checks every
  bundled pack the way a contribution is checked, offline; add `--assets
  --registry` to also download each release asset and look up each pinned
  package.
- A new `schema_version` for any kind needs a line in gettori/packs'
  `tori-support.json` naming this release, after it is published. Until then
  `tori packs-index` refuses a pack written at that version.
- `packs-index` signs with an Ed25519 key in PKCS#8 PEM. macOS's own `openssl`
  (LibreSSL) cannot make one; use Homebrew's: `$(brew --prefix
  openssl@3)/bin/openssl genpkey -algorithm ed25519`.

## Browser extension protocol

The native host reads frames from extensions whose `protocol` falls in
`MIN_PROTOCOL..=PROTOCOL` (`src-tauri/src/browser_host.rs`), and the extension
sends its own `PROTOCOL` (`extension/src/tab.ts`). Below the range the host
answers "update the Tori extension", above it "update Tori".

- A breaking change to the frame raises `PROTOCOL` on both sides, and the host
  keeps reading the old shape.
- `MIN_PROTOCOL` rises only once the store version that speaks the new
  protocol is public. Never on a release count: every store version waits for
  a review, so a release that drops the old shape too early leaves every
  installed extension refused until the review passes.
