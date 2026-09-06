# Changelog

Hand-written, one section per release. The release workflow extracts the
section matching the tag it was triggered by and uses it as the GitHub Release
body, so a tag with no matching section here fails the release rather than
publishing an empty one.

Versions follow the `YY.MDD.patch` calver form with a stage suffix while
unstable (`## 26.824.0-alpha`); tags carry a `v` prefix (`v26.824.0-alpha`).

## Unreleased

- A new mark: the sailboat replaces the S-curve tile everywhere it showed,
  the app icon, the Dock, the menu-bar tray, the README and the dev favicon.
  The master is `app-icon.png` at the repo root; `pnpm tauri icon` regenerates
  the bundle set from it.
- The bundle carries only what a macOS build uses: the Windows `.ico` and
  Square logos are gone, and so are the Vite and Tauri scaffold SVGs.
- The dev page is titled Sway rather than the scaffold's default.

## 26.904.0-alpha

Subagents get lanes: a chip per helper you can switch into and read while it
works, and again after the session is reopened. Attachments become real chips
that survive a reload.

### Subagents

- Every transcript row now carries the lane that produced it, so a subagent's
  rows no longer arrive indistinguishable from the main agent's on one wire.
- A chip strip above the composer: main first, then one per subagent still
  working, switchable by click or `Opt+N`. Each carries a status dot and one
  figure, elapsed while it runs and its token total once it is done. Selecting
  a lane narrows the transcript to that agent's rows.
- A lane shows what its subagent actually did, with the tool name and its
  arguments. Subagents never stream, so their calls used to reach the panel as
  a bare result with no name on it.
- Reopening a session reads its subagents back off disk, rather than losing
  every lane it had shown.
- A subagent asking for permission inside a lane nobody is watching now shows
  that prompt in main too, with a button into the lane it came from. A lane
  says when it is stuck or has gone wrong.
- The main chip takes the working agent's own hue, orange for Claude, instead
  of sitting grey through every turn.
- The Agents card says which adapters publish `subagents: observable` and what
  that buys you.

### Attachments

- A pasted or dropped file is written under `~/.config/sway/attachments` and
  handed to the agent as a path, the same shape a tree drag or an `@` mention
  already had. Each becomes `[image 3]`, `[pdf 1]` or `[file 2]`, numbered per
  composer and never reused.
- A chip is two controls: its body puts the token in the message by click or
  drag, and the remove button takes the attachment and its token away. An
  accepted `@` mention leaves its token where it was typed.
- An image chip is a 40px preview with its token captioned under it. The remove
  button sits in the top right and stays invisible until the tile is hovered or
  something inside it takes focus.
- A reopened chat gets its attachments back on both replays, the transcript
  Claude writes and the live channel an ACP agent replays over.
- Pasted images draw instead of showing a broken glyph. Tauri's fs scope
  defaults to `require_literal_leading_dot`, so the configured `**` could not
  match a path component starting with a dot.

### Chat

- Sending a prompt keeps you looking at it.
- The composer rests at three rows rather than four.
- Mode and model pills show what the chat was actually spawned on, not the
  adapter's default. On codex and opencode a switch is confirmed from the
  agent's own answer instead of staying frozen at whatever the handshake said.
- A permission-mode pick settles at the turn boundary, and a refusal surfaces
  rather than going quiet.
- The status strip comes down to the height of the breadcrumb bar beside it.
- Follow live edits moved onto the composer's bar, the history button sits past
  the launch control, and the launch button's hover border closes.

### Terminal and jobs

- A pane goes back to whatever is showing in it, one home pane per kind.
- `pty://exit` carries an exit code, so a clean run can be told from a failure.
- A clone, a bootstrap, an install or a sign-in is no longer a tab in the tab
  model.
- A job can be stopped, and says when it ends.

### Elsewhere

- Mermaid fences render as diagrams instead of nine lines of arrow syntax, and
  the preview gets its text back.
- Blame moved to the bar that names the file, so it acts per file rather than
  once for every pane sharing the strip.
- The topbar crumb ends at the branch it names.
- A session whose history could not be read says so with the error on it,
  instead of looking identical to a session with no turns.

### Known limitations

- macOS only; unsigned, so a manual install still needs the steps in
  [docs/INSTALL.md](docs/INSTALL.md).
- Update checking is a notice only; Sway never installs an update for you.

## 26.830.0-alpha

Features: one branch across several repositories, worked on as a single
workspace. Plus a chat that remembers where it left off, and a sidebar that
fits.

### Features

- **Features**, a new sidebar mode beside Spaces. A Feature is one branch name
  (`feat/<slug>`) across any set of repositories. Creating one probes each repo
  for an existing branch, offers to adopt it, and builds a worktree per member
  under `.sway/worktrees`; members that fail are listed with a Retry.
- A Feature opens as one workspace. Editor tabs, terminals, panes and search
  history live under it, while git, the file watcher and the shell follow
  whichever member you are in.
- File explorer, search, Changes, Problems, TODOs and bookmarks draw one
  section per member. Quick open, breadcrumbs, tabs and row menus name the
  repository a file is actually in, so the same `src/index.ts` in two members
  can be told apart.
- Search narrows to the members you picked, and a whole Feature's results open
  as one editable buffer.
- Changes acts per repository: the commit box, the checkpoint strip and the
  git palette commands each target one named member rather than whichever was
  in front. The Feature's sidebar row sums what all of its members have
  changed.
- Rename, reorder, add, repair and remove members from the row menu. Removing
  a repository or deleting a Feature offers what to do with the worktrees
  rather than dropping them.
- A Feature worktree still appears in Spaces, wearing an "in <Feature>" chip
  that opens the Feature with that folder active.

### Chat

- The context meter reads one API response instead of a turn's bill, opens at
  0/1M instead of at nothing, and shows one number over one denominator.
- A compaction says it is running and re-reads its figures afterwards, instead
  of 33 silent seconds.
- A chat comes back on the model, mode and level it was running, and its `/`
  menu completes from whichever agent it is on.
- The composer holds still and the transcript stays pinned to the bottom. A
  long tool call truncates instead of widening the chat.
- A published plan gets its own column and a fold.
- One "Applies to the next turn" note above the input, not one per picker.

### Sessions and sidebar

- Notifications fire when the agent asks a question, not only when it wants a
  permission. One place now answers whether a session is waiting on you.
- Spaces and Features each come back to what they were last on, including the
  worktree a space was left on.
- The current space is named above the tree, the tree is tighter, and the mode
  switch shares a row with the filter.
- The empty area of a space has a right-click menu. A picker commits the row
  you pressed, or nothing.
- A working tab wears its provider's own brand colour.

### Window

- Sway asks before quitting, and the red traffic light closes the window.
- The window drags from the titlebar and the sidebar again.
- Breadcrumbs show the whole branch name.
- A `tauri dev` window is told apart from the installed app.

### Install

- The Homebrew cask clears the quarantine flag itself, so
  `brew install --cask skarif2/tap/sway` now takes no flags. Homebrew 6 removed
  `--no-quarantine`.

### Known limitations

- macOS only; unsigned, so a manual install still needs the steps in
  [docs/INSTALL.md](docs/INSTALL.md).
- Update checking is a notice only; Sway never installs an update for you.

## 26.824.0-alpha

First public release. macOS only, unsigned (see
[docs/INSTALL.md](docs/INSTALL.md) for the Gatekeeper steps).

### Agents

- Data-driven agent adapters: Claude ships bundled, and any agent CLI can be
  added by dropping a `schema_version = 1` TOML into `~/.config/sway/agents/`.
  See `ADAPTERS.md`. (This release also bundled `pi` and `opencode`; both were
  removed in a later one.)
- An **Agents** section in Settings showing, per adapter, whether its CLI is
  installed, which version, where sessions are read from, and what Sway can do
  with it. Binaries resolve against the login-shell PATH, so an agent installed
  via nvm, volta, asdf, or mise is found rather than reported missing.
- First run opens on those cards with a short welcome, once.

### Sessions

- Session tree grouped into spaces, with a git-branch graph, worktree support,
  and focus-or-resume terminal tabs.
- Live status per session: working / needs-you / done, with a bubbling rollup
  to the parent rows. Claude additionally drives status from its own hooks.
- Turn-level checkpoints: snapshot per prompt, per-turn diffs, and revert.
- Transcript viewer, touched-file lists, and a context-window meter for
  adapters that declare one.

### Editor and review

- CodeMirror editor with LSP (TypeScript/JavaScript), diff gutters, and
  markdown/image preview.
- Changes panel with stage, unstage, commit, push, and Open PR.
- Hunk comments and editor-selection mentions sent safely into a session.
- Project-wide search.

### Interface

- Command palette (`Cmd+K`), quick open (`Cmd+P`), a shortcut sheet (`Cmd+/`),
  and remappable hotkeys.
- Menu-bar tray, OS notifications, and a dock badge for sessions needing you.
- Dark and light themes, both fully supported, with VS Code theme file import.

### Known limitations

- macOS only; unsigned, so first launch needs the steps in
  [docs/INSTALL.md](docs/INSTALL.md).
- Update checking is a notice only; Sway never installs an update for you.
