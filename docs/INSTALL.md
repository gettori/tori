# Installing Tori

Tori is macOS only. It is signed with a Developer ID and notarized by Apple,
so it opens like any other app: no warning, no Settings detour.

## Install from a terminal

```sh
curl -fsSL https://gettori.app/install | sh
```

The script picks the build for your Mac (Apple Silicon or Intel, even from a
terminal running under Rosetta), checks it is signed by Tori's team and passes
Gatekeeper, puts it at `/Applications/Tori.app` and opens it. Run it again to
reinstall the latest release. From then on Tori updates itself.

## Install with Homebrew

```sh
brew install --cask gettori/tap/tori
```

Tori updates itself here too; `brew upgrade --cask tori` is not needed. The
rest of this page is the DMG route.

## From the DMG

1. Download the DMG for your Mac from the
   [Releases page](https://github.com/gettori/tori/releases):
   `Tori_<version>_aarch64.dmg` on Apple Silicon (M1 and later),
   `Tori_<version>_x64.dmg` on Intel. Not sure which you have? Apple menu >
   About This Mac says either *Chip: Apple M1* (or M2, M3, M4) or
   *Processor: Intel*.
2. Open the DMG and drag **Tori** into **Applications**.
3. Eject the DMG and open Tori.

If macOS still says the app is damaged or from an unidentified developer, the
download did not complete or you have a build from before signing (anything up
to 26.1015). Download the current release again.

## The phone app

`Tori_<version>.apk` on the
[Releases page](https://github.com/gettori/tori/releases) is Tori on
Android. It pairs with a Mac running Tori rather than standing alone, so turn on
Settings > Remote there first, pick an address the phone can reach (Tailscale on
both, across networks), then scan the QR the Remote pane shows.

The APK is signed with Tori's own key rather than distributed through Play, so
Android asks once whether to allow the install. Later releases carry the same
key and install over the top. It is built for 64-bit ARM, which is every phone
sold since about 2016.

## Requirements

- **macOS 13.4 or later.** Tori is developed and tested on macOS 15. It will
  not open on anything older than 13.4.
- **Apple Silicon or Intel**, each with its own DMG. Homebrew picks the right
  one. Read aloud and dictation run on Apple Silicon only.
- **At least one agent CLI installed.** Claude Code ships supported; see ADAPTERS.md to add another.
  Tori drives the agents you already have; it does not bundle one. After first
  launch, Settings > Agents shows which ones it found.
- **Node.js**, if you want the bundled TypeScript language server to run.

## Updating

Tori checks GitHub's latest release on launch and every six hours, and shows a
dismissible notice in the title bar when it is newer. **Install** downloads the
build for your Mac, checks it is signed by Tori's team, passes Gatekeeper and
is the version the release names, and puts it in place of the running app.
**Restart to update** then opens it. Tori's daemon moves to the new version
once no session is working, the same as after any install.

Nothing installs without the click. The notice says why it cannot install
instead when Tori runs from the DMG or from somewhere it cannot write: move it
to Applications first. A failed check is silent, so to stop it entirely use the
app offline.

Builds up to 26.1022 cannot update themselves: install the next release once by
any route above.

## Older builds

Alpha builds up to 26.1002 were published in a separate repository, which is
archived and still downloadable:
[gettori/releases](https://github.com/gettori/releases/releases). The first
twelve are from before the rename and are called Sway. Those and every build up
to 26.1015 are unsigned: macOS blocks them on first open, and the way past that
is System Settings > Privacy & Security > **Open Anyway**, or
`xattr -cr /Applications/Tori.app` from a terminal.

## Uninstalling

`brew uninstall --cask tori` for a Homebrew install; otherwise drag
`/Applications/Tori.app` to the Trash.
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
