# Installing Sway

Sway is macOS only, and ships as an unsigned universal app (Apple Silicon and
Intel). Unsigned means macOS will refuse to open it on the first try. That is
expected, and getting past it takes about ten seconds.

> Sway is unsigned because it has no Apple Developer certificate yet. Signing
> and notarization are planned; until then the steps below are the cost of
> installing it. If that trade is not one you want to make, building from
> source is always an option (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## 1. Install

1. Download `Sway_<version>_universal.dmg` from the
   [Releases page](https://github.com/skarif2/sway/releases).
2. Open the DMG and drag **Sway** into **Applications**.
3. Eject the DMG.

## 2. Open it the first time

Double-click Sway in Applications. macOS will block it with a message like
*"Apple could not verify 'Sway' is free of malware."* Dismiss that dialog, then:

1. Open **System Settings**.
2. Go to **Privacy & Security**.
3. Scroll down to the **Security** section. You will see a line naming Sway,
   with an **Open Anyway** button next to it.
4. Click **Open Anyway**, then confirm (Touch ID or your password).

Sway opens, and every later launch is a normal double-click.

> **The "right-click and choose Open" trick no longer works.** It was the
> standard advice for years, and it was removed in macOS 15 (Sequoia). If you
> find that suggestion elsewhere, it is out of date - use **Open Anyway**
> above.
>
> The **Open Anyway** button only appears *after* you have tried to open the
> app at least once. If you do not see it, go back and double-click Sway
> first.

## 3. Or, from the terminal

Removing the quarantine attribute does the same thing in one command:

```sh
xattr -cr /Applications/Sway.app
```

Then open Sway normally. This clears the flag macOS attaches to downloaded
files; it is what the **Open Anyway** button does under the hood.

## Requirements

- **macOS.** Sway is developed and tested on macOS 15, and the bundle sets no
  minimum version, so older releases are untested rather than blocked. The
  Gatekeeper steps above are written for macOS 15 and later; on older versions
  the **Open Anyway** button lives in System Settings (or System Preferences)
  under Privacy & Security too, and the right-click-Open trick still works
  there.
- **Apple Silicon or Intel.** The DMG carries a universal binary.
- **At least one agent CLI installed.** Claude Code ships supported; see ADAPTERS.md to add another.
  Sway drives the agents you already have; it does not bundle one. After first
  launch, Settings > Agents shows which ones it found.
- **Node.js**, if you want the bundled TypeScript language server to run.

## Updating

Sway checks for a newer release on launch (once a day at most) and shows a
dismissible notice in the title bar when one exists. It never downloads or
installs anything for you: click through to the Releases page and repeat the
steps above. Replacing an unsigned app re-triggers quarantine anyway, so an
in-place auto-update would not save you the **Open Anyway** step.

To stop the check entirely, use the app offline; a failed check is silent.

## Uninstalling

Drag `/Applications/Sway.app` to the Trash. Everything else Sway writes lives
under a single directory, `~/.config/sway/`:

- `settings.json` - appearance, typography, layout preferences
- `sway.toml` - your spaces, projects, and folders
- `agents/` - adapter overrides, if you added any
- `checkpoint-index/` - per-turn checkpoint snapshots
- `state.json`, `hooks-status/` - first-run flag and live session status

One cache lives outside it: `~/Library/Caches/sway/`, holding the published
model list the context meter reads. Deleting both directories removes every
trace. Sway never touches your agent
CLIs' own session data, so your agent transcripts are unaffected.
