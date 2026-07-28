# Agent adapters

Sway drives every CLI coding agent (Claude, pi, opencode, and anything you
add) through one abstraction: the **agent adapter**. An adapter describes how
to launch an agent, where its session transcripts live, how to tell a live
process apart from a stray `less` on the same file, and which built-in parser
turns its transcript into Sway's session model.

Three adapters ship bundled (`claude`, `pi`, `opencode`). You can add your
own, or whole-replace a bundled one, by dropping a TOML file into
`~/.config/sway/agents/`.

> **Schema stability: v2 (stable), v1 still loads.** v1 was validated end to
> end by three real agents with genuinely different transcript conventions
> (claude/pi: one jsonl file per session; opencode: every session's
> messages/parts live as rows in one shared SQLite DB). **v2 is purely
> additive**: it adds the optional `[chat]` table describing how to drive an
> agent as a structured chat session instead of a PTY. An existing
> `schema_version = 1` file keeps working untouched and simply reports no chat
> transport, so there is nothing to migrate. Breaking changes go through a
> deprecation period rather than landing silently.

## Supported agents

- **claude**, **pi**, **opencode** ship bundled and are fully wired (list,
  launch, resume, the working/needs-you dot, touched files, the transcript
  viewer).
- **codex and gemini are not supported** as of this writing - not because
  their conventions are unusual, but because verifying them against real,
  freshly-generated sessions was blocked by CLI auth on the machine that
  wrote this adapter set (codex had no stored login; gemini-cli's free-tier
  OAuth for "Gemini Code Assist for individuals" is currently rejected
  server-side by Google, a backend policy change, not a local config issue).
  Nothing in the schema below rules them out - a `schema_version = 1` TOML in
  `~/.config/sway/agents/` can add either today, following the same pattern
  `opencode.toml` used. Revisit in a future release once auth is sorted out.

## File location and loading

- Bundled adapters: compiled into Sway, not user-editable.
- User adapters: every `*.toml` file directly inside `~/.config/sway/agents/`.
- Loaded once at startup (not live-watched - restart Sway after editing).
- A user file whose `id` matches a bundled adapter **whole-replaces** it: the
  entire adapter definition, not a field-by-field merge. A user file that
  fails validation never silently falls back to pretending nothing's wrong -
  the error is logged (visible in Sway's console/log output) naming what's
  wrong, and the id it would have overridden keeps its previous (bundled or
  earlier-loaded) definition so one broken file can't make an agent vanish.
- An unrecognized top-level field is a warning, not a rejection. A missing
  required field, an unsupported `schema_version`, or a `parser.kind` outside
  the closed set below is a rejection - the whole file is skipped.

## Schema

```toml
schema_version = 2   # required; 1 or 2. v2 adds the optional [chat] table below
id = "..."            # required; the agent's identifier throughout Sway
label = "..."         # required; display name (sidebar, launch buttons)
verified_against = "..."  # optional; the agent CLI version this was captured against, echoed here for reference

[launch]
program = "..."        # required; the executable to seed into the tab's shell
base_args = []          # optional, default []; args always included
yolo_args = []           # optional, default []; extra args for "skip permissions" launches
resume_args = []        # required; template for resuming a session - see placeholders below

[discovery]
backend = "file"                # optional, default "file"; "file" or "sqlite" - see below
dir = "..."                     # required when backend = "file"; session-transcript root (~ expands to $HOME)
filename_pattern = '...'        # required when backend = "file"; regex with a named `id` capture group
db_path = "..."                 # required when backend = "sqlite"; path to the shared session DB (~ expands to $HOME)

[parser]
kind = "..."     # required; must be one of the implemented kinds below

[running]
pattern = '...'   # required; ERE template (for `pgrep -f`) with an `{id}` placeholder

[capabilities]
pty_quiet_ms = 2000   # optional, default 2000; PTY quiet threshold used by the working/needs-you pulse
needs_you = true      # optional, default true; whether quiet+pending-tool_use is trusted as "needs you" - see below
hooks = false         # optional, default false; whether a verified hook-driven status mechanism overrides the tail join - see below

# --- v2 only; omit the whole table for a PTY-only agent ---
[chat]
transport = "claude_stream_json"  # required; closed set - see below
program = "..."           # optional, defaults to launch.program
base_args = []            # optional; args always passed when starting a chat session
session_id_args = []      # optional; `{id}` template selecting a new session id
resume_args = []          # optional; `{id}` template resuming an existing session
model_args = []           # optional; `{model}` template
effort_args = []          # optional; `{effort}` template
mode_args = []            # optional; `{mode}` template
add_dir_args = []         # optional; `{dir}` template, applied once per extra directory

[[chat.models]]
id = "..."                # required; the id passed to model_args
label = "..."             # required; display name in the picker
context_window = 200000   # optional; omit if unknown - the meter only renders when declared
effort_levels = []        # optional; must all name a [[chat.effort]] entry. Empty hides the control
supports_thinking = false # optional, default false
supports_images = false   # optional, default false

[[chat.modes]]
id = "..."                # required; the permission mode's identifier
label = "..."             # required; display name
args = []                 # optional; the args that select this mode

[[chat.effort]]
id = "..."                # required; the level's identifier
label = "..."             # required; display name
args = []                 # optional; the args that select this level
```

### The `[chat]` table

An adapter with a `[chat]` table can be driven as a **structured chat
session**: one long-lived child speaking a streaming protocol, rendered as
messages, tool cards and inline diffs, rather than a TUI in a PTY. Omitting
the table is the normal case, not a degraded one - `pi` and `opencode` ship
without one and are fully functional as PTY agents.

`transport` is a **closed enum**, for the same reason `parser.kind` is: a
transport is a Rust module implementing a specific wire protocol, so a TOML
can only select one that already exists. Today the only member is
`claude_stream_json`. An unrecognised value is rejected loudly and the id
keeps its previous adapter, the same way a broken override does.

Everything else in the table is an **arg template**, so adding a harness is a
TOML table rather than a Rust branch. Placeholders are substituted at spawn
time: `{id}`, `{model}`, `{effort}`, `{mode}`, `{dir}`.

**A mode or effort level can be written two ways, and entry args win.** Either
the table-level template (`mode_args = ["--permission-mode", "{mode}"]`) or the
entry's own `args`. The rule is: **an entry's `args` are used when non-empty,
otherwise the template is filled with the entry's `id`.** The template is the
concise default; per-entry `args` are the escape hatch for a harness whose
modes are not one flag with a varying value. `claude.toml` states both, and
they agree.

Two rules the loader enforces, because both failures are otherwise silent:

- **`[chat]` requires `schema_version = 2`.** A chat table in a v1 file is
  refused by name rather than ignored, since a silently-dropped table looks
  exactly like an adapter that has no chat surface.
- **Every `effort_levels` entry must name a `[[chat.effort]]` entry.** An
  undefined level would render a picker option carrying no args, so selecting
  it would appear to work and do nothing.

> **Watch the TOML table boundary.** Every scalar key in `[chat]` must appear
> *above* the first `[[chat.models]]` header. A key written after a table
> header belongs to that table, so moving one down silently reparents it into
> a model entry instead of failing.

### `capabilities.hooks`

An agent whose `hooks = true` gets its working/needs-you status from its own
CLI's hook events instead of the transcript-tail join, when one fires -
ground truth instead of a guess. This is **not** a generic TOML-authorable
mechanism: turning it on for a new agent needs matching Rust code in
`crate::hooks` (an agent-specific injection + a matching status-writer), the
same way a new `parser.kind` needs code, not just a flag. Setting `hooks =
true` in a user TOML with no such code is inert - the field is read, but
nothing produces a status file for that agent, so it silently stays on the
tail-join floor.

**claude** (2026-07-18, phase 3, `claude 2.1.214`) is the only adapter with
one today: `claude --settings <path>` injects a
`UserPromptSubmit`/`PreToolUse`/`Notification`/`Stop` hook set, verified
non-invasive (layers on top of `~/.claude/settings.json` via claude's own
`--settings-sources user,project,local` default; that file is never opened
or edited) and scoped to Sway-launched sessions only - an externally-typed
`claude` never receives the flag. The value is a **path** to a small
Sway-written file (`~/.config/sway/claude-hooks-settings.json`), not inline
JSON - every agent tab's launch command is typed into its login shell one
byte at a time, and a PTY in canonical mode silently truncates a single
line beyond the kernel's line-discipline buffer, so an inline settings blob
(2KB+) got cut mid-string and hung the shell on an unclosed quote (caught
live, not in review). Each hook's command greps only
`session_id`/`hook_event_name` off the JSON payload on stdin (POSIX
`grep`/`sed`/`printf`, no jq/node/python dependency, and prompt text/tool
input are never written to disk) and writes a small
`~/.config/sway/hooks-status/<session id>.json` marker. `Notification` -
claude's own signal that it is waiting on the user (a permission prompt or an
idle nudge) - maps to `blocked-candidate`; `UserPromptSubmit`/`PreToolUse`
map to `working`; `Stop` maps to `done`. Verified empirically against a real
`claude -p` run: the settings JSON is accepted, the status file lands at the
right session id, and `~/.claude/settings.json`'s md5 is unchanged
before/after.

### `capabilities.needs_you`

The needs-you dot state is a join: a trailing `tool_use` with no matching
result yet, **and** a PTY that's been quiet longer than `pty_quiet_ms`. That
join only means "waiting on you" for an agent that actually stops and blocks
on a permission prompt. Set `needs_you = false` for an agent whose tools
auto-execute (no observable blocked-and-quiet state to verify the join
against) - its dot then caps at working instead of showing a possibly-false
amber.

Empirically measured for the bundled adapters (2026-07-18, real PTY capture,
not guessed):

- **claude**: a genuine permission prompt (`--permission-mode plan`, "Would
  you like to proceed?") leaves the PTY silent for 9s+ while waiting; a 20s
  Bash tool run stays noisy throughout (spinner redraws every <=0.62s).
  `needs_you = true`.
- **pi**: its built-in bash/write/edit tools never block on a permission
  prompt at all (confirmed - a Bash command ran immediately, no gate), so
  there's nothing to verify the "blocked is quiet" half of the join against.
  A trailing tool_use plus a quiet PTY for pi means "still running" or
  "hung", not "waiting on you". `needs_you = false` until pi grows a
  permission-gated mode.
- **opencode**: verified against a real interactive TUI session (a scripted
  pty, not headless `opencode run`) driving its default `build` agent through
  a bash tool call. No permission prompt ever rendered (grepping the full
  captured byte stream for approval-dialog language found zero matches), and
  the TUI redraws a spinner continuously (~0.04-0.05s cadence) for the entire
  turn - never silent while working, so there's no blocked-and-quiet state to
  join against either. `needs_you = false`. Caveat: only `bash` was
  exercised; a stricter permission profile or a different opencode agent
  config could behave differently.

### `{id}` / `{file}` placeholders

`launch.resume_args` and `running.pattern` are templates. Sway substitutes:

- `{id}` - the session id.
- `{file}` - the session's transcript file path (only meaningful for an
  agent that resumes by file rather than by id, e.g. pi's `--session <path>`).

**Write `running.pattern` against the chat command line, not just the terminal
one.** `pgrep -f` matches the whole command line, and the two surfaces build
different ones: a PTY tab runs `agent --resume <id>`, while a chat session runs
`agent <chat.base_args...> --resume <id>` (or `--session-id <id>` for a new
one). A pattern that assumes the flag sits right after the program name matches
the terminal case and silently misses every chat, which makes those sessions
invisible to the worktree-removal count, the delete warning and the revert
guard. Allow for the intervening arguments, as the bundled claude adapter does:

```toml
pattern = 'claude ([^ ]+ )*(--resume|-r|--session-id) {id}'
```

The `([^ ]+ )*` matches whole argument tokens, so it spans the base args without
also matching an unrelated process that merely mentions the id (a `tail` on the
transcript, an editor with it open).

### Parser kinds

`parser.kind` selects which built-in transcript parser turns this agent's
session data into Sway's session model (prompt/turn/tool counts, touched
files, the transcript viewer). Parser kinds are implemented in Sway itself,
not user-authorable - a user adapter can only *reference* one of:

- `claude_jsonl` - Claude Code's transcript shape (`type: "user"/"assistant"`
  at the top level of each `.jsonl` line).
- `pi_jsonl` - pi's transcript shape (`type: "message"`, `message.role` of
  `user`/`assistant`/`toolResult`, one `.jsonl` line per turn).
- `opencode_sqlite` - opencode's shape: no per-session file at all. Every
  session's turns are `message` rows (`data.role: "user"/"assistant"`) joined
  to their `part` rows (`data.type: "text"/"tool"/...`) in one shared SQLite
  DB (see `discovery.backend = "sqlite"` below). Only pairs with that backend.

Adding a new parser kind (for an agent with a genuinely different transcript
shape) requires a Sway code change, not just a TOML file.

### `discovery.backend`

Two backends, chosen per adapter:

- **`"file"`** (default): the agent writes one file per session under a
  directory tree. `dir` is the session-transcript root; `filename_pattern` is
  matched against each file's *name* (not its full path) inside every
  immediate subdirectory of `dir` (Sway's own layout is
  `<dir>/<encoded-cwd>/<session-file>`, mirroring claude/pi). Must contain a
  named capture group called `id`, used as a fallback session id when the
  transcript's own content doesn't yield one.
- **`"sqlite"`**: the agent keeps every session (across every project on the
  machine) as rows in one shared SQLite DB - `db_path` points at it. There is
  no per-session file and no filename pattern; the session id lives in a DB
  column instead. Sway opens this DB strictly read-only and never writes to
  it - deleting an adapter's session goes through the agent's own CLI (e.g.
  `opencode session delete <id>`), never a raw SQL statement. Only pairs with
  `parser.kind = "opencode_sqlite"` today, but the backend itself is generic:
  a future DB-backed agent can reuse it once it gets its own parser kind.

## Example: a from-scratch third-party adapter

A complete, valid adapter for a hypothetical `gemini` CLI that happens to
write Claude-shaped transcripts (illustrative - a real Gemini adapter would
likely need its own parser kind):

```toml
schema_version = 1
id = "gemini"
label = "Gemini"

[launch]
program = "gemini"
base_args = []
yolo_args = ["--yolo"]
resume_args = ["--resume", "{id}"]

[discovery]
dir = "~/.gemini/sessions"
filename_pattern = '^(?P<id>.+)\.jsonl$'

[parser]
kind = "claude_jsonl"

[running]
pattern = 'gemini --resume {id}'

[capabilities]
pty_quiet_ms = 2000
```

Save this as `~/.config/sway/agents/gemini.toml` and restart Sway; a "+
Gemini" launch option appears alongside Claude, pi, and opencode.

## Whole-replacing a bundled adapter

To point Sway's `claude` adapter at a wrapper script instead of the real
binary, keep `id = "claude"` and change only what differs - but remember
this is a **whole replacement**, so every required section must still be
present in full, not just the field you're changing:

```toml
schema_version = 1
id = "claude"
label = "Claude"

[launch]
program = "/usr/local/bin/claude-wrapped"
base_args = []
yolo_args = ["--dangerously-skip-permissions"]
resume_args = ["--resume", "{id}"]

[discovery]
dir = "~/.claude/projects"
filename_pattern = '^(?P<id>.+)\.jsonl$'

[parser]
kind = "claude_jsonl"

[running]
pattern = 'claude-wrapped (--resume|-r) {id}'
```
