# Changelog

Hand-written, one section per release. The release workflow extracts the
section matching the tag it was triggered by and uses it as the GitHub Release
body, so a tag with no matching section here fails the release rather than
publishing an empty one.

Versions follow the `YY.MDD.patch` calver form with a stage suffix while
unstable (`## 26.824.0-alpha`); tags carry a `v` prefix (`v26.824.0-alpha`).

## Unreleased

- When Tori closes on its own, it writes a crash file under
  `~/.config/tori/crashes/` (version, thread, message, backtrace) and the next
  launch says so, with Reveal and Report buttons. Uncaught errors in the window
  land in the same folder. Settings > Advanced lists the files and shows the
  version you are running. Nothing is sent anywhere without a click: Report
  opens the bug form in your browser, prefilled.
- The "Update available" pill hears of a newer alpha while you run one. It only
  ever looked at stable releases, and every release so far is an alpha, so it
  never showed. Its click opens that exact release, and when Homebrew installed
  Tori it offers Install, which runs `brew upgrade --cask tori` in a terminal
  tab and offers to relaunch once it finishes.
- The chat queue does more. Option+Enter queues for the next turn even when
  the agent can steer, and Enter still steers. A queued message keeps its
  attachments, and each row has a drag handle, Steer now, Edit and Remove.
  Edit opens it in the composer and sets your draft aside until you save or
  cancel; Option+Up edits the latest one. Cmd+Shift+Enter steers the oldest
  queued message. The queue survives a reload or relaunch and comes back
  parked, so nothing goes out until Send now.
- Cmd+S in the chat composer stashes the draft with its attachments and
  empties the box. In an empty box Cmd+S brings it back, or opens a menu when
  more than one is stashed. Up to 20 are kept, across chats and relaunches.
- A chat can watch a pull request. Turn on "Let a chat watch a pull request"
  under Settings > Hosts, then start a watch from the branch row's pull
  request menu or let the agent call it through Tori's MCP tools. Tori wakes
  the chat once it is idle when a check fails, the checks pass, the branch
  conflicts, or someone else comments or reviews. Each wake is a paid turn, so
  wakes are at most one per five minutes.
- Resume at reset: a Claude chat that stopped on a usage limit continues by
  itself shortly after the limit resets. Off by default, under Settings >
  Chat, or for one chat from the limit banner. The queue and the spend ceiling
  still apply.
- A project can have a worktree setup command, set on the Worktree settings
  page (it was Shared in worktrees). It runs in every worktree Tori creates,
  never on reuse and never on a fork's pull request, and a toast says when it
  finishes or fails, with the log one click away. With "wait" on, the
  autopilot and spawned sessions wait for it before starting.
- Space tiles can sit in a rail down the sidebar's left edge (Settings >
  Appearance > Space tiles: Left). The rail scrolls, has a New space tile and
  stays on screen when the sidebar is hidden. With the bottom strip, hiding
  the sidebar leaves a status chip, so a session waiting on you still shows.
- Find and replace in the editor floats over its top right corner: inline
  toggles, a match count inside the field, search as you type, and replace
  behind a chevron.
- A branch row shows its diff size and uncommitted work on its second line,
  and a pull request needing attention gets its own mark. The Changes tab is
  titled with its branch.
- A changed file's diff opens as a preview tab, pinned on double click. Tabs
  show their git status letter, and a diff tab's icon shows its mode.
- A chat draft opened in the editor is a prompt-N tab with a check to send it
  back.
- Tooltips open after 700ms and close as soon as you leave.
- A session spawned from a chat starts in that chat's mode and model.
- A Topic chat is told its Topic with its first message, again after a
  compaction, and on every change to the Topic, not only a new folder. A
  worktree made outside Tori on the Topic branch is adopted as a member.
- Long chats open faster: Tori loads the tail of the history and pages older
  rows in as you scroll up. Code highlighting runs off the main thread, so a
  streaming reply no longer stutters, mermaid diagrams draw only once on
  screen, and a large markdown preview renders in slices instead of freezing
  the window.
- Tori grew sluggish after hours of "needs you" notifications answered from
  the phone. A notification is now taken down once its session moves on.

## 26.1002.1-alpha

- Releases are published at github.com/gettori/tori/releases, beside the
  source. Builds up to 26.1002 look for updates in the old place and will hear
  of one more, which says where to go.
- Join lines is on Ctrl-J. Its old chord, Shift-Cmd-J, has opened the autopilot
  since 26.927, so in the editor it did nothing.
- Codex and Pi chat through `npx`, and the Agents card said Ready without it.
  It now says "Chat needs npx", the picker leaves the row inert with the same
  words, and the terminal, which needs only the agent's own binary, is
  unchanged.
- A link the autopilot writes to a place in Tori opens it again. The sanitizer
  added in 26.1002 dropped the link's target.
- The app's identifier is now `app.gettori.tori`, after the domain it lives at
  (`app.gettori.tori.mobile` on the phone). macOS and Android treat that as a
  new app, once: what the window remembered (open tabs, zoom, view choices,
  unsent PR review drafts) starts fresh, macOS asks for its permissions again,
  and the phone app installs beside the old one and has to be paired again.
  Everything under `~/.config/tori/` is untouched. Remove the old phone app by
  hand.

## 26.1002.0-alpha

A Topic can hold a repository without branching it. A member starts as a
reference, a read only view of the repo's own checkout, and becomes a worktree
when the work needs one. Topic chats run from a home folder that sees every
member. A security audit lands with it: nothing in a folder runs until you
trust the folder, rendered HTML is sanitized behind a content security policy,
and remote devices connect over Tailscale only.

### Topics

- A Topic can attach a project as a reference, with no worktree. Tori never
  stages, commits, discards or pushes in a reference, and a pull is fast-forward
  only. Its row wears a lock, says how far behind origin it is, and warns when
  the checkout is off its default branch or has local changes.
- A member moves between reference and worktree from its menu. Create worktree
  builds it on the Topic branch, and Remove worktree keeps the branch, so
  creating it again picks the work back up.
- A Topic chat starts in the Topic's home folder with every member added, along
  with each member's permission rules and its CLAUDE.md. Running chats pick up a
  member that is added or moved.
- A Topic chat cannot write in a member's repo outside its own worktrees. It
  asks for a worktree instead, and a setting on the Topic menu decides what
  happens then: ask first, create it, or refuse.
- Checkpoints from a Topic chat cover every worktree member, and a rewind checks
  all of them before it writes anything.
- The New Topic dialog is a picker and a picked list: repos on the left grouped
  by Space, a card on the right for each with a Reference or Worktree toggle.
- A Topic draws as a project row with its members as worktree rows under it.
  Collapsed it is one line with member chips and a status. Click a member to
  open the Topic on it. A new Topic opens expanded, and the list keeps its open
  rows across mode switches and restarts.
- An expanded member row shows its pull request on a second line, and a failing
  check lights the member's chip and the Topic's rollup.
- The Topic row shows its chat status beside the sync pill.
- Files, Changes and Pull requests show members as a strip of tabs. Search
  always covers the whole Topic. The titlebar reads Topics > name.
- A Topic's worktrees no longer show under their repository in Spaces. They
  live in their Topic. Turn on Show Topic worktrees in Spaces, in Settings,
  Integrations, to list them there too.

### Security

- Git runs only in a trusted project, since a repository's own config and hooks
  run with it. A refused folder offers the trust prompt.
- claude starts without a folder's own settings until the folder is trusted, so
  its hooks cannot run on the first message.
- No formatter runs in a project that is not trusted. The editor offers to trust
  it once a session on save, and every time on a manual Format Document.
- Rendered HTML is sanitized with DOMPurify. Chat shows raw HTML as text and
  turns a remote image into a link, and links in the Markdown preview are routed
  rather than followed.
- The app has a content security policy on desktop and on the phone, and the
  asset scope is narrowed from every file to the home directory, external
  volumes and temp.
- Remote devices connect over Tailscale or loopback only. A LAN address is no
  longer offered, and one saved by an older build is refused. Settings says why.
- The autopilot no longer answers a worker's permission prompt. It waits on the
  card or a paired device.
- A terminal program can no longer read the clipboard. It can still set it,
  which is how a copy over ssh works.
- The phone's device credential stays out of Android backups and device
  transfers.
- Crates with open advisories are updated: rustls, plist and wayland-scanner.

### Chat

- A chat can notify when it finishes its turn, and both that and needs you can
  play a sound. Each has its own switch in Settings, Chat, Notifications, with
  a play button to hear it. Only the needs you notification is on to begin
  with, as before.
- Collapse agent work, off by default, folds the thinking, tool calls and hooks
  between two replies into a one line card you can open. It is in Settings and
  on the status strip menu.
- Enter sends a question's answers. Shift+Enter is a new line.
- An agent is ready when any of its accounts is signed in, and a new chat with
  no chosen account starts on a signed in one.
- Chat sessions get the login shell's PATH, so hooks find tools that only your
  shell rc adds.

### Files and changes

- A single click in the Files tree opens a preview that the next click
  replaces. A double click on the row or the tab keeps it, as does the first
  edit.
- Open Markdown and SVG rendered, in Settings, Editing, makes the rendered view
  the default.
- The Checkpoints tab lists every session's turns by prompt. A row opens the
  turn's files with their line counts and diffs, and the revert and rewind
  actions.
- Git state refreshes when HEAD, the index or a ref changes outside Tori.
- A new untracked folder shows as its files in Changes, not as one line.

### Elsewhere

- 17 more themes, and the picker is split into Dark and Light tabs.
- The Settings header has a keyboard shortcuts button, and the shortcut sheet
  fits without scrolling.
- Tab strips have no gap between tabs.

### Fixes

- Long sessions stay smoother: looping animations are isolated, Markdown lexing
  is capped per frame, and off-screen terminals give up their WebGL contexts by
  canvas size.
- The Changes panel follows the member picked in the sidebar.
- The tori MCP server still starts when claude settings set their own PATH.

## 26.927.1-alpha

A branch keeps its story after its pull request is done. The pull request stays
on the row once it merges or closes, a deleted remote branch says so, and a
closed pull request can be reopened. The Changes panel learns to rebase, and
the first run intro is drawn with the app's real screens.

### Branches and pull requests

- A worktree keeps its pull request line after the pull request merges or
  closes, with when it happened, on GitHub and GitLab. A new branch reusing an
  old name, or the base branch itself, does not pick up the old one.
- A branch whose pull request merged with nothing made since rests on a faint
  teal wash. A closed one is dimmed.
- A merged branch has nothing left to push unless work came after the merge,
  and Open PR goes away when there is nothing new to propose.
- A branch whose remote was deleted reads as deleted in the sidebar, the
  Changes pill, the Pull Requests panel and the graph header, instead of as
  having no upstream yet. Once its pull request has merged, the pill is a plain
  label, so a push cannot republish it.
- A pull request closed without merging gets Reopen PR where Open PR was. If its
  remote branch is gone, the branch is pushed back first, but only when its tip
  is the pull request's own head and the head is not a fork. Commits made past
  it get Open PR instead.
- A branch whose upstream was force-pushed over it offers a reset to the
  upstream instead of a push and a pull.

### The Changes panel

- Rebase from the Changes menu: onto a branch, interactive, with autosquash,
  and continue or skip one that stopped.
- The commit box is hidden until you turn on Commit in the Changes menu.
- The bottom tabs under Files and Changes fold into +N when they overflow.

### The intro

- Every slide is a miniature Tori window built from the app's own components,
  the cockpit and the phone app included, in a larger dialog.
- The autopilot and the phone app get a slide each, saying where to turn them
  on, since both are off by default.

### Elsewhere

- The Scripts section shows which scripts are running, and clicking one focuses
  its running tab.
- The titlebar's phone button shows whenever remote access is on. With no phone
  paired, its card links to Settings > Remote.
- A project row shows its actions menu under the pointer, and the menu can
  prune stale worktrees.

### Fixes

- On the phone, the bottom bar no longer clips a space's status bubble.
- A dev build keeps its config in `~/.config/tori-dev`, so it no longer takes
  the installed app's remote port and credential.
- Leaving an intro slide no longer pulls focus onto a rail button.

## 26.927.0-alpha

Three things arrive together. Tori has an app socket and a `tori` CLI, so a
shell, an agent or a script can drive the app it is running inside. The
autopilot takes an issue to a pull request you approve, with its workers on
screen in a new Cockpit. And Tori runs on a phone: this release carries an
Android APK beside the macOS DMG.

### The autopilot

- Enable it in Settings and the titlebar carries a Cockpit switch. The
  autopilot itself starts and stops from the cockpit.
- Tell it to work on an issue and it reads the issue, titles the item, links the
  branch, makes the worktree, spawns a worker on the project's picks, and brings
  you a pull request to approve. Asking it to review a pull request runs the
  same way, to one approved review.
- It posts nothing outward on its own. Opening a pull request, submitting a
  review and merging each need an approval you granted for that exact draft, and
  the card shows what would be posted: the title, the branches and the body, or
  the verdict with its line comments, or the merge method and head.
- Every project has a contract: whether work ships as a pull request, how far
  the autopilot goes before it asks, whether it picks work up unasked, and the
  agent, account and model its workers run on.
- It picks up what is assigned to you. Each forge tick reads your assigned
  issues and review requests, and a project's first tick only proposes, so an
  old backlog never starts itself.
- The queue is on disk, so killing Tori and relaunching gives back the same
  items, and an approval nobody answered comes back pending. An item closes
  itself when its pull request merges.
- Workers are locked while it drives them: nothing to type into, nothing to
  close. Stop the autopilot and they go back to being ordinary sessions that
  notify you themselves.
- It wakes from Rust on a worker's question, permission, end, idle, stall or
  pull request change, so waiting costs no tokens. It compacts at a context
  percent you set, and a resume reconciles rather than replaying the brief.
- Every ref it shows reads as the number and the place it lives, so the number
  opens the issue on the forge and the place opens that worktree with the
  worker's tab.

### The Cockpit

- The cockpit opens on a banner saying where the ship stands, the crew as cards
  ringed in the colour of their state, and the activity as a ship's log.
- The banner plays one of six scenes picked from the local hour, dawn to night,
  and turns to a storm when more workers are out than your limit allows.
- The autopilot's own chat is embedded live. Leaving the view detaches from the
  session instead of closing it.

### The phone

- A Tauri Android app, attached to this release as `Tori_<version>.apk`. Pair
  it by scanning the QR in Settings > Remote, or by typing the code.
- It opens on the project tree, each unit's rollup kept live, drawing the
  desktop's own status marks, sync marks and pull request line. Worktree cards
  carry the changed lines and the commits ahead, and one the autopilot is
  working in turns violet.
- A chat streams live: steer it, answer its questions and permission prompts,
  approve a hold, stop a turn, page back through its history. A New pill spawns
  a chat in that folder on the agent last used there.
- The wheel opens the autopilot's own screen: the scene by the hour, your calls,
  the queue and the crew.
- Light and dark on Tori's own tokens, the sailboat on the pair screen and the
  launcher, and a layout that stays put around the keyboard.

### Remote access

- Settings > Remote serves the socket's protocol over a WebSocket on an address
  you pick. Off by default, and it says whether Tailscale is installed and
  connected.
- A device pairs with a one time code that lives five minutes, works once, and
  burns after five wrong tries. Paired devices are listed with Revoke, and a
  phone icon lights in the titlebar while one is connected. Pairing a phone
  again replaces its old entry rather than adding a second.
- A credential is one variant per front, so the network front never takes the
  process token. A device reads, steers, interrupts, answers and approves a hold
  as you. It cannot spawn.

### The tori CLI

- `tori` runs from any shell Tori opened: `sessions`, `session tail`, `events`,
  `steer`, `spawn`, `open`, `budget`, `worktree new`, `checkpoints` and
  `checkpoint diff`, which can now span a run of turns rather than one.
- `tori ask` puts a question card in the chat that called it, with the needs-you
  dot and a notification, and waits for the answer. If the wait runs out it
  prints an id, and `tori ask --wait <id>` collects the answer later.
- Every PTY tab and chat gets a token of its own, so the socket knows which
  session is calling and fills in its project, folder, agent and account. A
  caller holding only the process token is an outside caller with no defaults.

### Tori's own MCP server

- `tori mcp` serves the socket's method table over MCP stdio, so an agent sees
  Tori's own tools and a tool list is trimmed to what that caller may call.
- Every claude session Tori launches gets it with `mcp__tori__*` pre-allowed and
  nothing else, so Tori's tools run without a permission card. An ACP adapter
  gets it when it opts in, which is on for codex and opencode.
- A session spawned by another is a worker. It may ask, and its question reaches
  its spawner, who can answer on your behalf. Spawning and steering stay
  refused to it.

### Sessions

- A session's dot is composed in Rust now, from PTY activity, the transcript
  tail and its own liveness probe, with the webview reporting only what it alone
  knows. The sidebar, the tray, the dock badge, History and the tab marks all
  read what Rust sends, so a window reload keeps them and fires no second
  notification.
- The sidebar's tree is served as `projects.list`, and every session says which
  unit row it belongs to.
- `session.history` pages a conversation by whole turns, and a turn too big for
  one page pages by event inside it.

### Elsewhere

- Every terminal tab carries a leading glyph for its kind.
- The titlebar's usage is one chip of whole percentages, each account still
  opening its own card on hover.
- Holding Cmd underlines what a Cmd-click would jump to.
- What Tori writes into a chat reads as Tori's rather than as yours, drawn
  larger with the plain Tori mark.
- Clicking a needs-you notification lands on the chat that needs you.
- The Ghostty and VS Code buttons are gone from the topbar.

### Fixes

- A question asked while you were elsewhere is still answerable when the view
  attaches.
- The cockpit's chat no longer remounts on every autopilot turn.
- A session whose transcript sits beside a subagent directory no longer reads as
  empty.
- A project's branches and its worktrees are counted apart.
- The phone reconnects when its socket goes half open, and a page of history
  gets 30 seconds rather than 10.
- A dev build keeps its forge token in a file, so a hot reload stops asking for
  your login password.

## 26.922.0-alpha

Tori speaks to language servers and debuggers for languages it had never heard
of a release ago. Servers install from a pinned catalog, linters run beside
them, Python, Go, Rust, C and C++ get debuggers, and anything that would run
your project's own code asks you to trust the project first.

### Language servers

- 34 more languages install from a pinned catalog: npm at an exact version, or
  a GitHub release checked against its sha256 before anything is written. Your
  own copy on the PATH wins over the one Tori installed. The ones a toolchain
  owns say so instead.
- Open a file whose server Tori can install and a banner offers it, with
  Install, Not now and Never for this language. When the install lands, every
  open file that wanted it gets it without reopening.
- Settings > Languages > LSP is a card per server: a dot, a kind tag, a switch,
  the program, the status and the extensions, under Ready, Installable, Manual
  and Per project tabs with counts and a search. Install, Update and Remove sit
  on the card, and a server that needs `brew`, `go install` or `rustup` runs it
  in a terminal inside the card, so Settings stays open and a prompt can be
  answered there.
- A file can have a primary server and secondaries beside it. Their diagnostics
  arrive together, each remembering which server said it, and the Problems
  panel names the source.
- ESLint ships bundled. Biome, oxlint and Ruff run from the project's own
  install.
- Code actions, Format Document and fix-all ask every server on the file that
  can answer. Fix all on save is a new setting, off by default.
- Go to implementation and type definition, on `Cmd-F12` and `Shift-Cmd-F12`.
- A server that dies says so, keeps its last output and can be restarted. One
  that does not count positions in UTF-16 is refused instead of left to write
  edits in the wrong places.
- The breadcrumb bar says what a server is busy with, and a question from a
  server opens a dialog instead of being refused.
- `rust-analyzer` is reported missing when all that is on the PATH is rustup's
  proxy.
- 143 languages highlight, from CodeMirror's own catalogue.

### Project trust

- Opening a file used to run the repo's code: `typescript-language-server`
  loads the workspace's TypeScript and its tsconfig plugins, `rust-analyzer`
  runs build scripts and proc macros. A server like that now starts only in a
  project you trust. JSON, YAML, highlighting, editing and saving never needed
  it.
- The first refused start shows a toast with Trust, and trusting replays what
  was refused, so nothing has to be reopened.
- Debugging is gated for every debugger, not only the ones that run project
  code, because the program being debugged is the project's own.
- Trust lives in `~/.config/tori/trusted.json` and never inside the project, so
  a repo cannot mark itself trusted, and one answer covers every worktree of
  the project. Settings > Languages > Projects lists trusted and untrusted with
  a search, Revoke and Revoke all. Everything you had already opened counts as
  trusted on the first launch of this build.

### Debugging

- Debug adapters are TOML now, the way agents and language servers already
  were, with stdio, TCP and socket launches and user files in
  `~/.config/tori/dap/`.
- Python through debugpy, which Tori installs into a venv of its own while your
  program runs on the project's Python. F5 offers this file, a module, or
  pytest on this file.
- Go through Delve: this package, or its tests.
- Rust, C and C++ through lldb-dap, which Xcode already ships. F5 on a `.rs`
  file offers the package's binaries and runs `cargo build` first, with the
  build in the console and Rust's own formatters loaded, so a String reads as a
  String.
- The debugger comes from the file in front of you, and a target is remembered
  per debugger, so F5 replays the right one. Stop and restart act on the run
  you are looking at.
- Debugger cards carry install, update, uninstall and a switch like the server
  cards, and F5 offers Install when the debugger is missing.

### Formatters and linters

- Formatters are TOML too, and one that declines a file hands it to the next,
  so a `.rs` file in a repo with a `.prettierrc` still reaches rust-analyzer.
- Black, Ruff, oxfmt, gofmt, shfmt, stylua and Vite+ join Biome and Prettier.
  Python tools come from the project's own `.venv` when it has one.
- Linters and Formatters get their own sections in Settings, with a switch per
  job, so Biome can lint without also formatting.

### The editor

- Tab size and indent with spaces are settings, and a file's `.editorconfig`
  outranks them. Whitespace is tidied on save.
- A closed tab keeps its folds as well as its undo history.
- A save that fails says which file and why, and the buffer stays dirty.
- A file that is not UTF-8, or is over 32 MB, shows a banner instead of a
  buffer, so it cannot be overwritten by an empty one. Over 4 MB it opens
  without folding, guides, the minimap or a language server.
- Every editor pane sits in an error boundary with a Reopen button.
- Diff views read like the editor: its font, its surface, its soft wrap.
- The editor's popups and panels wear Tori's own tokens and stop growing at a
  cap.

### Tabs and the dock

- The tab menu has close others, close to the right, close saved, copy path,
  copy relative path and reveal in Finder, acting on the pane's own strip.
- Middle click closes a tab, and a dirty one still asks first.
- A file dragged from the tree onto a pane opens in that pane.
- The launch menu leads with the shell and gives every row a glyph.
- The dock keeps its new shell button beside its tabs, and its hide button at
  the far right.
- `docs/TERMINAL.md` explains what a shell tab inherits and why an rc file that
  attaches tmux does it inside Tori too.

### Fixes

- The Changes count sits in the corner of the tab's icon and stays there when
  the tab is selected.
- Unpublished commits are counted before the first push.
- A worktree branch with no tracking config is pulled from origin.
- The space strip's pill no longer jumps when it opens.
- What `/usage`, `/context` and `/cost` print is shown, and is still there when
  the session is reopened.
- Codex attaches images where the model says it takes them, and its model list
  is read the way the rest of the catalogue is.
- The first file opened after a reload no longer pushes the panes down while
  the editor loads.

## 26.920.0-alpha

Pull requests are read in Tori now. The sidebar says which branches have one,
the panel says where the one in front of you stands, and the review itself,
the files, the conversations, the checks and the verdict, happens in tabs with
room to read them.

### Pull requests

- The Pull requests panel is about the branch in front of you: one pull
  request, where its checks, its reviews and its merge stand, and its files.
  The project's whole list has a tab of its own, and picking a row there opens
  it, including a pull request on somebody else's branch.
- The review happens in the panel. Review, Conversation, Checks and Merge sit
  in a collapsible section at the bottom, at a height that survives a relaunch,
  and each verdict line above opens the one it belongs to.
- A file opens as a diff tab in the stage, with its conversations between the
  rows they are anchored to and a composer under them. File rows take one
  replaceable slot, so walking a forty file pull request does not leave forty
  tabs behind; a double click or the first edit keeps the one worth keeping.
- All files stacks every file into one scroll, for reading a change in order.
  The first ten open on arrival and the rest when you open them.
- The files are a tree, the shape the review on github.com uses, and every row
  carries a Viewed box. A folder's box marks everything under it, and shows a
  dash where only some of its files have been read.
- Checks group by outcome, worst first, with the count and the colour on the
  heading rather than on the name of somebody's job.
- A draft review survives a relaunch. Each held comment remembers the diff row
  it was written against, and the submit is refused if that line has moved or
  now reads differently, or if the branch has moved since the patches were
  read.
- Approve, request changes or comment from the panel or from the pull request's
  own tab. They are one review, not two half-written ones.
- `j` and `k` walk the panel's files, `n` and `p` walk a diff's conversations,
  and `Cmd+Shift+R` opens the tab the review is sent from. These are the app's
  first bare letters, so they stand down while you are typing.
- Merging is still in one place, the panel's merge control, and still gated on
  the server's own verdict.
- A branch with no pull request says which kind of nothing it is, and the four
  you can act on carry the button that does it: push and open one, push only,
  open one, or cut a branch when you are standing on the base.
- Asking an agent to draft the description names what the branch changed,
  measured against the base rather than against everything the base has gained
  since you forked.

### The sidebar

- A branch with a pull request grows a second line for it: the number, the
  state, the checks, the comments and the age, with the title behind a tooltip.
  The marker that said a branch has none is gone, because the missing line says
  it.
- The row's glyph says where you are standing. The branch tip fills and the
  mark brightens, in place of the teal dot beside it.
- A bare repo with no worktrees dashes the folder half of its glyph instead of
  wearing a `stub` pill.
- The conflict count sits on the red mark, so a branch that is both behind and
  conflicting no longer reads `1 master: 1 conflict`.
- The sync chip is rounded like every other control, and its text sits on the
  glyph's line.

### Branches and worktrees

- The add branch dialog fills from what is on disk and opens at once. The
  network is behind a Reload button, and the fetch on open is the scheduled
  quiet one rather than seconds of ssh with nothing on screen.
- Creating a branch or a worktree says where it starts. The base defaults to
  the repo's default branch and is picked from a filtered list rather than a
  scroll of hundreds.
- A local branch nothing is standing on can be deleted from the picker. It asks
  first, and says whether the branch has commits the remote has never seen.
- The picked row keeps its colour and wears a green check, the trash shows
  where the pointer is rather than where Enter goes, and the filter survives a
  click.

### Changes

- The Changes tab carries the number of changed files whenever another pane is
  in front of it, and drops it when its own panel is open and saying it better.
- A worktree's branch is no longer called unpushed in the Changes header while
  the sidebar row counts it. Both measure against the remote branch of the same
  name.

### Fixes

- A fetch that loses a ref to another git on the same repo is no longer
  reported as a dead remote, and a failed fetch's tooltip is clamped to six
  lines instead of carrying the whole of git's output off the screen.
- A tooltip can hold a path without it running out of the box, and the conflict
  list inside one stops at three and a remainder.
- "Last commit now ago" says "just now".
- A branch named like `2427-message-thread` no longer reorders itself to
  `message-thread-2427` when it is truncated from the front.
- Checks on a worktree checkout are found. The panel was looking the poll's
  status up under the worktree folder rather than the project that holds it,
  and reported that nothing had covered the branch.
- A long base name stays inside its button, and Add worktree no longer breaks
  in two when the path hint claims the row.

## 26.918.0-alpha

A fresh Tori opens a setup window instead of an empty sidebar. It shows a
short intro once, then goes through agents, base folder, space, git hosts and
a first project, and ends on a summary before Tori opens.

### First run

- The intro is six slides on how Tori works, one of them on Topics. Finish or
  skip it and it does not show again. If you already saw the old greeting, you
  skip it.
- Agents lists the agent CLIs found on this machine, with version and sign-in
  state. Install and sign-in run in a terminal inside the window, so a login
  prompt can be answered right there.
- Base folder and space are required. Tori does not open until the base folder
  has at least one space, and picking a folder that already has spaces is
  enough.
- Git hosts signs in to github.com or gitlab.com the same way Settings > Hosts
  does, and turns on git push and fetch for that account.
- First project makes a new folder, clones a repo, or sets up a bare repo with
  a worktree for the default branch. If git is missing it offers to install
  it.
- Ready shows what was set up, and for anything skipped, where to finish it.
- Before a space exists the window cannot be closed. After that, Escape or a
  click outside closes it, like Open Tori. Reset root (forget only) in the
  sidebar's menu shows the intro and setup again.
- The sidebar's welcome message and the greeting in Settings are gone.

### Agents

- Claude, Codex, Gemini and OpenCode have Install, Update and Uninstall in
  Settings > Agents, through npm. npm's global bin has to be on your login
  shell's PATH for Tori to find them.

### Topics

- Features are called Topics now, in the sidebar, the dialogs, the command
  palette and the error messages. They are stored under the new name, so
  Features made before this update do not show up. Their worktrees stay on disk
  and still appear in Spaces.
- A Topic's branch is exactly what you type. The New Topic dialog fills Branch
  from the name until you edit it, with no `feat/` prefix, and holds Done on a
  branch name git would not accept.
- A Topic worktree in Spaces wears a small tag instead of the "in <name>" chip.
  Hover it for the Topic's name, click it to open the Topic. The Topics tile in
  the sidebar uses the same tag.

### Spaces

- Pinning a folder from outside the base folder is gone: no "Pin folder" in the
  sidebar's gear menu, no "Unpin" on a pinned project. Spaces now come only from
  the base folder. A `paths` list or a legacy `[[project]]` table left in the
  config is ignored rather than read.

### Hosts

- Signing in to a GitHub host no longer goes through the browser. Tori uses the
  login the GitHub CLI already has where that fits, and asks for a classic
  token otherwise. GitLab still signs in with a code in the browser.
- A GitHub account signed in through the browser before this keeps working.
  Nothing renews it, so if GitHub stops accepting it, sign in again and paste a
  token.

### Fixes

- Bare + worktree from the sidebar now cleans up and shows a failure when the
  clone fails. Before, it printed Done and exited as if it worked.
- A repository URL starting with `-` is no longer read as a git option when
  cloning.

## 26.914.2-alpha

- A new Claude account can use an empty folder. Adding an account from a folder
  used to require Claude's files already in it, so a fresh folder was refused.
  An empty one (a lone `.DS_Store` counts) now goes through the normal login
  tab. A folder holding other files and none of Claude's is still refused, so
  the sign-in never writes into something else.

## 26.914.1-alpha

A project can limit which agents run in it, a new worktree opens straight onto
a chat draft, and a Claude turn that fails now says why.

### Chat

- Creating a worktree from the sidebar opens a chat draft in it, so it no
  longer lands on an empty tab strip. A reused worktree folder with tabs coming
  back keeps those instead.
- A Claude turn that fails on auth shows the reason. The CLI sends it only in
  the final result and never streams it, so the turn used to end with nothing
  on screen.
- When a Claude process dies, its message keeps the reason from stderr instead
  of sometimes losing it to a race with stdout closing.
- A chat stays working while its subagents and background tasks run, and says
  it is waiting on background work, instead of looking finished.
- Subagent lanes put live ones first, and past two finished ones the rest fold
  behind a `+N done` chip. The lane you are reading stays visible when folded.
- The transcript scrolls with the wheel anywhere in the pane, gutters included,
  not just over the centred column.

### Agents and accounts

- A project row's menu has Agents..., to allow only the agents and accounts you
  name in that project. Worktrees inside the repo share its rule, and anything
  else shows as not allowed in this project.
- Claude's Keychain item is read through `/usr/bin/security`, which the item
  already trusts, so macOS stops asking for access after every rebuild.
- Every account on an agent offers the same usage chips, and a second
  account's titlebar row draws all the windows you chose for it unless the
  topbar is narrow.
- The chat's quota notice only speaks for windows the account shows, so the
  overage window no longer warns alongside the weekly one when its chip is off.

### Fixes

- Keeping a shared file in a worktree that git does not list now moves it back
  properly instead of leaving the link behind.
- The commit target chips have names for screen readers.

## 26.914.0-alpha

Claude accounts no longer assume `~/.claude`. You can add an account from a
config folder you already have, and Tori stops creating an empty login on a
machine that keeps Claude somewhere else.

### Accounts

- Add a Claude account from an existing config folder, like `~/.claude-work`,
  instead of one Tori makes. The folder has to already hold Claude's files,
  and if it is already signed in no login tab opens. The default home and a
  folder that is already added are refused.
- A Browse button next to the folder field opens a folder picker with hidden
  folders shown, so dot folders like `~/.claude-work` are pickable.
- Removing an account made from your own folder only forgets it. Nothing is
  deleted, and it is signed out only if you ask for that in the same dialog.
- Tori no longer writes `~/.claude` at launch. Before, the health check, the
  session watcher and the model probe each created it, so a user who keeps
  Claude in another folder got an empty login they never asked for.
- With no `~/.claude` on disk there is no default account: the accounts card
  says the folder is missing, the first account you add becomes the default,
  and Claude cannot be turned on with zero accounts.

### Dialogs

- The add account dialog matches its mockup, on a fixed field rhythm with
  32px controls so Browse and the buttons line up with the fields.
- Every dialog with buttons gets a hairline above its footer, and the head,
  body and footer are padded on their own. Dialog titles step down to 16px.

## 26.913.0-alpha

The right sidebar is rebuilt on VS Code's model: Files, Search and Changes
work like VS Code's explorer, Search view and Source Control. Diffs and merge
conflicts catch up with it too. A diff can show the whole file with git's hunks
drawn over it and stage from there, and a conflict gets an editable Result
pane. Files shared across worktrees get a page of their own.

### Files and Search

- Files is an explorer: member chips for a Feature in the filter row, a branch
  line with New File, New Folder, Refresh and Collapse, and a row menu with
  Open to the Side, Open Preview, Open in Integrated Terminal, Find in Folder,
  Cut, Copy, Paste, Duplicate, Copy Path, Copy Relative Path and file history.
- Scripts, Outline and TODOs are one collapsible section under the tree, one
  tab at a time. The Tasks, Outline, Docs and Shared tabs are gone.
- Search is VS Code's Search view, with replace and details toggles on the
  search line, Includes and Excludes fields, and a Search Editor tab.
- All three sidebar tabs open the same way: a title or the member chips, then
  their controls, then the content.

### Changes and git

- Changes is rebuilt around committing. The commit box sits near the top as one
  card: one message field (Enter commits, Shift+Enter is a newline), what the
  commit would hold, AI Draft and Commit. Commit is never greyed out; clicking
  it says what is missing.
- Inside a Feature the tab shows one member at a time, picked by chip, and
  everything below follows it: the file list, branch, ahead/behind, Push, Open
  PR, stashes, checkpoints, the graph and the commit box.
- A commit graph: one lane in the sidebar, full lanes in a Graph tab. The
  sidebar colours by branch rather than by push, so a pushed branch no longer
  draws all orange, and its page grows until the base branch is on it.
- Graph, Stashes and Checkpoints share one section under the file list. A
  stash or graph row opens to the files that commit touched, and each file
  opens its own diff tab for that commit.
- A file's diff opens in its own editor tab instead of unfolding inside the
  panel, so several can be open and the file list stays put.
- About forty more git commands are in the palette as `Git:` entries. Pull
  passes `--no-rebase` explicitly, so it doesn't rebase just because
  `pull.rebase` is set globally.

### Diffs

- Diff rows are coloured in the file's own language and numbered on both
  sides, in Changes, commit, session and pull request diffs. Copying lines
  copies only the code.
- A diff tab can show the file itself: a read-only buffer with git's hunks
  drawn over it, removed lines in place, changed characters marked, and a
  second gutter with the old line numbers. It has the editor's selection, find
  and vim.
- From that buffer you can stage, unstage and discard a hunk, or select lines
  and stage just those. It sends the backend the same payload the rows do.
- Next and previous change on Alt+F5 and Shift+Alt+F5, unchanged stretches
  folded into a band, and an ignore whitespace toggle.
- The buffer gets blame in the gutter, an overview ruler with removed and added
  strips, and the editor's breadcrumbs.
- In the plain editor, clicking a change mark in the gutter, or the line number
  beside it, shows the lines that used to be there.

### Merge conflicts

- The conflict tab has a third pane, Result, holding the file as it will be
  written, and you can edit it. An undecided conflict offers yours, theirs,
  both, or by hand.
- When the two sides edit different parts of one line, Both becomes Combine and
  splices the edits together, the same idea as VS Code's smart combination.
- Each side pane has Accept and Ignore above every conflict, and its header
  names the branch and short sha behind that side, for merge, cherry-pick,
  revert and rebase alike.
- The Result pane says what each conflict holds (Holds Yours (HEAD), Written by
  hand), with Remove per side and Reset to base. Anything that would throw away
  typed lines asks first.
- The side panes and Result line up region by region and scroll together.
- A conflicted file opened in the plain editor paints its marker blocks, with a
  mark per conflict on a ruler strip, and each block has Accept Current, Accept
  Incoming, Accept Both and Compare above it.

### Shared in worktrees

- A page opened from a project row's menu, under Add Worktree, shows each
  shared entry and which worktrees actually have its link. Before, an entry
  added after a worktree was made never reached it, and nothing showed that.
- Link a single worktree or every gap at once, stop sharing, or move an entry
  back out.
- Share a file from its own row in the tree. Sharing is a move: the file goes
  into the shared folder and its old path becomes a link, so anything reading
  that path keeps working. A file git tracks is refused.
- The project row carries a mark while a worktree is missing a shared entry.
- A shared folder lists as a folder in the tree and search, not as a file that
  fails to open.
- A hidden checkout, like a wiki on an orphan branch, stays out of the
  worktree list.

### Editor

- Lint and the lightbulb are drawn inline, breakpoints show only while
  debugging, and bookmarks are gone.
- Text fields drop their focus ring; the caret is the cue. Buttons, selects,
  switches and tabs keep theirs.

## 26.911.0-alpha

Tori's commands get a dock, and they stop depending on your shell. The Shells
sidebar mode is gone: a clone, bootstrap or sign-in opens in a dock at the
bottom of whatever workspace is on screen, and an rc that attaches tmux or
execs another shell no longer eats what Tori types.

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

- Every tab's shell gets `TERM_PROGRAM=Tori` and `TERM_PROGRAM_VERSION`, so an
  rc can skip its tmux handover when it sees Tori. These replace whatever Tori
  inherited, so a dev run started from Apple Terminal no longer makes every tab
  source `/etc/zshrc_Apple_Terminal`.
- Tori's own commands exec the program directly instead of typing a runner
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
  opened blank. Tori mirrors the events to a log of its own as they go past,
  and a restored chat reads its conversation back from there.
- Your own turn is in that stream. Codex answers with no copy of the prompt, so
  anything reading the log later saw the assistant talking to itself. Tori
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
  narrows: Hooli, then Hoo..., then the glyph alone. Before, one name too
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
  every plain `.icns`, so Tori now sets its icon on the running app the way
  `pnpm tauri dev` and VLC do. Finder and a Dock entry for the closed app
  still show the tile; only an Icon Composer asset can change those.

## 26.907.0-alpha

Accounts: sign in more than once per agent, and every session says which login
it runs as. Quota lands in the titlebar, Tori's own commands become terminal
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
- Tori's own commands (clone, bootstrap, install, sign-in) run as terminal tabs
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
  titled Tori rather than the scaffold's default.
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
- Update checking is a notice only; Tori never installs an update for you.

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

- A pasted or dropped file is written under `~/.config/tori/attachments` and
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
- Update checking is a notice only; Tori never installs an update for you.

## 26.830.0-alpha

Features: one branch across several repositories, worked on as a single
workspace. Plus a chat that remembers where it left off, and a sidebar that
fits.

### Features

- **Features**, a new sidebar mode beside Spaces. A Feature is one branch name
  (`feat/<slug>`) across any set of repositories. Creating one probes each repo
  for an existing branch, offers to adopt it, and builds a worktree per member
  under `.tori/worktrees`; members that fail are listed with a Retry.
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

- Tori asks before quitting, and the red traffic light closes the window.
- The window drags from the titlebar and the sidebar again.
- Breadcrumbs show the whole branch name.
- A `tauri dev` window is told apart from the installed app.

### Install

- The Homebrew cask clears the quarantine flag itself, so
  `brew install --cask gettori/tap/tori` now takes no flags. Homebrew 6 removed
  `--no-quarantine`.

### Known limitations

- macOS only; unsigned, so a manual install still needs the steps in
  [docs/INSTALL.md](docs/INSTALL.md).
- Update checking is a notice only; Tori never installs an update for you.

## 26.824.0-alpha

First public release. macOS only, unsigned (see
[docs/INSTALL.md](docs/INSTALL.md) for the Gatekeeper steps).

### Agents

- Data-driven agent adapters: Claude ships bundled, and any agent CLI can be
  added by dropping a `schema_version = 1` TOML into `~/.config/tori/agents/`.
  See `ADAPTERS.md`. (This release also bundled `pi` and `opencode`; both were
  removed in a later one.)
- An **Agents** section in Settings showing, per adapter, whether its CLI is
  installed, which version, where sessions are read from, and what Tori can do
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
- Update checking is a notice only; Tori never installs an update for you.
