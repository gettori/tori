# Language servers

Sway's editor gets completion, hover, diagnostics and navigation from language
servers. Which servers exist is **data, not code**: each one is a TOML file, so
adding a language is a config file rather than a branch in `src-tauri/src/lsp.rs`.

This is the same shape as [ADAPTERS.md](ADAPTERS.md) describes for agents, and
deliberately so, down to the override and error-handling rules.

## Supported servers

Two ship bundled:

| id | Server | Launch | Notes |
|---|---|---|---|
| `typescript` | `typescript-language-server` | `bundled_node` | Ships inside the app; run `pnpm lsp:install` in a dev tree. |
| `rust` | `rust-analyzer` | `path` | Not bundled: rustup already manages it, and a stale bundled copy would fight the toolchain the project builds with. |

A language with no server is a supported state, not a broken one. Sway has
grammars for several languages it has no server for (Python, YAML, CSS, HTML);
those files open, edit, highlight and save exactly as before, they just get no
language intelligence.

## File location and loading

Bundled configs live in `src-tauri/lsp/*.toml` and are embedded at compile time.
User configs live in `~/.config/sway/lsp/*.toml`.

Loading is bundled-first, then every `*.toml` in the user directory:

- A user file whose `id` matches a bundled one **whole-replaces** it. The entire
  config is replaced, never merged field by field, so a partial override does
  not inherit half of the built-in.
- A user file that fails validation is **never silently swallowed**: the error
  is logged naming the problem, and the id it would have overridden keeps its
  previous entry. One broken file can't make a language lose its server.
- Files are read once at startup. Editing one means restarting Sway, the same as
  every other loaded-at-startup config.

## Schema

```toml
schema_version = 1          # required; this build supports: 1
id = "typescript"           # required; unique, and the override key
label = "TypeScript"        # required; shown on the Settings health card

# required: which file extensions this server claims, and the LSP language id
# to open each one as. Extensions are matched case-insensitively and a leading
# dot is optional, so `ts`, `.ts` and `.TS` are the same key.
[languages]
ts = "typescript"
tsx = "typescriptreact"

# required: filenames marking a project root. See "Root resolution" below.
root_markers = ["tsconfig.json", "package.json", ".git"]

# optional (default 20000): how long the editor waits for a request.
request_timeout_ms = 20000

# required: how the server process is started. See "Launch kinds" below.
[launch]
kind = "path"
program = "some-language-server"
args = ["--stdio"]

# optional: passed to the server as `initializationOptions`, verbatim.
[initialization_options]
someServerSpecificFlag = true

# optional: the server version this config's conventions were captured
# against, e.g. "rust-analyzer 0.3.1900". Omitting it is normal and makes the
# health card render neutral; it never renders as drift.
verified_against = "some-language-server 1.2.3"
```

An unrecognized top-level field is warned about and ignored, so a config written
for a newer Sway still loads. A missing **required** field is an error, and the
message names every missing field at once rather than just the first.

### Launch kinds

`launch.kind` is a **closed set**. A config naming a kind Sway does not
implement is a load error, not a warning: a server that never spawns looks
exactly like a language with no support at all, which is the wrong thing to
leave someone debugging.

| kind | Fields | Behaviour |
|---|---|---|
| `path` | `program`, `args` | Resolves `program` on the **login-shell** PATH, never the GUI process PATH. A server installed via rustup, mise, asdf or nvm is invisible to a naive lookup from a Finder-launched app. |
| `bundled_node` | `entry`, `args` | Runs `entry` (relative to the app's resource dir, with a dev-tree fallback) using the user's system `node`. For servers Sway ships. |

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

## Example: a from-scratch third-party server

A complete config for Python via `pyright`, which Sway does not ship. Drop this
at `~/.config/sway/lsp/python.toml` and restart:

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

Use the bundled server's `id`. To point Sway at your own
`typescript-language-server` instead of the one it ships:

```toml
# ~/.config/sway/lsp/typescript.toml
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
