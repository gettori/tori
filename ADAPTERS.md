# Agent adapters

Sway drives every CLI coding agent (Claude, pi, and anything you add) through
one abstraction: the **agent adapter**. An adapter describes how to launch an
agent, where its session transcripts live, how to tell a live process apart
from a stray `less` on the same file, and which built-in parser turns its
transcript into Sway's session model.

Two adapters ship bundled (`claude`, `pi`). You can add your own, or
whole-replace a bundled one, by dropping a TOML file into
`~/.config/sway/agents/`.

> **Schema stability: unstable.** This format may change without a deprecation
> period until the first third-party adapter (a real, non-Claude/pi agent)
> lands and exercises it end to end. Pin nothing long-term yet.

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
schema_version = 1   # required; must be 1 - the only version implemented today
id = "..."            # required; the agent's identifier throughout Sway
label = "..."         # required; display name (sidebar, launch buttons)

[launch]
program = "..."        # required; the executable to seed into the tab's shell
base_args = []          # optional, default []; args always included
yolo_args = []           # optional, default []; extra args for "skip permissions" launches
resume_args = []        # required; template for resuming a session - see placeholders below

[discovery]
dir = "..."                     # required; session-transcript root (~ expands to $HOME)
filename_pattern = '...'        # required; regex with a named `id` capture group

[parser]
kind = "..."     # required; must be one of the implemented kinds below

[running]
pattern = '...'   # required; ERE template (for `pgrep -f`) with an `{id}` placeholder

[capabilities]
pty_quiet_ms = 2000   # optional, default 2000; PTY quiet threshold used by the working/needs-you pulse
```

### `{id}` / `{file}` placeholders

`launch.resume_args` and `running.pattern` are templates. Sway substitutes:

- `{id}` - the session id.
- `{file}` - the session's transcript file path (only meaningful for an
  agent that resumes by file rather than by id, e.g. pi's `--session <path>`).

### Parser kinds

`parser.kind` selects which built-in transcript parser turns this agent's
`.jsonl` lines into Sway's session model (prompt/turn/tool counts, touched
files, the transcript viewer). Parser kinds are implemented in Sway itself,
not user-authorable - a user adapter can only *reference* one of:

- `claude_jsonl` - Claude Code's transcript shape (`type: "user"/"assistant"`
  at the top level).
- `pi_jsonl` - pi's transcript shape (`type: "message"`, `message.role` of
  `user`/`assistant`/`toolResult`).

Adding a new parser kind (for an agent with a genuinely different transcript
shape) requires a Sway code change, not just a TOML file.

### `discovery.filename_pattern`

Matched against each file's *name* (not its full path) inside every
immediate subdirectory of `discovery.dir` (Sway's own layout is
`<dir>/<encoded-cwd>/<session-file>`, mirroring both bundled agents). Must
contain a named capture group called `id`, used as a fallback session id
when the transcript's own content doesn't yield one.

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
Gemini" launch option appears alongside Claude and pi.

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
