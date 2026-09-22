# Debuggers

F5 runs the program in front of you under a debugger: breakpoints, stepping,
the stack, variables, watch expressions and a debug console. Tori speaks the
Debug Adapter Protocol, and which adapters exist is **data, not code**: each one
is a TOML file, the same shape [LSP-SERVERS.md](LSP-SERVERS.md) describes for
language servers, down to the override and error-handling rules.

## Supported debuggers

| id | Adapter | Languages | How it gets there | Targets |
|---|---|---|---|---|
| `js-debug` | vscode-js-debug | JavaScript, TypeScript | Bundled; run `pnpm dap:install` in a dev tree. Needs `node` on your PATH. | this file, a package script, attach to a port |
| `debugpy` | debugpy | Python | Tori installs it into a venv of its own, from Settings > Debuggers or from F5. | this file, a module, pytest on this file |
| `delve` | Delve (`dlv dap`) | Go | You: `go install github.com/go-delve/delve/cmd/dlv@latest` | the package of this file, its tests |
| `lldb` | lldb-dap | Rust, C, C++, Objective-C | Apple's Command Line Tools or Xcode, found through `xcrun`. Homebrew's `llvm` works once its `bin` is on your PATH. | a Cargo binary, built first; a binary you pick |

Every one of them launches a program. Attaching to a process somebody else
started is js-debug only (`node --inspect`).

A language with no adapter is a supported state. Its files open, edit and run
as usual; they just cannot be debugged from Tori.

## Starting a run

**F5** starts debugging, **Shift+F5** stops it.

The file you are looking at decides the adapter, by its extension. F5 replays
the last target you ran under that adapter in this workspace, or opens that
adapter's picker when there is none yet. From a tab no adapter claims (a
Markdown file, `Cargo.toml`, no tab at all) F5 replays the workspace's most
recent target, whichever adapter it was, or opens the picker with a choice of
debugger.

- A target is remembered **per workspace and per adapter**, so a workspace with
  a Go service and a TypeScript frontend keeps one of each. C, C++ and Rust
  share lldb-dap's one slot, so F5 on a `.c` file replays a Cargo target if
  that ran last.
- A remembered file target whose tab is closed is not replayed; F5 asks again.
- Stop and Restart act on the run selected in the debug pane, else the most
  recent one. Restart replays that run's own target, even when the tab in front
  of you belongs to another adapter.
- The command palette's "Debug this file", "Debug a package script" and
  "Attach the debugger to a port" rows run under the active file's adapter when
  it offers that kind of target, else under the first adapter that does.

If the adapter is not installed, F5 says so in a toast with an Install button:
Tori's own install for `debugpy`, or the first backticked command in the
adapter's hint, run in a terminal tab. The run does not start by itself after
an install; press F5 again.

### Targets per adapter

| Adapter | Target | What runs |
|---|---|---|
| `js-debug` | This file | `node <file>`. The file's extension has to be one js-debug claims. |
| | A package script | A script from the resolved root's `package.json`, through the runner its lockfile names (`pnpm run dev`, not `npm run dev`). |
| | Attach to a port | A process started with `--inspect`, default port 9229. |
| `debugpy` | This file | `python <file>` |
| | A module | `python -m <module>` |
| | pytest on this file | `python -m pytest <file>` |
| `delve` | The package of this file | `mode: "debug"` on the file's directory, what `go run` builds. |
| | Its tests | `mode: "test"` on the same directory, run from it the way `go test` runs, so `testdata/` resolves. |
| `lldb` | A Cargo binary | The picker lists the root package's `bin` targets from `cargo metadata` and skips the choice when there is one. F5 runs `cargo build --bin <name>`, streams the compiler output into the debug console with a Building line and Cancel in the debug pane, and launches the executable cargo reports. A failed build shows its first error and launches nothing. |
| | A binary you pick | Any executable, picked or typed, for C and C++. Build it with `-g` yourself. |

Two details worth knowing:

- **A Python program runs on the project's interpreter**, never Tori's: the
  nearest `.venv` or `venv` between the resolved root and the project, else
  `python3` on your PATH. The project does not need debugpy installed.
- **A Rust target loads Rust's own lldb formatters** from `rustc --print
  sysroot`, run in the package so `rust-toolchain.toml` applies. Without them
  a `String` shows as the raw `Vec` inside it.

## File location and loading

Bundled configs live in `src-tauri/dap/*.toml` and are embedded at compile time.
User configs live in `~/.config/tori/dap/*.toml`.

The rules are the language servers':

- A user file whose `id` matches a bundled one **whole-replaces** it, never
  field by field.
- A user file that fails validation is logged naming the problem, and the id
  keeps its previous entry. One broken file cannot take a language's debugger
  away.
- User files load in filename order, and files are read once at startup, so an
  edit needs a restart.

## Schema

Bare keys first, `[tables]` last: in TOML a bare key written after a table
header belongs to that table.

```toml
schema_version = 1          # required; this build supports: 1
id = "delve"                # required; unique, and the override key
label = "Go (Delve)"        # required; shown on the Settings card

# required: filenames marking the root a debuggee runs at, most specific
# first. See "Root resolution" below.
root_markers = ["go.mod"]

# optional (default false): the adapter asks for a child session per target
# (`startDebugging`) and expects each as another connection to the same
# process. Only `bundled_node_socket` can take one, so any other kind with
# this set is a load error.
child_sessions = false

# optional: the adapter version this config was captured against, for an
# adapter that reports one (debugpy does, `dlv` does not). Omitting it is
# normal and makes the card render neutral; it never renders as drift.
# verified_against = "1.8.22"

# --- tables below this line; nothing top-level may follow them ---

# required: which file extensions this adapter claims, and the DAP `type` a
# launch config for each one uses. Matched case-insensitively, leading dot
# optional.
[languages]
go = "go"

# required: how the adapter process is started. See "Launch kinds".
[launch]
kind = "tcp"
program = "dlv"
args = ["dap", "--listen=127.0.0.1:{port}"]
resolve = "path"

# optional: how the adapter gets onto the machine. See "Installing adapters".
[install]
kind = "hint"
text = "Install it with `go install github.com/go-delve/delve/cmd/dlv@latest`."
update = "go install github.com/go-delve/delve/cmd/dlv@latest"
uninstall = 'rm "$(go env GOPATH)/bin/dlv"'
```

An unrecognized top-level field is warned about and ignored. A missing required
field is an error naming every missing field at once.

### Launch kinds

`launch.kind` is a closed set, and a kind Tori does not implement is a load
error: an adapter that never spawns would look like a language with no
debugger at all.

| kind | Fields | Behaviour |
|---|---|---|
| `bundled_node_socket` | none | The adapter Tori ships, run with your system `node`. Its version and entry script come from `resources/dap/manifest.json`, the file `pnpm dap:install` installs from. It listens on a unix socket and Tori dials in. js-debug only. |
| `stdio` | `program`, `args`, `resolve` | DAP over the adapter's own stdin and stdout, like a language server. |
| `tcp` | `program`, `args`, `resolve` | Tori picks a free port, puts it where `args` says `{port}` (a load error if no arg does), and dials `127.0.0.1` on it. |

Every adapter process starts in the resolved root. Tori never waits for an
adapter's "listening" line: it retries its connect until the adapter answers,
gives up at once if the adapter exits, and otherwise gives up after 10 seconds.

For `tcp`, Tori binds port 0, reads the port the OS chose, releases it and
hands it to the adapter. Another process could take it in between, and then
that one start fails. Delve can also listen on a unix socket, which would close
that gap, but there is no launch kind for it yet.

### Resolvers

`launch.resolve` says where `program` is found. It is a closed set, and the
Settings card uses the same lookup as a start, so a card never reads found for
a program the start cannot find.

| resolve | Where |
|---|---|
| `path` (default) | The **login-shell** PATH, never the GUI process's minimal one. A `program` with a `/` in it, `~/` included, is used as written. |
| `xcrun` | `xcrun -f <program>`, else the login-shell PATH. For tools Xcode and the Command Line Tools ship outside the PATH. `xcrun` only runs once `xcode-select -p` names a developer directory that exists, so a Mac without the tools is not shown Apple's installer every time Settings opens. |
| `managed` | Tori's own install, under `~/.config/tori/debuggers/<id>/`. Goes together with `[install] kind = "pip"`: each without the other is a load error. |

### Installing adapters

`[install]` says how an adapter gets onto the machine. Its `kind` is a closed
set:

| kind | Fields | Behaviour |
|---|---|---|
| `hint` | `text`, optional `update`, `uninstall` | For an adapter its own toolchain installs. The card shows `text`, and Install runs the first backticked command in it, so put the command the button should run first. Once the adapter is found, Update and Uninstall run `update` and `uninstall`. |
| `pip` | `package`, `version` | Tori makes a venv with the `python3` on your PATH and runs `pip install --only-binary=:all: <package>==<version>` in it: wheels only, so installing runs no package code. Needs `resolve = "managed"`. |

A `pip` adapter has to run a module, `args = ["-m", "<module>"]`, and that is a
load error otherwise. The venv is built in a staging directory and moved into
place whole, and a venv's console scripts keep the staging path in their
shebangs, so only `python -m` still runs after the move. The same staging means
a failed install leaves the previous one, or nothing.

A venv from Homebrew's `python3` is fine even though Homebrew refuses a plain
`pip install`: that refusal covers the base interpreter, not a venv made from
it. A venv whose base Python was since removed reads not installed, and
Install builds a fresh one.

Install, Update and Remove live on the adapter's card in Settings > Debuggers.
For a `hint` adapter the card runs the command in a terminal inside Settings,
through `/bin/sh -c` with your login PATH, and asks before an uninstall. Tori
does not know how an adapter it finds was installed, so an `uninstall` that
does not match fails in that terminal and changes nothing. For `pip`, the
version is pinned in the config and moves with Tori releases; when Tori pins a
newer one, the card offers Update.

### Root resolution

A debuggee runs at a root resolved from the target's file: the nearest
ancestor holding one of `root_markers`, searching upward and stopping at the
project directory. No marker anywhere above it means the project directory.

The root becomes the launch config's `cwd`, which decides module resolution
and where source maps resolve from. In a monorepo, a package debugged at the
workspace root does not just behave worse: its breakpoints never bind.

### Turning an adapter off

`dap.disabled` in `~/.config/tori/settings.json` lists adapter ids that never
start. The switch on each card writes it.

```json
{ "dap": { "disabled": ["delve"] } }
```

### Project trust

Debugging runs the project's own code, so every debug run, attach included,
only starts in a project you have trusted. So does everything Tori runs through
cargo for a Rust target (listing binaries, building): build scripts and proc
macros are project code, and `rust-toolchain.toml` picks which cargo runs.

A refusal offers to trust the project, every time you press F5, and the next F5
after trusting starts the run. Trust is the same list language servers use, in
`~/.config/tori/trusted.json`, managed in Settings > Projects. See
LSP-SERVERS.md, "Project trust".

## Adding a debugger

A user TOML can change how a bundled adapter starts without any code: a
different program, other arguments, another resolver. For example, when
`go install` put Delve in `~/go/bin` and that is not on your PATH:

```toml
# ~/.config/tori/dap/delve.toml
schema_version = 1
id = "delve"
label = "Go (Delve, from ~/go/bin)"
root_markers = ["go.mod"]

[languages]
go = "go"

[launch]
kind = "tcp"
program = "~/go/bin/dlv"
args = ["dap", "--listen=127.0.0.1:{port}"]
```

Because it is a whole replacement, every extension the adapter should claim has
to be listed, and anything left out is no longer claimed.

A **new** id loads and gets its card, but F5 has nothing to offer for it yet:
what a target is, and the launch config each one becomes, are per adapter in
the editor. Adding one means code in `src/utils/debugTargets.ts` (the
`DebugTarget` union, `ADAPTER_KINDS`, `configFor`, `describeTarget` and
`isTarget`, which decides which stored targets survive a reload) and in
`src/components/Dialogs/DebugTargetDialog.tsx` (`KIND_LABELS` and `target()`).
The backend side is the TOML alone.

When writing one, check the adapter against Tori's handshake before anything
else: `initialize`, then `launch` without waiting for its answer, then on the
`initialized` event every breakpoint and `configurationDone`. It is the order
the DAP spec allows and VS Code uses, and js-debug, debugpy and lldb-dap were
each checked against it. Keep the program's output on the DAP wire as `output`
events (js-debug and debugpy with `console: "internalConsole"`, Delve with
`outputMode: "remote"`): Tori tells every adapter it cannot run the program in
a terminal, and refuses `runInTerminal` if one asks anyway.
