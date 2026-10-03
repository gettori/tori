# Installing Tori

Tori is macOS only, and ships as an unsigned universal app (Apple Silicon and
Intel). Unsigned means macOS will refuse to open it on the first try. That is
expected, and getting past it takes about ten seconds.

> Tori is unsigned because it has no Apple Developer certificate yet. Signing
> and notarization are planned; until then the steps below are the cost of
> installing it. If that trade is not one you want to make, building from
> source is always an option (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Install with Homebrew

```sh
brew install --cask gettori/tap/tori
```

The cask clears the quarantine flag for you, so the Gatekeeper steps below are
only for a DMG you downloaded yourself. The rest of this page is that route.

## 1. Install

1. Download `Tori_<version>_universal.dmg` from the
   [Releases page](https://github.com/gettori/tori/releases).
2. Open the DMG and drag **Tori** into **Applications**.
3. Eject the DMG.

## 2. Open it the first time

Double-click Tori in Applications. macOS will block it with a message like
*"Apple could not verify 'Tori' is free of malware."* Dismiss that dialog, then:

1. Open **System Settings**.
2. Go to **Privacy & Security**.
3. Scroll down to the **Security** section. You will see a line naming Tori,
   with an **Open Anyway** button next to it.
4. Click **Open Anyway**, then confirm (Touch ID or your password).

Tori opens, and every later launch is a normal double-click.

> **The "right-click and choose Open" trick no longer works.** It was the
> standard advice for years, and it was removed in macOS 15 (Sequoia). If you
> find that suggestion elsewhere, it is out of date - use **Open Anyway**
> above.
>
> The **Open Anyway** button only appears *after* you have tried to open the
> app at least once. If you do not see it, go back and double-click Tori
> first.

## 3. Or, from the terminal

Removing the quarantine attribute does the same thing in one command:

```sh
xattr -cr /Applications/Tori.app
```

Then open Tori normally. This clears the flag macOS attaches to downloaded
files; it is what the **Open Anyway** button does under the hood.

## The phone app

`Tori_<version>.apk` on the
[Releases page](https://github.com/gettori/tori/releases) is Tori on
Android. It pairs with a Mac running Tori rather than standing alone, so turn on
Settings > Remote there first, pick an address the phone can reach (Tailscale on
both, across networks), then scan the QR the Remote pane shows.

The APK is signed with Tori's own key rather than distributed through Play, so
Android asks once whether to allow the install. Later releases carry the same
key and install over the top.

## Requirements

- **macOS.** Tori is developed and tested on macOS 15, and the bundle sets no
  minimum version, so older releases are untested rather than blocked. The
  Gatekeeper steps above are written for macOS 15 and later; on older versions
  the **Open Anyway** button lives in System Settings (or System Preferences)
  under Privacy & Security too, and the right-click-Open trick still works
  there.
- **Apple Silicon or Intel.** The DMG carries a universal binary.
- **At least one agent CLI installed.** Claude Code ships supported; see ADAPTERS.md to add another.
  Tori drives the agents you already have; it does not bundle one. After first
  launch, Settings > Agents shows which ones it found.
- **Node.js**, if you want the bundled TypeScript language server to run.

## Updating

Tori checks for a newer release on launch (once a day at most) and shows a
dismissible notice in the title bar when one exists. An alpha build hears of
alphas, a stable build only of stable releases. It never downloads or installs
anything by itself: on a Homebrew install the notice offers **Install**, which
runs `brew upgrade --cask tori` in a terminal tab and offers to relaunch when it
finishes; otherwise click through to the release and repeat the steps above. Replacing an unsigned app
re-triggers quarantine anyway, so an in-place auto-update would not save you
the **Open Anyway** step.

To stop the check entirely, use the app offline; a failed check is silent.

## Older builds

Alpha builds up to 26.1002 were published in a separate repository, which is
archived and still downloadable:
[gettori/releases](https://github.com/gettori/releases/releases). The first
twelve are from before the rename and are called Sway.

## Uninstalling

`brew uninstall --cask tori`, or drag `/Applications/Tori.app` to the Trash.
Everything else Tori writes lives under a single directory, `~/.config/tori/`:

- `settings.json` - appearance, typography, layout preferences
- `tori.toml` - your spaces, projects, and folders
- `agents/` - adapter overrides, if you added any
- `checkpoint-index/` - per-turn checkpoint snapshots
- `state.json`, `hooks-status/` - first-run flag and live session status

One cache lives outside it: `~/Library/Caches/tori/`, holding the published
model list the context meter reads. Deleting both directories removes every
trace. Tori never touches your agent
CLIs' own session data, so your agent transcripts are unaffected.
