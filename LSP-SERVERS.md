# Language servers

Tori's editor gets completion, hover, diagnostics and navigation from language
servers. Which servers exist is **data, not code**: each one is a TOML file, so
adding a language is a config file rather than a branch in `src-tauri/src/lsp.rs`.

This is the same shape as [ADAPTERS.md](ADAPTERS.md) describes for agents, and
deliberately so, down to the override and error-handling rules.

## Supported servers

Four ship bundled, one is expected on your PATH:

| id | Server | Launch | Notes |
|---|---|---|---|
| `typescript` | `typescript-language-server` | `bundled_node` | Ships inside the app; run `pnpm lsp:install` in a dev tree. |
| `json` | `vscode-json-languageserver` | `bundled_node` | The server behind VS Code's own JSON support. Schemas come from SchemaStore, fed in by Tori. |
| `yaml` | `yaml-language-server` | `bundled_node` | The server behind Red Hat's VS Code YAML extension. Brings its own SchemaStore support. |
| `eslint` | `vscode-eslint-language-server` | `bundled_node` | A secondary beside `typescript`, started only under an ESLint config in a trusted project. Ships through `vscode-langservers-extracted`, which packages the server behind VS Code's ESLint extension. That server only answers diagnostics when asked (`textDocument/diagnostic`), so Tori pulls them after each change. |
| `rust` | `rust-analyzer` | `path` | Not bundled: rustup already manages it, and a stale bundled copy would fight the toolchain the project builds with. |

A language with no server is a supported state, not a broken one. Tori has
grammars for several languages it has no server for (Python, CSS, HTML); those
files open, edit, highlight and save exactly as before, they just get no
language intelligence.

### Schemas for JSON and YAML

Both servers validate against [JSON Schema](https://json-schema.org), and both
find the right schema for a file the same way: [SchemaStore](https://www.schemastore.org)'s
catalog maps filename patterns (`package.json`, `.github/workflows/*.yml`) to
schema URLs.

They get there differently, and the difference is not cosmetic:

- **YAML** has catalog support built in. Tori's only job is to make sure its
  configuration actually arrives, which is what `[settings]` in `yaml.toml` does.
- **JSON** has none. VS Code feeds it the associations, so Tori does the same:
  it fetches the catalog once, caches it under `~/.config/tori/cache/` for a
  day, and sends the associations as `json/schemaAssociations`.

**Offline, both degrade to no validation, never to a broken editor.** A catalog
that cannot be fetched yields no associations and is logged once; a schema URL
that cannot be resolved is the server's own problem and it carries on. JSON and
YAML files still open, edit, highlight and save.

## File location and loading

Bundled configs live in `src-tauri/lsp/*.toml` and are embedded at compile time.
User configs live in `~/.config/tori/lsp/*.toml`.

Loading is bundled-first, then every `*.toml` in the user directory:

- A user file whose `id` matches a bundled one **whole-replaces** it. The entire
  config is replaced, never merged field by field, so a partial override does
  not inherit half of the built-in.
- A user file that fails validation is **never silently swallowed**: the error
  is logged naming the problem, and the id it would have overridden keeps its
  previous entry. One broken file can't make a language lose its server.
- Files are read once at startup. Editing one means restarting Tori, the same as
  every other loaded-at-startup config.

## Schema

Every bare key comes first and every `[table]` comes last, which is not a style
choice: in TOML a bare key written after a table header **belongs to that
table**. A top-level field placed below one of these tables silently becomes
part of it, and nothing complains.

```toml
schema_version = 1          # required; this build supports: 1
id = "typescript"           # required; unique, and the override key
label = "TypeScript"        # required; shown on the Settings health card

# required: filenames marking a project root. See "Root resolution" below.
root_markers = ["tsconfig.json", "package.json", ".git"]

# optional (default 20000): how long the editor waits for a request.
request_timeout_ms = 20000

# optional (default false): send this server the SchemaStore catalog as a
# `json/schemaAssociations` notification after initialize. Only
# vscode-json-languageserver understands that notification, so this is opt-in
# per config rather than something every server is handed.
schema_associations = false

# optional: the server version this config's conventions were captured
# against, e.g. "rust-analyzer 0.3.1900". Omitting it is normal and makes the
# health card render neutral; it never renders as drift.
verified_against = "some-language-server 1.2.3"

# optional (default true): this server executes code from the project it
# serves, so it only starts in a project the user has trusted. See "Project
# trust" below.
runs_project_code = true

# optional (default "primary"): "primary" owns the file, "secondary" runs beside
# it (a linter next to the compiler's server). See "Which servers a file gets".
role = "primary"

# optional (default 0): decides between primaries that are both active for one
# file. Higher wins.
priority = 0

# optional (default: every feature): which optional features to ask this server
# for. Set `features` to allow only some, or `except_features` to drop some,
# never both. Known features: diagnostics, code_action, format.
# features = ["diagnostics", "code_action"]
except_features = ["format"]

# optional (default: always active): filenames one of which must sit between
# the file and the project root for this server to start there.
activation_markers = ["some.config.json"]

# --- tables below this line; nothing top-level may follow them ---

# required: which file extensions this server claims, and the LSP language id
# to open each one as. Extensions are matched case-insensitively and a leading
# dot is optional, so `ts`, `.ts` and `.TS` are the same key.
[languages]
ts = "typescript"
tsx = "typescriptreact"

# required: how the server process is started. See "Launch kinds" below.
[launch]
kind = "path"
program = "some-language-server"
args = ["--stdio"]

# optional: passed to the server as `initializationOptions`, verbatim.
[initialization_options]
someServerSpecificFlag = true

# optional: server configuration. See "Configuration" below.
[settings.someServer]
validate = true
```

### Configuration

`[settings]` is free-form and reaches the server **two ways**, because servers
disagree about which one they read:

- pushed once after initialize as `workspace/didChangeConfiguration`, with the
  whole table as the `settings` payload;
- and answered, section by section, every time the server pulls with
  `workspace/configuration`. A requested section is looked up as a top-level key
  of `[settings]`, and a section this config says nothing about is answered
  `null` rather than left unanswered.

Both, rather than a choice, because the two bundled servers here differ:
`vscode-json-languageserver` reads the push, and `yaml-language-server` answers
the push by *pulling its configuration back*, so for that one it is the second
route that carries the values. A config author should not have to know which.

An unrecognized top-level field is warned about and ignored, so a config written
for a newer Tori still loads. A missing **required** field is an error, and the
message names every missing field at once rather than just the first.

### Launch kinds

`launch.kind` is a **closed set**. A config naming a kind Tori does not
implement is a load error, not a warning: a server that never spawns looks
exactly like a language with no support at all, which is the wrong thing to
leave someone debugging.

| kind | Fields | Behaviour |
|---|---|---|
| `path` | `program`, `args` | Resolves `program` on the **login-shell** PATH, never the GUI process PATH. A server installed via rustup, mise, asdf or nvm is invisible to a naive lookup from a Finder-launched app. |
| `bundled_node` | `entry`, `args` | Runs `entry` (relative to the app's resource dir, with a dev-tree fallback) using the user's system `node`. For servers Tori ships. |

For a `bundled_node` server the binary that has to exist on the user's machine
is `node`, so that is what the health card probes.

### Root resolution

A server is started **per project root**, and the root is resolved per file: the
nearest ancestor directory holding one of `root_markers`, searching upward from
the file and stopping at the project directory.

This is why the list is ordered most-specific first. Given
`root_markers = ["tsconfig.json", "package.json", ".git"]`, a file at
`packages/a/src/index.ts` in a monorepo resolves to `packages/a` if that package
has its own `tsconfig.json`, not to the repo root.

Two consequences worth knowing:

- **One server id can have several live sessions**, one per resolved root.
  Sessions are keyed by `(id, root)`. Sharing a single session across roots
  would answer one package's requests from another package's compiler config.
- **The walk never rises above the project directory.** A `tsconfig.json` in
  your home directory cannot become the root for a file inside a project.

A file with no marker anywhere above it falls back to the project directory.

### Which servers a file gets

Every server claiming the file's extension is a candidate. A candidate drops
out if its id is in `lsp.disabled`, or if it names `activation_markers` and
none of them sits between the file and the project root. That walk stops at
the project root, the same way root resolution does, so a marker above the
project never switches a server on.

Of what is left, the file gets one primary and every secondary:

- The primary is the one with the highest `priority`. On a tie, one that needed
  a marker to activate beats one that is always on, because it is the more
  specific answer. So a Deno config with `activation_markers = ["deno.json"]`
  takes `.ts` files inside Deno packages, and TypeScript keeps the rest.
- Secondaries only add to the primary. Today Tori resolves them but does not
  start them yet.
- Two primaries with no `activation_markers` at the same `priority` claiming
  the same extension is a load error. The file loaded later is refused and
  logged, and user files load in filename order, so which one is refused does
  not depend on the filesystem.

Creating or deleting an activation marker while Tori is open re-resolves the
open files under it, with no restart.

`lsp.disabled` lists server ids that never start. It can be set in two places:

- `~/.config/tori/settings.json`, for every project.
- `<workspace>/.tori/settings.json`, for one project.

The workspace list only adds to yours. A repo can ship its own
`.tori/settings.json`, and it must not be able to switch back on a server you
turned off. A disabled primary hands the file to the next active one.

```json
{ "lsp": { "disabled": ["eslint"] } }
```

### Project trust

Some servers run code that lives in the project. The bundled
`typescript-language-server` loads the workspace's own TypeScript and any
tsconfig plugins, and rust-analyzer runs build scripts and proc macros. Opening
a file in a freshly cloned repo would run that repo's code.

So a server with `runs_project_code = true` only starts in a project you have
trusted. The first time one is refused, Tori offers to trust the project.
Until you do, the project still highlights, edits and saves, and servers with
`runs_project_code = false` (the bundled JSON and YAML ones) work as normal.

- Trust is recorded per discovered project (`<root>/<space>/<project>`), so it
  covers every worktree of that project.
- The list lives in `~/.config/tori/trusted.json`, never inside the project,
  so a repo cannot mark itself trusted.
- Settings > Languages lists trusted projects, each with Revoke.
- The field defaults to `true`, so a server config that does not say is
  treated as running project code. Set it to `false` only for a server that
  executes nothing from the project.
- When trust first shipped, every project already discovered was recorded as
  trusted, because those projects had been running these servers all along.

## Example: a from-scratch third-party server

A complete config for Python via `pyright`, which Tori does not ship. Drop this
at `~/.config/tori/lsp/python.toml` and restart:

```toml
schema_version = 1
id = "python"
label = "Python (pyright)"
root_markers = ["pyproject.toml", "setup.py", "requirements.txt", ".git"]
request_timeout_ms = 30000

[languages]
py = "python"
pyi = "python"

[launch]
kind = "path"
program = "pyright-langserver"
args = ["--stdio"]
```

The Settings > Language servers section will then show a card for it, reporting
whether `pyright-langserver` resolves on your PATH.

## Whole-replacing a bundled server

Use the bundled server's `id`. To point Tori at your own
`typescript-language-server` instead of the one it ships:

```toml
# ~/.config/tori/lsp/typescript.toml
schema_version = 1
id = "typescript"
label = "TypeScript (mine)"
root_markers = ["tsconfig.json", "package.json", ".git"]

[languages]
ts = "typescript"
tsx = "typescriptreact"
js = "javascript"
jsx = "javascriptreact"

[launch]
kind = "path"
program = "typescript-language-server"
args = ["--stdio"]
```

Because this is a whole replacement, every extension you want served has to be
listed. Anything you leave out is no longer claimed by any server.
