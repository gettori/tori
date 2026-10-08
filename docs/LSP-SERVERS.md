# Language servers

Tori's editor gets completion, hover, diagnostics and navigation from language
servers. Which servers exist is **data, not code**: each one is a TOML file, so
adding a language is a config file rather than a branch in `src-tauri/src/lsp.rs`.

This is the same shape as [ADAPTERS.md](ADAPTERS.md) describes for agents, and
deliberately so, down to the override and error-handling rules.

## Supported servers

These eight are the core set: four ship bundled, one is expected on your PATH, and three run from the project's own install:

| id | Server | Launch | Notes |
|---|---|---|---|
| `typescript` | `typescript-language-server` | `bundled_node` | Ships inside the app; run `pnpm lsp:install` in a dev tree. |
| `json` | `vscode-json-languageserver` | `bundled_node` | The server behind VS Code's own JSON support. Schemas come from SchemaStore, fed in by Tori. |
| `yaml` | `yaml-language-server` | `bundled_node` | The server behind Red Hat's VS Code YAML extension. Brings its own SchemaStore support. |
| `eslint` | `vscode-eslint-language-server` | `bundled_node` | A secondary beside `typescript`, started only under an ESLint config in a trusted project. Ships through `vscode-langservers-extracted`, which packages the server behind VS Code's ESLint extension. That server only answers diagnostics when asked (`textDocument/diagnostic`), so Tori pulls them after each change. |
| `rust` | `rust-analyzer` | `path` | Not bundled: rustup already manages it, and a stale bundled copy would fight the toolchain the project builds with. |
| `biome` | `biome lsp-proxy` | `project_bin` | A secondary started only under a `biome.json` or `biome.jsonc`, in a trusted project, using the project's own Biome so its version matches CI. |
| `oxlint` | `oxlint --lsp` | `project_bin` | A secondary started only under an oxlint config (`.oxlintrc.json`, `.oxlintrc.jsonc`, `oxlint.config.ts`, `oxlint.config.mts`), in a trusted project, using the project's own oxlint. |
| `ruff` | `ruff server` | `project_bin` | A secondary beside `python`, started only under a `ruff.toml`, `.ruff.toml` or a `[tool.ruff]` table in `pyproject.toml`, in a trusted project, using the Ruff in the project's virtualenv, else the one on your PATH. Formatting stays with the `ruff` formatter (see FORMATTERS.md). |

A language with no server is a supported state, not a broken one. Tori has
grammars for far more languages than it has servers for; those files open,
edit, highlight and save exactly as before, they just get no language
intelligence.

### The catalog

Beyond the core set, Tori knows how to run one server for each of these
languages. Each is a primary, and each is either bundled, installed by Tori
from Settings > LSP at a pinned version (see "Installing servers"), or
installed by you, with a hint on its card saying how.

| id | Server | How it gets there |
|---|---|---|
| `css` | `vscode-css-language-server` | Bundled, from `vscode-langservers-extracted`. |
| `html` | `vscode-html-language-server` | Bundled, from `vscode-langservers-extracted`. |
| `python` | `pyright-langserver` | npm `pyright` |
| `bash` | `bash-language-server` | npm `bash-language-server` |
| `svelte` | `svelteserver` | npm `svelte-language-server` |
| `astro` | `astro-ls` | npm `@astrojs/language-server`. Needs a `typescript/lib`, see "Placeholders" |
| `php` | `intelephense` | npm `intelephense` |
| `vim` | `vim-language-server` | npm `vim-language-server` |
| `elm` | `elm-language-server` | npm `@elm-tooling/elm-language-server` (needs `elm`) |
| `prisma` | `prisma-language-server` | npm `@prisma/language-server` |
| `perl` | `perlnavigator` | npm `perlnavigator-server` |
| `graphql` | `graphql-lsp` | npm `graphql-language-service-cli` |
| `fish` | `fish-lsp` | npm `fish-lsp` (needs `fish`) |
| `clangd` | `clangd` | GitHub release; Xcode's command line tools already ship one |
| `lua` | `lua-language-server` | GitHub release |
| `markdown` | `marksman` | GitHub release |
| `latex` | `texlab` | GitHub release |
| `xml` | LemMinX | GitHub release |
| `typst` | `tinymist` | GitHub release |
| `toml` | `tombi` | GitHub release |
| `clojure` | `clojure-lsp` | GitHub release |
| `go` | `gopls` | You: `go install golang.org/x/tools/gopls@latest` |
| `ruby` | `ruby-lsp` | You: `gem install ruby-lsp` |
| `java` | `jdtls` | You: `brew install jdtls` |
| `kotlin` | `kotlin-language-server` | You: `brew install kotlin-language-server` |
| `swift` | `sourcekit-lsp` | Ships with Xcode and the Swift toolchain |
| `csharp` | `csharp-ls` | You: `dotnet tool install --global csharp-ls` |
| `zig` | `zls` | You: the release that matches your Zig |
| `haskell` | `haskell-language-server-wrapper` | You: `ghcup install hls` |
| `ocaml` | `ocamllsp` | You: `opam install ocaml-lsp-server` |
| `elixir` | `elixir-ls` | You: `brew install elixir-ls`. Starts only under a `mix.exs` |
| `dart` | `dart language-server` | Ships with the Dart and Flutter SDKs |
| `terraform` | `terraform-ls` | You: `brew install hashicorp/tap/terraform-ls` |
| `scala` | `metals` | You: `cs install metals` |
| `nix` | `nil` | You: `nix profile install nixpkgs#nil` |

A server Tori can install still prefers your own copy: if its program is on
your login PATH, that one runs.

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

# optional: keys in a .json or .toml file that activate it the same way, as a
# dot separated path (`tool.ruff` is the `[tool.ruff]` table). The key only has
# to exist.
activation_keys = [{ file = "pyproject.toml", key = "tool.some" }]

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

# optional: how the server gets onto the machine. See "Installing servers" below.
[install]
kind = "hint"
text = "Install it with `brew install some-language-server`."

# optional: passed to the server as `initializationOptions`, verbatim except
# for the placeholders under "Placeholders" below.
[initialization_options]
someServerSpecificFlag = true

[initialization_options.typescript]
tsdk = "${tsdk}"

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

### Placeholders

A config cannot know a path that depends on the project, so a string inside
`[initialization_options]` may carry a placeholder that `lsp_start` fills in
for the root it resolved. There is one:

| Placeholder | Resolves to |
|---|---|
| `${tsdk}` | A `typescript/lib` directory: the project's own `node_modules/typescript/lib`, found by walking from the server's root up to the project directory, else the copy Tori bundles for its TypeScript server. Neither existing is a start error that names `pnpm lsp:install`. |

Servers built on Volar (Astro, Vue, MDX) embed a TypeScript service rather than
talking to tsserver, and refuse `initialize` unless `typescript.tsdk` tells
them which one to load. The project's copy wins so their type errors agree with
the project's own `tsc`; the bundled copy is what most Astro projects get,
since `astro` does not depend on `typescript`. The path used is written to the
server's log, the one "Show log" opens when a server stops, so a crash report
says which TypeScript it was running on.

A config without a placeholder is passed through untouched and resolves
nothing. `[settings]` takes no placeholders.

### Launch kinds

`launch.kind` is a **closed set**. A config naming a kind Tori does not
implement is a load error, not a warning: a server that never spawns looks
exactly like a language with no support at all, which is the wrong thing to
leave someone debugging.

| kind | Fields | Behaviour |
|---|---|---|
| `path` | `program`, `args` | Resolves `program` on the **login-shell** PATH, never the GUI process PATH. A server installed via rustup, mise, asdf or nvm is invisible to a naive lookup from a Finder-launched app. |
| `bundled_node` | `entry`, `args` | Runs `entry` (relative to the app's resource dir, with a dev-tree fallback) using the user's system `node`. For servers Tori ships. |
| `project_bin` | `program`, `args` | Runs the project's own `program` from the nearest `node_modules/.bin`, `.venv/bin` or `venv/bin` between the server's root and the project directory, else from the login-shell PATH, the same lookup the project formatter uses. Always counts as `runs_project_code`, and its health card reads "runs per project". |
| `managed` | `program`, `args`, `runtime` | Runs `program` from the login-shell PATH, else the copy Tori installed from `[install]`. `runtime` is `node` (Tori's copy is a script, run with the user's `node`) or `native`. Needs an `[install]` of kind `npm` or `github_release`. |

For a `bundled_node` server the binary that has to exist on the user's machine
is `node`, so that is what the health card probes.

### Installing servers

`[install]` says how a server gets onto the machine. Its `kind` is a closed
set, and a kind Tori does not implement is a load error:

| kind | Fields | Behaviour |
|---|---|---|
| `npm` | `package`, `version` | `npm install --ignore-scripts <package>@<version>`. `version` is one exact version; a range or `latest` is a load error. |
| `github_release` | `repo`, `version`, `[install.assets.<platform>]` | Downloads `https://github.com/<repo>/releases/download/<version>/<file>` over HTTPS only, and checks its `sha256` before anything is written. `version` is the release tag. |
| `hint` | `text`, optional `update`, `uninstall` | For a server its own toolchain manages. The card shows `text`, and Install runs the first backticked command in it. Once the server is found, Update and Uninstall run `update` and `uninstall`. |

`npm` and `github_release` need `launch.kind = "managed"`, and `managed` needs
one of them: Tori installs into `~/.config/tori/servers/<id>/`, and only
`managed` looks there.

Each release asset is keyed by platform, `<os>-<arch>` as Rust names them
(`macos-aarch64`, `macos-x86_64`), and names its `file`, its `sha256`, and
optionally `bin`, the server binary's path inside the install, which defaults
to `program`. A `.zip` or `.tar` archive is unpacked with the system `tar`,
which refuses an entry that would land outside the install; any other file is
the binary itself.

```toml
[launch]
kind = "managed"
runtime = "native"
program = "lua-language-server"
args = []

[install]
kind = "github_release"
repo = "LuaLS/lua-language-server"
version = "3.19.1"

[install.assets.macos-aarch64]
file = "lua-language-server-3.19.1-darwin-arm64.tar.gz"
sha256 = "0bc077f4447f076b4c92c14e9fd303f5b569eda2ec74b4dca2b55f75fae2e90c"
bin = "bin/lua-language-server"
```

Install, Update and Remove live on the server's card in Settings > LSP. For a
`hint` server the card runs the command in a terminal inside Settings, through
`/bin/sh -c` with your login PATH, and asks before an uninstall. Tori does not
know how a server it finds was installed, so an `uninstall` that does not match
fails in that terminal and changes nothing. It also cannot tell whether an
update exists: Update runs the command either way.

```toml
[install]
kind = "hint"
text = "Install it with `brew install jdtls`."
update = "brew upgrade jdtls"
uninstall = "brew uninstall jdtls"
```

Opening a file whose server Tori can install, but has not, also offers it in a
banner above the file: Install, Not now (asked again next session), or Never
for this language, which adds the id to `lsp.neverOffer` in
`~/.config/tori/settings.json`. The card can still install it.

```json
{ "lsp": { "neverOffer": ["python"] } }
```

An install is built beside the real directory and moved into place only when
it is complete, so a failed download or a checksum mismatch leaves the
previous install, or nothing. Versions are pinned in the config and move with
Tori releases; when Tori pins a newer one, the card offers Update.

The checksum and the URL sit in the same file, so the checksum proves the
bytes that arrived are the bytes this config named. It proves nothing about a
config someone else wrote.

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
out if its id is in `lsp.disabled`, or if it names `activation_markers` or
`activation_keys` and none of them is found between the file and the project
root. That walk stops at the project root, the same way root resolution does,
so a marker above the project never switches a server on.

Of what is left, the file gets one primary and every secondary:

- The primary is the one with the highest `priority`. On a tie, one that needed
  a marker to activate beats one that is always on, because it is the more
  specific answer. So a Deno config with `activation_markers = ["deno.json"]`
  takes `.ts` files inside Deno packages, and TypeScript keeps the rest.
- Secondaries only add to the primary. Today Tori resolves them but does not
  start them yet.
- Two primaries with no `activation_markers` or `activation_keys` at the same
  `priority` claiming the same extension is a load error. The file loaded later
  is refused and logged, and user files load in filename order, so which one is
  refused does not depend on the filesystem.

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
- Settings > Projects lists trusted projects, each with Revoke.
- The field defaults to `true`, so a server config that does not say is
  treated as running project code. Set it to `false` only for a server that
  executes nothing from the project.
- When trust first shipped, every project already discovered was recorded as
  trusted, because those projects had been running these servers all along.

## Example: a from-scratch third-party server

A complete config for Python via a `pyright` you installed yourself. Tori's
catalog has a `python` server too, so this file, dropped at
`~/.config/tori/lsp/python.toml`, whole-replaces it. Restart after adding it:

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

Settings > LSP will then show a card for it, reporting
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
