# Session transcript-head fixtures

Redacted heads of real `~/.claude/projects/**/<id>.jsonl` transcripts, captured for
`sessions::parse_session` (the head-only scanner that produces a session's title).
They are **not** the same thing as `dev/fixtures/claude/`, which holds `stream-json`
captures of the chat host's protocol and is re-verified by `dev/protocol-probe.mjs`.

The tests read these files by relative path from `CARGO_MANIFEST_DIR`, never from
`$HOME`: a scanner test that read the developer's own transcript directory would
pass or fail depending on whose machine it ran on.

## Redaction

Captured verbatim except: every path under the home directory is rewritten to
`/Users/dev/proj`, uuids are renumbered from 1, ANSI escapes are stripped, and long
prose bodies are cut at a word boundary and marked with `…`. Command envelopes,
the local-command caveat and command output are kept **byte-for-byte**, because
their exact tags and their ordering are what the parser branches on.

## The fixtures

| Fixture | Head shape | Title |
|---|---|---|
| `plain-prompt` | one typed message | the message (control: the ordinary path) |
| `slash-opener-with-args` | `/plan` skill opener, prompt inside `<command-args>` | `/plan <args>` |
| `clear-then-slash-opener` | `/clear` (local), then a `/gg` skill opener with no args | `/gg` |
| `local-command-only` | caveat + `/model` + its stdout, nothing else | empty |
| `local-command-then-prompt` | `/model haiku` (local), then a typed `hello` | `hello` |

The last two are the pair that pins the distinction: a command envelope introduced
by `<local-command-caveat>` is a client-side command, so it never becomes a title,
even when it carries args (`/model haiku`). A command envelope with no caveat is a
skill invocation, which is exactly what the person typed.
