# Agent adapters

Tori drives every CLI coding agent through one abstraction: the **agent
adapter**. An adapter describes how to launch an agent, where its session
transcripts live, how to tell a live process apart from a stray `less` on the
same file, and which built-in parser turns its transcript into Tori's session
model.

Five adapters ship bundled: `claude`, `codex`, `copilot`, `opencode` and `pi`.
You add your own by dropping a TOML file into `~/.config/tori/packs/agents/`.

## Agent, adapter, provider

Tori used to call the same thing an agent in one file and a harness in the next.
It is **agent** everywhere now, including where the word is slightly too broad,
because a second word bought a distinction almost nothing in the codebase
actually used.

Two other words remain, and they are not synonyms for it:

| Word | What it means | Seen in |
| --- | --- | --- |
| **agent** | an AI coding CLI. Also the protocol's own word, the `A` in ACP. | `agentId`, `agent_health`, `~/.config/tori/packs/agents/` |
| **adapter** | the TOML that says *how* to drive one, and the record it loads into. Data, never behaviour. Exactly one per agent. | this file, `agents/*.toml`, `AgentAdapter`, `Adapter` |
| **provider** | the vendor behind a **model**. | `providerIcon`, the model pill |

**Provider is the one worth being strict about**, because it is a genuinely
different axis: it varies independently of the agent. A Claude adapter pointed at
a router is running a model Anthropic did not make, so "the provider" and "the
agent" give different answers about the same turn.

**Two on-disk names outlived the rename.** The `harness` block in
`settings.json` and the `harnessId` in each cached model catalogue are still
read, via serde aliases, because a missed key there is not an error - it reads as
a default and quietly discards a user's binary override or a real probe result.

> **Schema stability: v3 (stable), v1 and v2 still load.** Every version so
> far is **purely additive**: v2 added the optional `[chat]` table describing
> how to drive an agent as a structured chat session instead of a PTY, and v3
> adds the optional `[accounts]` table describing how it signs in and whether
> it can hold more than one account. An older file keeps working untouched and
> simply reports nothing for the tables it predates, so there is nothing to
> migrate. Breaking changes go through a deprecation period rather than landing
> silently.

## Supported agents

The bundled set *is* Tori's support list - there is no separate catalogue of
agents Tori has heard of but cannot drive. There used to be one (a trimmed
copy of the [ACP Registry](https://github.com/agentclientprotocol/registry),
with an install path for its binary entries); it was removed when the last
uncovered entries got adapters, because a list whose every row is already a
card is two claims about one thing.

The line that matters survives the catalogue: **bundled is not measured.** An
adapter with a `verified_against` was run, probed and captured at that version;
one without was written from documentation and ships as a starting point.

That line is maintainer bookkeeping, and the UI deliberately does not recite
it: no "untested" caveat on an unmeasured adapter's page, and no drift warning
for a binary *newer* than its `verified_against` - vendors ship weekly, so
being ahead of the measurement is the steady state of a healthy install, and a
banner that is always up warns about nothing. The one drift direction the app
surfaces is *behind*: an installed version older than the measured one means a
newer release provably exists, so the row says "Outdated" and the page offers
the vendor's update. Everything else this paragraph knows lives here, in this
file.

**claude** ships bundled and is fully wired: list, launch, resume, the
working/needs-you dot, touched files, the History dropdown, and the native
chat surface.

**opencode** ships bundled over ACP, measured against `opencode 1.18.3`. Its
chat surface is the generic ACP client: the agent asks its own permission
questions, reports its own model catalogue, and replays a reopened conversation
itself. What it does not get is anything riding Claude's `PreToolUse` hook -
exact before-state diffs and hunk revert - or a spend ceiling, since ACP reports
context occupancy and no cost. Settings > Agents publishes the
list per agent, and a chat session publishes its own under Session.

**codex** ships bundled over ACP, measured against `codex-cli 0.155.1` with the
`@agentclientprotocol/codex-acp 1.12.0` wrapper. It is the one adapter whose chat
binary is not its launch binary: the PTY tab runs the `codex` a user installed,
and chat runs the first-party wrapper over `npx`, which drives that same
`codex` underneath. `codex.toml` carries the full reasoning.

**copilot** ships bundled over ACP (`copilot --acp`, first-party in the CLI),
measured against `copilot 1.0.94` as far as the handshake: the measuring account
had no Copilot CLI access, so opening a session was refused. It additionally
declares the two commands its CLI reference documents: `[install]`
(`npm install -g @github/copilot`) and a `[accounts]` login (`copilot login`,
first-party OAuth). No whoami and no logout, because the reference documents
neither non-interactively, so its sign-in state stays honestly unknown.

**pi** ships bundled on the codex pattern, measured against `pi 0.82.1` with
`pi-acp 0.0.33`: `pi` has no ACP mode of its own, so chat goes through the
`pi-acp` bridge over `npx`. Unlike the Claude SDK wrappers it vendors no second
agent. It spawns the *installed* `pi --mode rpc` and reuses pi's own sessions.
The bridge is third-party, which is a reason to pin its version (the TOML does)
and re-measure, not a reason to avoid it.

Adding another is a file drop plus a restart, and for an agent that speaks ACP
first-party it is *only* a file drop: no Rust at all. The things a TOML cannot
supply are a **transport** (`chat.transport` selects one that exists; see
[The `[chat]` table](#the-chat-table)) and a **parser kind** for a file-backed
agent whose transcript shape differs from claude's (see
[Parser kinds](#parser-kinds)). One more lesson from the two adapters Tori once
bundled and dropped: an agent whose tools never block on a permission prompt
wants `needs_you = false`.

## File location and loading

- Bundled adapters: `src-tauri/packs/agents/*.toml`, compiled into Tori, not
  user-editable.
- User adapters: every `*.toml` file directly inside
  `~/.config/tori/packs/agents/`. The first launch of the release that
  introduced packs moved them there from `~/.config/tori/agents/`.
- Loaded once at startup (not live-watched - restart Tori after editing).
- A user file may not reuse a bundled adapter's `id`; it is refused, with the
  fix "copy it under your own id and switch the bundled one off". A copy under
  a new id is a new agent, with its own accounts and sessions. The exception is
  a bundled-id file the move found: an agent id runs through accounts, profile
  homes and session records, so Tori kept its id and recorded it in
  `~/.config/tori/packs/installed.json` as an override of the bundled adapter.
  It whole-replaces the bundled one (the entire definition, not a
  field-by-field merge) while it stays unedited, and its card says when the
  bundled adapter has changed since.
- A user file that fails validation never silently falls back to pretending
  nothing's wrong: Settings lists it under "Needs fixing" naming what's wrong,
  and the id it would have replaced keeps its previous (bundled or
  earlier-loaded) definition so one broken file can't make an agent vanish.
- An unrecognized top-level field is a warning, not a rejection. A missing
  required field, an unsupported `schema_version`, or a `parser.kind` outside
  the closed set below is a rejection - the whole file is skipped.
- A file is named after its `id`: `claude.toml` holds `id = "claude"`. A user
  file whose name and id differ is refused, naming both. An id
  is lowercase letters, digits, `.`, `_` and `-`, and starts with a letter or
  digit; any other id is refused.

## Schema

```toml
schema_version = 6   # required; 1 to 6. v2 adds [chat], v3 adds [accounts], v4 adds [usage], v5 adds [config], v6 adds launch-only adapters and whoami_kind = "json" - all optional, all below
id = "..."            # required; the agent's identifier throughout Tori
label = "..."         # required; display name (sidebar, launch buttons)
icon = "..."          # optional; which bundled agent logo to wear - "claude", "codex", "copilot", "opencode", "pi". An unknown or absent name is not an error: the UI falls back to the label's first letter rather than to another agent's mark
verified_against = "..."  # optional; the agent CLI version this was captured against, echoed here for reference
verified_on = "..."       # optional; the day verified_against was measured, written YYYY-MM-DD
description = "..."       # optional; one line for the agent's card
license = "..."           # optional; the SPDX id of the licence this file is shared under
contributor = { name = "...", github = "..." }  # optional; who wrote this file, credited on its card

[launch]
program = "..."        # required; the executable to seed into the tab's shell
base_args = []          # optional, default []; args always included
yolo_args = []           # optional, default []; extra args for "skip permissions" launches
resume_args = []        # required, except for a launch-only adapter; template for resuming a session - see placeholders below

# --- the three file-era tables: all three, or none at all - see below ---
[discovery]
backend = "file"                # optional, default "file"; "file" is the only backend today - see below
dir = "..."                     # required when backend = "file"; session-transcript root (~ expands to $HOME)
filename_pattern = '...'        # required when backend = "file"; regex with a named `id` capture group

[parser]
kind = "..."     # required with [discovery]; must be one of the implemented kinds below

[running]
pattern = '...'   # required with [discovery]; ERE template (for `pgrep -f`) with an `{id}` placeholder

[capabilities]
pty_quiet_ms = 2000   # optional, default 2000; PTY quiet threshold used by the working/needs-you pulse
needs_you = true      # optional, default true; whether quiet+pending-tool_use is trusted as "needs you" - see below
hooks = false         # optional, default false; whether a verified hook-driven status mechanism overrides the tail join - see below
sessions = true       # optional, default true; v6: false declares a launch-only adapter - see below

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

# --- only read by transport = "acp" ---
[chat.acp]
serve_client_fs = false   # optional, default false; advertise Tori's filesystem and terminal to the agent
send_mcp_servers = false  # optional, default false; hand the agent Tori's MCP servers on `session/new`

# --- v3 only; omit the whole table for an agent Tori does not sign in ---
[accounts]
home_env = "..."            # optional; the env var pointing the agent at an isolated profile home
home_default = "~/..."      # optional; where home_env points when unset - required with isolation + [discovery]
home_markers = []           # optional; names a non-empty folder must already hold to be added as an account
login_args = []             # optional; args that start an interactive login, run in a real PTY
logout_args = []            # optional; args that sign the profile out
whoami_args = []            # optional; bounded, non-interactive "who is signed in here" probe
whoami_kind = "..."         # required with whoami_args; claude_json | exit_code | opencode_credentials | json (v6)
whoami_signed_in_key = "..." # required with whoami_kind = "json"; dotted path to a boolean
whoami_account_key = "..."   # optional, json only; dotted path to the account's name
supports_isolation = false  # optional, default false; whether two accounts can coexist - see below

# --- v5 only; omit the whole table for an agent whose config files nobody has measured ---
[config]

[[config.entries]]
id = "..."                # required; stable, unique within the table, never shown
label = "..."             # required; what the row is called in Settings
path = "..."              # required; relative to the account home - absolute, `~` and `..` are rejected
kind = "file"             # required; "file" or "dir"
new_path = "{name}.md"    # required for kind = "dir", rejected for "file"; where a new item lands under the dir, must carry {name}
template = "..."          # optional, default empty file; the new file's contents, {name} substituted
new_name_hint = "..."     # optional; placeholder text for the name field

# --- optional; omit for an agent whose install path nobody has verified ---
[install]
program = "npm"             # the vendor's own documented install command...
args = []                   # ...run in a visible PTY tab, never captured
update_args = []            # optional; the same program's update verb
uninstall_args = []         # optional; its removal verb
```

### The `[chat]` table

An adapter with a `[chat]` table can be driven as a **structured chat
session**: one long-lived child speaking a streaming protocol, rendered as
messages, tool cards and inline diffs, rather than a TUI in a PTY. Omitting
the table is the normal case, not a degraded one: an adapter without one is
fully functional as a PTY agent.

`transport` is a **closed enum**, for the same reason `parser.kind` is: a
transport is a Rust module implementing a specific wire protocol, so a TOML
can only select one that already exists. Two members ship:

- **`claude_stream_json`** - `claude -p` with stream-json in both directions,
  one long-lived child with stdin held open. One vendor's format.
- **`acp`** - the [Agent Client Protocol](https://agentclientprotocol.com) over a
  child's stdio. Not one vendor's format: **every agent speaking ACP
  first-party reaches Tori through this one transport plus its own TOML**, which
  is why `opencode.toml` is under 40 lines of actual settings.

An unrecognised value is rejected loudly and the id keeps its previous adapter,
the same way a broken override does.

**An `acp` adapter declares far less, and the empty templates are not
omissions.** ACP carries session ids, resume, forking, model switching and
modes *in the protocol*, so there is no command line to put them on: `session_id_args`,
`resume_args`, `fork_args`, `model_args`, `effort_args` and `mode_args` are all
empty for an ACP agent, and `[[chat.models]]` is empty too because the agent
reports its own catalogue on the handshake (measured: `opencode acp` 1.18.3 lists
the same 15 provider-qualified models `opencode models` prints, and which ones
they are depends on the providers that user has authenticated). A bundled model
table would only go stale or contradict the user's own account.

`[chat.acp]` holds the per-agent departures from a spec-correct client. It is a
**closed, named set** rather than free-form JSON: a third quirk has to be argued
for in Rust before a TOML can spell it, which is what keeps "a new agent is a
TOML file" from meaning "a new agent is a TOML file plus a pile of
agent-specific escape hatches". `serve_client_fs` advertises Tori's filesystem
and terminal to the agent; the default declines both, which is a complete
configuration rather than a degraded one, since ACP agents do their own I/O.
`send_mcp_servers` populates `mcpServers` on `session/new`; turn it on only for
an agent measured calling a server it was handed (`dev/mcp-probe.mjs --acp`),
since an agent can accept the array and never start the server.

Everything else in the table is an **arg template**, so adding a agent is a
TOML table rather than a Rust branch. Placeholders are substituted at spawn
time: `{id}`, `{model}`, `{effort}`, `{mode}`, `{dir}`.

**A mode or effort level can be written two ways, and entry args win.** Either
the table-level template (`mode_args = ["--permission-mode", "{mode}"]`) or the
entry's own `args`. The rule is: **an entry's `args` are used when non-empty,
otherwise the template is filled with the entry's `id`.** The template is the
concise default; per-entry `args` are the escape hatch for a agent whose
modes are not one flag with a varying value. `claude.toml` states both, and
they agree.

Three rules the loader enforces, because all three failures are otherwise
silent:

- **`[chat]` requires `schema_version >= 2`, `[accounts]` requires `>= 3`,
  `[usage]` requires `>= 4`.** A table in a file that predates it is refused by
  name rather than ignored, since a silently-dropped table looks exactly like
  an adapter that has no chat surface, no accounts, or no quota to read. Each
  gate is against that table's own minimum, never against the newest version,
  so a later bump never invalidates a working file.
- **`[discovery]`, `[parser]` and `[running]` are all present or all absent.**
  See [Sessions on disk, or over a protocol](#sessions-on-disk-or-over-a-protocol).
- **Every `effort_levels` entry must name a `[[chat.effort]]` entry.** An
  undefined level would render a picker option carrying no args, so selecting
  it would appear to work and do nothing.

> **Watch the TOML table boundary.** Every scalar key in `[chat]` must appear
> *above* the first `[[chat.models]]` header. A key written after a table
> header belongs to that table, so moving one down silently reparents it into
> a model entry instead of failing.

### The `[accounts]` table

Declares how Tori signs this agent in, and whether it can hold more than one
account at once. Omit the whole table for an agent Tori does not sign in: that
reports *unknown*, not *signed out*, and renders no account controls rather
than an inert set.

**The default profile is `home_env` left unset.** Tori never copies, reads or
stores credentials. A default-profile session spawns with no home variable, so
the agent resolves whatever login the user already had; an added profile
spawns with the variable pointed at a Tori-created directory under
`~/Library/Application Support/tori/profiles` (mode `0700`), never under
`~/.config/tori`, which is commonly a dotfile repo. The default profile cannot
be renamed or removed, because there is no stored record of it to change.

**`supports_isolation` is a measurement, not an inference.** It defaults to
`false`, and an adapter that merely *has* a home variable does not earn `true`:
the variable may point at a config directory while the credentials behind it
live in one shared store, in which case adding a second account silently signs
the first one out. Claiming `supports_isolation = true` without a `home_env` is
rejected outright, since there would be no mechanism behind the claim. An
adapter that does not claim isolation offers no "add account" action at all -
silently: the sentence explaining *why* ("nobody has measured this agent
holding two accounts at once") is for whoever edits these files, so it lives
in this paragraph rather than in the app.

> **Canonicalize the home path.** Measured on `claude 2.1.232`: it derives its
> macOS Keychain service name as `"Claude Code-credentials-" +
> sha256($CLAUDE_CONFIG_DIR)[:8]`, hashing the **raw environment string**
> rather than a resolved path (the default home takes the unsuffixed name). So
> `/a/home` and `/a/home/` are two different logins for one directory, and a
> relative or symlinked spelling is a third. Tori canonicalizes once, at the
> boundary, before storing a profile home or spawning against it.

`login_args` always runs in a real PTY. `claude auth login` is browser OAuth
with no non-interactive variant and `setup-token` is interactive too, so a
captured login would hang rather than fail. `whoami_args` is the opposite: it
must be bounded and answer without a terminal, and it comes with a
`whoami_kind` naming the shape of its answer. No two agents report sign-in
the same way (claude prints JSON, codex says it in its exit code, opencode
exits 0 either way and states a credential count), so there is nothing to fall
back on and args without a kind are rejected.

**`whoami_kind = "json"` (v6) is for an agent whose probe prints a JSON
object.** `whoami_signed_in_key` is a dotted path to a boolean in it, `true`
signed in and `false` signed out, and `whoami_account_key` an optional dotted
path to the account's name, shown beside the account. Given
`{"auth": {"signedIn": true, "user": {"login": "ada"}}}`, the keys are
`auth.signedIn` and `auth.user.login`. A missing key, a value of the wrong type,
or output that is not JSON reads as unknown, never as signed out. The two keys
are refused beside any other kind.

**`home_default` is what makes a second account's history findable.** An agent
pointed at an isolated home writes its transcripts under that home, in the same
layout it uses by default, so Tori finds a profile's sessions by taking
`[discovery] dir` and swapping this prefix for the profile's own home. Two
declared paths rather than one declared suffix: the suffix is then derived, and
a `dir` that does not sit under `home_default` yields no root at all rather than
a guessed one. Declaring `supports_isolation = true` alongside a `[discovery]`
table without it is rejected, because the second account would sign in
successfully and then show an empty history forever. An agent whose sessions
only its protocol reaches declares no `[discovery]` table and so is never asked
for one.

**`home_markers` guards adding a folder the user already has.** An account can
point at an existing home instead of one Tori creates. The sign-in probe that
runs when it is added writes into whatever folder it is given, so the folder
must be empty or already hold one of these names, or it is refused before
anything runs in it. An empty folder is signed in to like one Tori created. An
adapter that declares none cannot adopt a folder. Tori never deletes an adopted
folder: removing that account only forgets it.

### The `[usage]` table

Names the rungs of the usage source ladder this agent can answer a quota
reading from, in the order the ladder climbs.

```toml
[usage]
sources = ["sessions"]   # required when the table is present; one or more of "sessions", "cli", "token"
```

Three rungs exist, and they are cumulative rather than exclusive: a passive
reading always merges, and each deeper rung fills the gaps the shallower ones
leave.

- **`sessions`** reads the quota windows the agent already puts on its own
  session events. It costs nothing and needs no extra process. Claude's
  `rate_limit_event` is the one implemented today.
- **`cli`** runs a bounded read through the agent's own CLI on a schedule. Codex
  is the one implemented today: `codex app-server` answers
  `account/rateLimits/read` with both windows, the plan and the credit balance,
  and it is Codex's only rung because the ACP wrapper forwards no rate limits.
- **`token`** reads the account's OAuth token from the OS credential store.
  Always an explicit per-agent opt-in, never a default.

`sources[0]` is what the agent resolves to when the user has chosen nothing, so
declaration order is the ladder's order and not a set.

**Declare a rung only once Tori has a read path for it.** An undeclared rung
renders as a greyed control with the loader's own reason beside it, which is
honest; a declared rung with nothing behind it renders as a control that
answers nothing. Omitting the whole table is the normal case for an agent whose
quota Tori cannot see, and it renders as "no usage source" rather than as a
quota of zero. An empty `sources = []` is rejected: an empty ladder and no
ladder are not the same claim.

### The `[config]` table

The files this agent reads out of an account home: its instructions file, its
skills, its commands, its subagents, its settings. Settings lists them per
account, with open-in-editor, reveal-in-Finder and new-from-blank on each row.

```toml
[config]

[[config.entries]]
id = "skills"
label = "Skills"
path = "skills"
kind = "dir"
new_path = "{name}/SKILL.md"
new_name_hint = "skill-name"
template = '''
---
name: {name}
---
'''
```

**Every `path` is relative to the account home**, and the loader enforces it:
an absolute path, a leading `~`, a backslash or a `..` segment is rejected, and
so is the whole table on an adapter with no `[accounts].home_default` to
resolve against. That is the safety story of this table in full. The home is
`home_default` for the default account and the profile's own home for any
other, so a row that could climb out of it would turn the Files section into a
filesystem browser and `template` into an arbitrary-file writer.

`kind` says what is at the path, and `new_path` says what "New" makes under it.
A `dir` row must declare `new_path` and it must carry `{name}`, because the
shape differs per agent and per row: a Claude skill is a folder
(`{name}/SKILL.md`) while a Claude subagent is a single file (`{name}.md`).
Declared rather than inferred from the row's id, so the next agent's layout is
a line of TOML rather than a branch in Rust. A `file` row's "New" creates the
row's own path and so declares no `new_path`.

`{name}` is the only placeholder, in `new_path` and in `template` alike. It is
the name the user typed for a `dir` row, and the file's own stem for a `file`
row. The name is validated before it is used: empty, a path separator, a `..`
anywhere, or a leading dot is refused with a reason rather than rewritten.
Creating never overwrites, and a row whose path is a **dangling** symlink
refuses to be written through, naming what it points at - writing there would
create the missing target instead of fixing the row.

**Declare a row only once somebody has measured that the agent reads it.** A
row for a directory nothing loads is worse than no row: it invites the user to
put work somewhere it will never be read. Claude's `rules` row is here because
2.1.263's own loader was read and found to walk the user-level `rules` folder
alongside the user `CLAUDE.md`; it was to be left out otherwise. Omitting the
whole table is the normal case, and it renders as one line saying the adapter
declares no files.

Each row reports a state per account: `missing`, `present`, `symlink` (with its
target) or `dangling` (with the target that is not there). A `present` or
`symlink` directory also reports its immediate children, so a skills folder
kept in a dotfiles repo lists its skills rather than reading as an opaque link.

### The `[install]` table

The vendor's own documented install command, exactly as documented. When an
agent's binary is not on PATH, the Install button on its Settings page runs
this in a visible terminal tab (spawned directly, no shell) and re-probes
health when the process exits: Tori opens the door and never installs anything
itself, the same posture as sign-in. Omit the whole table when nobody has
verified an install end to end on a real machine, and the page falls back to
"install `program` yourself" instructions: an unverified one-liner would be a
button claiming a measurement that never happened. The command is only as
portable as the tool it names (`npm` assumes Node), which the visible tab makes
an acceptable trade: "npm: command not found" is a readable failure, not a
mystery.

The table can also carry `update_args` and `uninstall_args`, sharing the same
`program`: every package manager worth declaring spells all three verbs as
arguments to one binary (`npm install -g` is also npm's update; `brew` would
use `upgrade`/`uninstall`). The update runs from the version-drift banner and
the uninstall from the Agent group on the same page, each in the same kind of
visible tab. Either list left empty means that verb is undeclared and gets no
button - the install verb does not lend its args to the others.

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
or edited) and scoped to Tori-launched sessions only - an externally-typed
`claude` never receives the flag. The value is a **path** to a small
Tori-written file (`~/.config/tori/claude-hooks-settings.json`), not inline
JSON - every agent tab's launch command is typed into its login shell one
byte at a time, and a PTY in canonical mode silently truncates a single
line beyond the kernel's line-discipline buffer, so an inline settings blob
(2KB+) got cut mid-string and hung the shell on an unclosed quote (caught
live, not in review). Each hook's command greps only
`session_id`/`hook_event_name` off the JSON payload on stdin (POSIX
`grep`/`sed`/`printf`, no jq/node/python dependency, and prompt text/tool
input are never written to disk) and writes a small
`~/.config/tori/hooks-status/<session id>.json` marker. `Notification` -
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

`launch.resume_args` and `running.pattern` are templates. Tori substitutes:

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
session data into Tori's session model (prompt/turn/tool counts, touched
files, the chat panel's replay of an existing session, the needs-you tail
state). Parser kinds are implemented in Tori itself,
not user-authorable - a user adapter can only *reference* one of:

- `claude_jsonl` - Claude Code's transcript shape: `type: "user"/"assistant"`
  at the top level of each `.jsonl` line, `message.content` an array of
  `text`/`thinking`/`tool_use` blocks, and a `tool_result` block riding inside
  the *next* user turn's content.

That is the only kind today, and it is a closed Rust enum rather than a config
string precisely so this stays honest: a TOML naming an unimplemented kind is
rejected at load rather than half-working. **Adding a kind is a Tori code
change**, in `sessions.rs`'s transcript readers - the compiler names every site
that has to answer for a new variant.

### `discovery.backend`

One backend today:

- **`"file"`** (default, and the only value accepted): the agent writes one
  file per session under a directory tree. `dir` is the session-transcript
  root; `filename_pattern` is matched against each file's *name* (not its full
  path) inside every immediate subdirectory of `dir` (Tori's layout is
  `<dir>/<encoded-cwd>/<session-file>`). Must contain a named capture group
  called `id`, used as a fallback session id when the transcript's own content
  doesn't yield one.

Like `parser.kind`, this is a closed Rust enum. An agent that keeps every
session as rows in one shared database rather than a file per session needs a
new variant here, because discovery, deletion, mtime and the file watcher all
have to answer differently for it - and the compiler will say so at each of
them.

### Sessions on disk, or over a protocol

`[discovery]`, `[parser]` and `[running]` are **one fact about an adapter, not
three**, and the loader requires all three or none:

- **All three** - a file-backed agent. Tori walks `discovery.dir`, parses each
  transcript with `parser.kind`, and recognises a live session by matching
  `running.pattern` against the process table. This is `claude`, and every v1
  adapter.
- **None** - an agent whose sessions only its own protocol reaches. Allowed only
  when `chat.transport` is one that carries sessions in-protocol (today: `acp`).
  Tori keeps its own small locator file per session instead, records what the
  protocol told it, and reopens a conversation with `session/load`. It forks
  one with `session/fork` only when the agent advertises
  `sessionCapabilities.fork` on its handshake, which is what lets a hunk's
  side question reach that agent; the verb is unstable in the protocol, so the
  crate is pinned. Rewind still needs a replay cut at a turn, which ACP lacks.
- **None, and no `[chat]`** - a launch-only adapter (v6), declared with
  `capabilities.sessions = false`. Tori starts it in a terminal tab and lists no
  sessions for it, and its card says so. `launch.resume_args` may be omitted,
  since there is nothing to resume. The declaration is required rather than
  inferred, because an adapter that silently lost its tables must not read as
  one that never had any; `sessions = false` beside any of the four tables is
  rejected.
- **Some** - always rejected, naming the missing tables. This is the case the
  rule exists for: a typo that loses `[discovery]` from a Claude-shaped adapter
  would otherwise resolve as a protocol-backed one, and its sessions would simply
  stop appearing - which looks nothing like a config error from the outside.

Why not declare them anyway for an ACP agent? Because each would be false in a
way that costs something. No directory-and-regex describes a store only the
agent can read; a parser kind would have nothing to parse; and a `pgrep` pattern
is actively dangerous, since every session of one ACP agent shares the command
line `opencode acp`, so a pattern match would report all of them running whenever
any one was. Tori answers liveness for those agents from the child process it
started itself.

## Example: a from-scratch third-party adapter

### A file-backed agent

A complete, valid adapter for a hypothetical `acme` CLI that happens to write
Claude-shaped transcripts (illustrative - a real one would likely need its own
parser kind):

```toml
schema_version = 1
id = "acme"
label = "Acme"

[launch]
program = "acme"
base_args = []
yolo_args = ["--yolo"]
resume_args = ["--resume", "{id}"]

[discovery]
dir = "~/.acme/sessions"
filename_pattern = '^(?P<id>.+)\.jsonl$'

[parser]
kind = "claude_jsonl"

[running]
pattern = 'acme --resume {id}'

[capabilities]
pty_quiet_ms = 2000
```

Save this as `~/.config/tori/packs/agents/acme.toml` and restart Tori; a "+ Acme"
launch option appears alongside the bundled agents.

### An ACP agent

For an agent that speaks ACP first-party this is the whole file - no Rust, and
no session plumbing, because the protocol carries all of it:

```toml
schema_version = 2
id = "acme-acp"
label = "Acme"

[launch]
program = "acme"
base_args = []
yolo_args = []
resume_args = []

[chat]
transport = "acp"
base_args = ["acp"]
```

The bundled `opencode` adapter is this plus comments explaining
what was measured. Everything the chat surface shows - the model list, the
permission questions, whether a closed chat can be reopened - comes from the
agent's own handshake, so there is nothing here to keep in step with it.

### A launch-only agent

For an agent Tori should only start, with no chat pane and no session list,
this is the whole file. It needs v6:

```toml
schema_version = 6
id = "acme-cli"
label = "Acme CLI"

[launch]
program = "acme"

[capabilities]
sessions = false

[install]
program = "npm"
args = ["install", "-g", "acme-cli"]

[accounts]
login_args = ["login"]
whoami_args = ["whoami", "--json"]
whoami_kind = "json"
whoami_signed_in_key = "signedIn"
whoami_account_key = "user.email"
```

## Whole-replacing a bundled adapter

To point Tori's `claude` adapter at a wrapper script instead of the real
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
