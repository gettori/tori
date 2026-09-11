# Changelog

Hand-written, one section per release. The release workflow extracts the
section matching the tag it was triggered by and uses it as the GitHub Release
body, so a tag with no matching section here fails the release rather than
publishing an empty one.

Versions follow the `YY.MDD.patch` calver form with a stage suffix while
unstable (`## 26.824.0-alpha`); tags carry a `v` prefix (`v26.824.0-alpha`).

## 26.911.0-alpha

Sway's commands get a dock, and they stop depending on your shell. The Shells
sidebar mode is gone: a clone, bootstrap or sign-in opens in a dock at the
bottom of whatever workspace is on screen, and an rc that attaches tmux or
execs another shell no longer eats what Sway types.

### The dock

- Clone, bootstrap and sign-in open in a dock under the work card, in front,
  and the branch you were on stays selected. Before, they opened in the Shells
  workspace off screen, so nothing visible happened.
- The dock hides itself when its last tab closes, so a clean clone is dock up,
  progress, dock gone. A failed one stays with `exit N` on its tab, and the
  toast's Show brings it back in front.
- Cmd+Ctrl+J shows or hides it (Cmd+Shift+J is already the editor's join
  lines). The sidebar strip has a dock button at its right end, with a count of
  its tabs while it's hidden, and the gear moved to the left end.
- The + for a plain shell at your home folder is back, in the dock's strip. A
  dock shell is not restored after a restart.
- The Shells sidebar mode, its tile and its list are gone. The dock keeps its
  height and open state across restarts.

### Shells and your rc

- Every tab's shell gets `TERM_PROGRAM=Sway` and `TERM_PROGRAM_VERSION`, so an
  rc can skip its tmux handover when it sees Sway. These replace whatever Sway
  inherited, so a dev run started from Apple Terminal no longer makes every tab
  source `/etc/zshrc_Apple_Terminal`.
- Sway's own commands exec the program directly instead of typing a runner
  script into a login shell. PATH still comes from your login shell, anything
  else your rc exports doesn't. A failed command keeps its output and exit code
  on screen, a program that isn't on PATH shows `exit 127` instead of a tab
  that runs forever, and Ctrl+C shows `exit 1`.
- An agent tab types the agent in only once the shell actually holds the
  terminal. If something else, tmux say, still has it after 5 seconds, nothing
  is typed and the tab shows a banner naming what took the terminal. The shell
  stays running under it.

## 26.909.0-alpha

Settings grew a real page: every account's own files, listed, opened, created
and removed from where the accounts already are. Codex sessions keep their
conversation across a restart. And one selection recipe now runs through the
sidebar, the settings rail and the tab strip.

### Agent files

- Settings > Agents lists what each account's home actually holds: the
  instructions file, skills, commands, subagents, rules and settings. The
  adapter names those files itself, so what a home contains is the agent's own
  answer rather than a list hardcoded in the UI.
- Each row says whether the thing is on disk, not created, or a link, and where
  a broken link points. A folder answers with how many files it holds and lists
  them.
- A row is a summary you open rather than everything at once. The header
  carries the kind glyph, the name, the path relative to the account home and
  what is there; the absolute path moves into the body, where it is not the
  same home repeated six times.
- Rows open in the editor, reveal in Finder, create from blank with an inline
  name, and hand their path to a chat draft. Every action that has to end in a
  tab is off without a selection, and says why.
- A child opens the file it actually is. A command is `commands/<name>.md` and
  a skill is `skills/<name>/SKILL.md`, and the editor used to be handed the
  folder. Children remove too, a skill recursively: a `skills/<name>/` left
  behind with its SKILL.md gone is a half-skill the agent may still load.
- Models and Files read the same way now. The section keeps its own name and
  the accounts sit past it as tabs, one at a time. Models used to lose the word
  "Models" the moment a second account existed, and Files used to stack the
  same six rows per account down the page.

### Codex sessions

- An ACP agent keeps its conversation privately and replays it only to a
  session that is already running, so a Codex tab restored after a restart
  opened blank. Sway mirrors the events to a log of its own as they go past,
  and a restored chat reads its conversation back from there.
- Your own turn is in that stream. Codex answers with no copy of the prompt, so
  anything reading the log later saw the assistant talking to itself. Sway
  writes down the prompt it sent before the request goes out, and drops an
  agent's echo where there is one.
- The sidebar and the chat's status strip get a true prompt count for an ACP
  session, written down by the mirror as it goes rather than parsed back out of
  every turn of every session on screen.

### Quota

- A week scoped to something you cannot pick and run, like the overage week,
  gets a chip of its own instead of riding the model chip. Turning Fable on
  used to put an overage bar in the titlebar nobody asked for.
- Non-model weekly windows stop being read as models. The endpoint spells
  `seven_day_overage_included` exactly like a model week, so it showed up as a
  model called "Overage included", and a Max capture carries two more of them.
- The titlebar keeps reading the account it is showing. Turning the model bar
  off used to strand that account on a rung with no read path at all, and the
  background poll refused to run unless a chat was open.

### Spaces

- A folder says which branch it means. In a plain repo every branch-unit lives
  in the repository folder, so a lookup keyed on the folder alone always
  answered with the first row: coming back to a space lit the wrong branch, a
  session picked by id landed beside itself, and a terminal tab click could
  raise a checkout confirm for a branch nobody named.
- Creating a worktree or a branch lands the selection on it, so the terminal
  and the editor stop pointing at the old folder. Attaching an existing branch
  still does not, since it checks nothing out.

### Chat

- Ctrl+C empties the composer. A prompt abandoned mid-sentence had to be
  selected and deleted, which is the one editing gesture a shell prompt never
  asks for. The file chips stay, each with its own x.
- A session opened from the sidebar gets its permission mode and its effort
  back. Only a restore carried the pick, so clicking a session in the sidebar
  spawned a child with neither, and the Ask pill turned up over a conversation
  that had been set to something else.
- The transcript's banner follows the account's own Warn at rather than the
  global one, so the accounts card and the chat stop disagreeing about where
  the line is.
- The steer control quotes the cost and not how it was measured. The trial
  count and the CLI version are why the number is trusted, not something the
  person waiting on a steer has any use for.

### Look and feel

- One selection recipe everywhere: the brand bar down the full left edge over a
  wash that fades out to the right, square on the bar's side so no corner clips
  it into a lozenge. The settings rail took the sidebar's, and a tab pill takes
  it turned ninety degrees, bar across the top edge and the wash fading down,
  because a strip marks along the edge its pane hangs from.
- Row hovers fade the way their selections do, in the sidebar's project, branch
  and shells rows and in the feature row, which had been lighting up flat in a
  lighter grey than everything around it.
- The settings fields wear one skin: Select's frame, height and hairline on
  every field, no native spinners on the number fields, and a stepper whose
  number is coloured rather than left black by the browser default.
- The input surface sits on the card's own hue instead of a navy nearly twice
  as saturated, so a field stops reading as a blue chip beside an amber switch.
- Every settings pane opens on the same line, and the rail's group headings
  have air above them.

## 26.908.0-alpha

The sidebar stops asking two questions in two places. The mode switch moved
into the space strip, the project tree lost its card frames and its elbows, and
the Features and Shells lists were redrawn against the design.

### The space strip

- Spaces, Features and Shells left the segmented control at the top and became
  tiles in the strip at the foot of the column. Exactly one tile is lit, and the
  lit one grows into a pill that says its name, because a rail of twelve glyphs
  is a legend you have to learn.
- The tile animates between glyph and pill, and its name truncates as the column
  narrows: Craftsmen, then Cra..., then the glyph alone. Before, one name too
  wide dropped every name in the row at once.
- Tiles pack left with the actions gear alone on the far right. The "new space"
  + is gone, having been a second route to the first entry of that gear's menu.
- The strip sits at the foot of the column in every mode, and ends on the same
  right edge as everything above it.
- The Shells tile carries its running count only while you are in another mode,
  since in Shells the rows below already name every one of them.
- Gone with the segmented control: arrow-key travel between the three modes. Tab
  order follows the strip, and the palette's toggle still cycles all three.

### The project tree

- No card frames and no elbows. Fourteen projects drew fourteen borders around
  content that needs none; a group's left edge is all that marks it now. The
  rail runs under the rows on the project icon's own centre line, so a hovered
  or selected row starts on the rail instead of clear of it.
- The heading over the projects is the space's name at title weight, with what
  kind of thing it is trailing in the quiet tone, rather than an uppercase
  micro-label that named the column without reading as its title.
- A project's disclosure chevron moved into the leading icon slot and cross
  fades with the project's own icon: at rest the slot says what the project is,
  under the pointer it says what clicking does. The right edge is the status
  rollup's alone.
- Branch rows are padded rather than pinned to 30px, so they size from their own
  label and grow with `--ui-scale`, and a row's fill runs to the row's own edge
  the way the project rows above it already did.
- Branch and worktree glyphs are drawn here instead of imported, so a row whose
  session is mid-turn traces its own path rather than wearing another badge.
  Worktrees trade git-fork for a folder with a branch off it, and the two marks
  are tuned to pulse at one tempo.

### Features and Shells

- A Shells row is two lines: status glyph, name, verdict and an unseen dot, then
  the folder and the command line under it. A failed row says `exit 127` rather
  than only that it failed, and a tab that printed while you were elsewhere
  wears a dot.
- A Feature row is two lines as well, and drops the "N changed" count. The
  ahead/behind arrows and the turn ring the design puts in its place have no
  source yet and are deliberately not drawn.
- Repo chips are monospace in a fixed box. Initials cut from a repo name are a
  code rather than a word, and a proportional face set them at widths that made
  the row read as ragged.
- New Feature moved out of the list and into the head row as a `+`, before the
  filter.
- Selected rows in both lists wear the mark a selected branch row already wore.

### Chat

- A tool card no longer opens itself the moment its call fails or is denied. In
  a turn making a dozen calls that reads as the transcript rearranging itself
  under you; the collapsed row already carries the whole signal, naming the tool
  in the failure colour and reading `Failed` or `Denied`.

## 26.907.1-alpha

- The Dock shows the sailboat on its own again, transparent background and
  all, instead of shrunk onto a light tile. macOS Tahoe puts that tile on
  every plain `.icns`, so Sway now sets its icon on the running app the way
  `pnpm tauri dev` and VLC do. Finder and a Dock entry for the closed app
  still show the tile; only an Icon Composer asset can change those.

## 26.907.0-alpha

Accounts: sign in more than once per agent, and every session says which login
it runs as. Quota lands in the titlebar, Sway's own commands become terminal
tabs under a new Shells mode, and PDFs open as real pages you can quote from.

### Accounts

- An account is part of what a session is, the same way the agent is. A chat or
  agent tab is bound to the account it runs as, and a new tab opens on the
  account this project last used.
- Every account carries its own model catalogue, because a catalogue is an
  account's answer rather than an agent's: two logins of one binary can offer
  different models. The model palette splits the provider row accordingly and
  is wide enough for an account name.
- Rename an account in place by clicking its name. Signing one out asks first,
  and says where that account's profile home is.
- The Models section reads as tabs, one account at a time, and stays live.
- Account cards all start closed, and "Add account" sits in the Accounts
  heading beside "Check again".

### Quota

- Every account gets a quota bar in the titlebar, per account rather than per
  agent, with each agent saying how deep its limits can be read.
- Claude's own rate limit frames now keep everything they carry, including the
  per-model weekly window read off its token once you ask for it. All limits
  share one vocabulary.
- Codex is asked for its quota directly, since it never volunteers it on the
  wire the way Claude does.
- Windows are named as the design names them: `Session, 5h rolling`,
  `Week, all models`, `Week, Fable only`, with a settings chip each.
- The poll reads every account, not just the first one.
- The Usage section and its history ring are gone, replaced by a quota card per
  account.

### Shells and commands

- A third sidebar mode, Shells, beside Spaces and Features, carrying a count of
  what is running.
- Sway's own commands (clone, bootstrap, install, sign-in) run as terminal tabs
  in a workspace of their own rather than as opaque jobs. Each runs from a login
  shell with a runner reporting its exit, so `Ctrl-C` leaves you at a prompt
  instead of killing the tab.
- Open your own shell in Shells, with the row you are looking at marked.
- The Jobs tray, drawer and store are deleted; nothing routed to them any more.

### Composer

- `Enter` inside an open code fence adds a line instead of sending half a block.
  `Cmd+Enter` always sends, even with the completion menu open, and a hint under
  the box says so while you are inside a fence.
- Spell check is on, autocorrect and smart dashes and quotes are off, so a
  misspelt word gets marked but identifiers and paths are never rewritten.
- A long paste becomes a file chip.
- A mention chip checks whether its file is still there, on mount and whenever
  you click back into the box. A missing one goes red and says where the file
  was. It carries a rough token count, and can quote from the transcript.
- A pen button writes the draft to a scratch file and opens it in the editor.
  The composer goes read only while that tab is open and says which tab holds
  the draft; every `Cmd+S` lands back in the box.
- Attachments draw as tiles, and clicking one opens the file it names.

### PDF

- A `.pdf` opens as scrollable pages in its own editor tab, rather than falling
  through to the text editor and being read as UTF-8.
- Zoom out, an editable percentage, zoom in and page controls in the editor bar.
- Select a PDF's text and quote it to the agent by page, over a pdf.js text
  layer laid on each page.

### Interface

- A new mark: the sailboat replaces the S-curve tile everywhere it showed, the
  app icon, the Dock, the README and the dev favicon. The master is
  `app-icon.png` at the repo root; `pnpm tauri icon` regenerates the bundle set
  from it.
- The menu-bar item is a template glyph now, the boat's silhouette in
  `src-tauri/icons/tray.png`, so macOS paints it black or white with the bar and
  dims it when the bar is inactive, the way its neighbours behave. It used to be
  the coloured app icon.
- The bundle carries only what a macOS build uses: the Windows `.ico` and Square
  logos are gone, and so are the Vite and Tauri scaffold SVGs. The dev page is
  titled Sway rather than the scaffold's default.
- Settings draws its own scrollbars in both places it scrolls.
- The Ghostty and VS Code hand-offs moved to the right of the bar, and the dev
  tag is gone.
- A working chat tab breathes in its agent's colour again. Since 26.904.0 it
  pulsed in grey: the tint had moved into a cascade layer, and the tab's own
  unlayered rest tone outranked it.
- Right-click any file tree row to reveal it in Finder, selection and all.
- The background task ticker runs with no lane beside it.

### Known limitations

- macOS only; unsigned, so a manual install still needs the steps in
  [docs/INSTALL.md](docs/INSTALL.md).
- Update checking is a notice only; Sway never installs an update for you.

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
