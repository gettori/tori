# Formatters

Format Document and format on save run a command line formatter over the
buffer. Which formatters exist is **data, not code**: each one is a TOML file,
so adding one is a config file rather than a branch in `src-tauri/src/format.rs`.

This is the same shape as [LSP-SERVERS.md](LSP-SERVERS.md) describes for
language servers, down to the loading and override rules.

Every formatter is driven over stdin and stdout, never pointed at the file.
Formatting on save acts on the buffer, which is not what is on disk yet; a tool
told to fix the file in place would format the version about to be overwritten.

## Supported formatters

| id | Command | Launch | Picked up by |
|---|---|---|---|
| `biome` | `biome format` | `project_bin` | `biome.json`, `biome.jsonc` |
| `oxfmt` | `oxfmt` | `project_bin` | `.oxfmtrc.json`, `.oxfmtrc.jsonc`, `oxfmt.config.ts`, `oxfmt.config.mts` |
| `prettier` | `prettier` | `project_bin` | `.prettierrc*`, `prettier.config.*`, or a `prettier` key in `package.json` |
| `black` | `black` | `project_bin` | A `[tool.black]` table in `pyproject.toml` |
| `ruff` | `ruff format` | `project_bin` | `ruff.toml`, `.ruff.toml`, or a `[tool.ruff]` table in `pyproject.toml` |
| `stylua` | `stylua` | `path` | `stylua.toml`, `.stylua.toml` |
| `gofmt` | `gofmt` | `path` | Nothing. It runs only when `format.byExtension` names it. |
| `shfmt` | `shfmt` | `path` | Nothing, the same. |
| `vite-plus` | `vp fmt` | `project_bin` | Nothing, the same. |

The last three have no file that says a repo formats with them. gofmt has no
config at all, and a `go.mod` says a directory is Go, not how it is formatted.
shfmt reads `.editorconfig`, which says nothing about shfmt.

A `pyproject.toml` with both `[tool.black]` and `[tool.ruff]` formats with
Black, whose `priority` is higher: a project that sets up both usually lints
with Ruff and formats with Black. Black keeps its settings in `pyproject.toml`
only, so a project running Black on its defaults has no table to find. Name it
in `format.byExtension`.

### Vite+

`vp fmt` takes the buffer on stdin with `--stdin-filepath`, the same flag as
oxfmt, which it wraps, and reads the `fmt` block of the root `vite.config.ts`.
Every Vite project has that file whether or not it formats with vp, so nothing
on disk picks Vite+ up. Name it for the extensions you want:

```json
{ "format": { "byExtension": { "ts": "vite-plus", "tsx": "vite-plus" } } }
```

## Which formatter a file gets

Asked in this order, first answer wins:

1. **This workspace's `format.byExtension`**, in `<workspace>/.tori/settings.json`.
2. **The project's own config.** Every formatter whose markers sit in a
   directory between the file and the project directory (inclusive), nearest
   directory first.
3. **Your `format.byExtension`**, in `~/.config/tori/settings.json`.
4. **The language server's formatting**, for Format Document. Format on save
   runs no language server formatting.
5. Nothing.

```json
{ "format": { "byExtension": { "py": "ruff", "sh": "shfmt" } } }
```

Keys are file extensions (case-insensitive, a leading dot optional) and values
are formatter ids. A project with no formatter config gets no command line
formatter unless you name one: formatting with a tool's defaults puts a surprise
diff in somebody's pull request.

A formatter id in your `format.disabled` never runs. Wherever it would have
been asked, the file goes on to the next formatter on the chain. The switch on
its card in Settings > Formatters writes it.

```json
{ "format": { "disabled": ["biome"] } }
```

The walk in rung 2 never rises above the project directory, so a stray
`~/.prettierrc` formats nothing. A file outside the project, or no project at
all, gets nothing from rungs 1 to 3.

When one directory holds configs for several formatters, a formatter whose
`extensions` lists the file's extension is asked before one that takes any
file, then the higher `priority` first, then by id. So `ruff.toml` beside
`biome.json` asks ruff first about Python, and `biome.json` beside `.prettierrc`
asks Biome first about TypeScript.

A formatter that **declines** a file (see `not_applicable` below) hands it to the
next formatter on the chain: the next one configured in the same directory, then
in the directories above, then the next rung. So Biome kept for linting, with
its formatter switched off, next to a `.prettierrc` formats with Prettier. Any
other failure stops the chain and is shown: a syntax error is the
same error whoever formats next. A formatter picked by a rung but not installed
is also shown rather than skipped, so a fresh clone before `npm install` does not
read as a project that does not format. A `format.byExtension` value that names
no formatter is shown the same way.

## File location and loading

Bundled configs live in `src-tauri/formatters/*.toml` and are embedded at compile
time. User configs live in `~/.config/tori/formatters/*.toml`.

Loading is bundled first, then every `*.toml` in the user directory in filename
order:

- A user file whose `id` matches a bundled one **whole-replaces** it, never
  merged field by field.
- A user file that fails validation is logged naming the problem, and the id it
  would have replaced keeps its previous entry.
- An unrecognized top-level field is warned about and ignored. A missing
  required field is an error naming every missing field at once.
- Files are read once at startup. Editing one means restarting Tori.
- A file is named after its `id`: `prettier.toml` holds `id = "prettier"`. A user
  file whose name and id differ still loads, with a warning naming both. An id
  is lowercase letters, digits, `.`, `_` and `-`, and starts with a letter or
  digit; any other id is refused.

## Schema

Every bare key comes first and every `[table]` comes last: in TOML a bare key
written after a table header belongs to that table.

```toml
schema_version = 1          # required; this build supports: 1
id = "prettier"             # required; unique, the override key, and what format.byExtension names
label = "Prettier"          # required; used in messages

# optional (default 0): decides between formatters configured in one directory.
# Higher wins.
priority = 0

# optional (default: any file): the extensions this formatter is asked about,
# case-insensitive, leading dot optional. Leave it out for a tool that decides
# per file (Prettier with plugins) and say how it declines in [not_applicable].
extensions = ["ts", "tsx"]

# optional: the version these arguments were checked against. Documentation only.
verified_against = "prettier 3.9.8"

# optional: the day verified_against was measured, written YYYY-MM-DD.
verified_on = "2026-10-09"

# optional: the catalog fields. One line for the formatter's card, the SPDX id
# of the licence this file is shared under, and who wrote it.
description = "JavaScript, TypeScript, CSS, Markdown and more"
license = "MIT"
contributor = { name = "Tori", github = "gettori" }

# --- tables below this line; nothing top-level may follow them ---

# optional: what marks a directory as configured for this formatter. Any one
# match is enough. With no markers the formatter runs only when
# format.byExtension names it.
[markers]
files = ["exact.name"]                                  # exact filenames
prefixes = [".prettierrc", "prettier.config."]          # filename starts
keys = [{ file = "package.json", key = "prettier" }]    # a key in a .json or .toml file

# required: how the formatter is found and run. See "Launch kinds".
[launch]
kind = "project_bin"
program = "prettier"
args = ["--stdin-filepath", "{file}"]

# optional: how the formatter says "not my kind of file". Every condition
# given must hold. See "Declining a file".
[not_applicable]
exit_code = 2
stderr = "No parser could be inferred"
```

### Markers

`keys` reads a JSON or TOML file (chosen by its extension) and looks the key up
as a dot separated path: `tool.ruff` in `pyproject.toml` is the `[tool.ruff]`
table. The key only has to exist. A path segment cannot itself contain a dot.

### Launch kinds

`launch.kind` is a **closed set**; any other value is a load error.

| kind | Behaviour |
|---|---|
| `project_bin` | The project's own `program` from the nearest `node_modules/.bin`, `.venv/bin` or `venv/bin` between the config's directory and the project directory, else the login shell PATH. A repo pins its formatter's version so everyone's output matches. Poetry and pipenv keep their virtualenvs outside the project by default, so a tool installed there comes from the PATH. |
| `path` | `program` on the login shell PATH, never the GUI process PATH. |

`{file}` in any argument is replaced with the file's absolute path, which is how
a formatter picks its parser and finds per-file settings. The formatter runs in
the nearest directory holding its config, or in the file's own directory when
there is none (a formatter only a setting picked).

### Declining a file

A formatter that takes any file needs a way to say a file is not its kind. Both
that and a syntax error are a failed exit, and only the first should hand the
file on, so `[not_applicable]` names what the decline looks like: `exit_code`,
`stderr` (a regular expression searched in stderr), or both. Leaving both out is
a load error, because it would match every failure. A timeout or a formatter
that could not start is never a decline.

The bundled ones, each taken from the real binary:

| id | exit | stderr |
|---|---|---|
| `prettier` | 2 | `No parser could be inferred` |
| `biome` | 1 | `the formatter is currently disabled` |
| `oxfmt`, `vite-plus` | 1 | `Unsupported file type` |

This is what lets a `.rs` file in a repo with a `.prettierrc` reach
rust-analyzer's formatting, while a `.svelte` file in a repo with
`prettier-plugin-svelte` still formats through Prettier.

## Example: a from-scratch formatter

A complete config for `clang-format`, which Tori does not ship. Drop this at
`~/.config/tori/formatters/clang-format.toml` and restart:

```toml
schema_version = 1
id = "clang-format"
label = "clang-format"
extensions = ["c", "h", "cc", "cpp", "hpp"]

[markers]
files = [".clang-format", "_clang-format"]

[launch]
kind = "path"
program = "clang-format"
args = ["--assume-filename={file}"]
```

## Whole-replacing a bundled formatter

Use the bundled formatter's `id`. To keep Prettier to web files only:

```toml
# ~/.config/tori/formatters/prettier.toml
schema_version = 1
id = "prettier"
label = "Prettier"
extensions = ["ts", "tsx", "js", "jsx", "css", "json", "md"]

[markers]
prefixes = [".prettierrc", "prettier.config."]
keys = [{ file = "package.json", key = "prettier" }]

[launch]
kind = "project_bin"
program = "prettier"
args = ["--stdin-filepath", "{file}"]
```

Because this is a whole replacement, every marker you still want has to be
listed.
