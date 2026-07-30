# Agent adapters

Sway drives every CLI coding agent through one abstraction: the **agent
adapter**. An adapter describes how to launch an agent, where its session
transcripts live, how to tell a live process apart from a stray `less` on the
same file, and which built-in parser turns its transcript into Sway's session
model.

One adapter ships bundled (`claude`). You add your own, or whole-replace the
bundled one, by dropping a TOML file into `~/.config/sway/agents/`.

> **Schema stability: v2 (stable), v1 still loads.** **v2 is purely additive**:
> it adds the optional `[chat]` table describing how to drive an agent as a
> structured chat session instead of a PTY. An existing `schema_version = 1`
> file keeps working untouched and simply reports no chat transport, so there
> is nothing to migrate. Breaking changes go through a deprecation period
> rather than landing silently.

## Supported agents

**claude** ships bundled and is fully wired: list, launch, resume, the
working/needs-you dot, touched files, the History dropdown, and the native
chat surface.

Nothing else ships. That is a packaging decision, not a limit of the schema:
everything below is what an adapter needs, and adding one is a file drop plus
a restart. The one thing a TOML cannot supply is a **parser kind** for an
agent whose transcript shape differs from claude's, which needs Rust (see
[Parser kinds](#parser-kinds)). Sway once bundled two more adapters, and what
that proved is worth keeping in mind when you write your own: an agent whose
tools never block on a permission prompt wants `needs_you = false`, and an
agent that keeps every session in one shared database rather than a file per
session needs both a new parser kind and a new `discovery.backend`.

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
backend = "file"                # optional, default "file"; "file" is the only backend today - see below
dir = "..."                     # required when backend = "file"; session-transcript root (~ expands to $HOME)
filename_pattern = '...'        # required when backend = "file"; regex with a named `id` capture group

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
the table is the normal case, not a degraded one: an adapter without one is
fully functional as a PTY agent.

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

Empirically measured for the bundled adapter (2026-07-18, real PTY capture,
not guessed):

- **claude**: a genuine permission prompt (`--permission-mode plan`, "Would
  you like to proceed?") leaves the PTY silent for 9s+ while waiting; a 20s
  Bash tool run stays noisy throughout (spinner redraws every <=0.62s).
  `needs_you = true`.

**Measure it, do not assume it.** Two kinds of agent both defeat the join and
look nothing alike: one whose tools auto-execute with no permission gate (so
it never blocks), and one whose TUI redraws a spinner continuously (so it is
never quiet while working). Capture a real PTY session, drive a tool call, and
look for a genuinely silent stretch while it waits on you. If you cannot find
one, set `needs_you = false` and the dot caps at working.

### `{id}` / `{file}` placeholders

`launch.resume_args` and `running.pattern` are templates. Sway substitutes:

- `{id}` - the session id.
- `{file}` - the session's transcript file path, for an agent that resumes by
  file rather than by id (`--session <path>` rather than `--resume <id>`).

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
files, the chat panel's replay of an existing session, the needs-you tail
state). Parser kinds are implemented in Sway itself,
not user-authorable - a user adapter can only *reference* one of:

- `claude_jsonl` - Claude Code's transcript shape: `type: "user"/"assistant"`
  at the top level of each `.jsonl` line, `message.content` an array of
  `text`/`thinking`/`tool_use` blocks, and a `tool_result` block riding inside
  the *next* user turn's content.

That is the only kind today, and it is a closed Rust enum rather than a config
string precisely so this stays honest: a TOML naming an unimplemented kind is
rejected at load rather than half-working. **Adding a kind is a Sway code
change**, in `sessions.rs`'s transcript readers - the compiler names every site
that has to answer for a new variant.

### `discovery.backend`

One backend today:

- **`"file"`** (default, and the only value accepted): the agent writes one
  file per session under a directory tree. `dir` is the session-transcript
  root; `filename_pattern` is matched against each file's *name* (not its full
  path) inside every immediate subdirectory of `dir` (Sway's layout is
  `<dir>/<encoded-cwd>/<session-file>`). Must contain a named capture group
  called `id`, used as a fallback session id when the transcript's own content
  doesn't yield one.

Like `parser.kind`, this is a closed Rust enum. An agent that keeps every
session as rows in one shared database rather than a file per session needs a
new variant here, because discovery, deletion, mtime and the file watcher all
have to answer differently for it - and the compiler will say so at each of
them.

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
Gemini" launch option appears alongside Claude.

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
