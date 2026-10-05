# Contributing

Thanks for looking. Tori is open source, and for now it is not open to code
contributions: **pull requests from outside the project are turned off.** One
person maintains it, it is not at 1.0 yet, and the design still moves faster
than a review queue could keep up with. Reading the code, building it and
forking it are all welcome under the [licence](LICENSE).

What helps most is an issue:

- a **bug report** with steps and versions,
- a **feature request** that says what you were trying to do,
- an **adapter request** for an agent Tori does not support yet.

A question, or an idea that is not a request yet, goes in
[Discussions](https://github.com/gettori/tori/discussions). Everyone taking part
is asked to follow the [code of conduct](CODE_OF_CONDUCT.md).

If you have already written the fix, say so in the issue and link your fork or
paste the diff. That is useful as a description of the problem even when the
change that lands is a different one.

## Adding an agent is not a code change

If you want Tori to drive an agent it does not know about, **you do not need to
fork it or change any code.** Agents are data: a `schema_version = 1` TOML
file dropped into `~/.config/tori/agents/` describes how to launch the agent,
where its session transcripts live, how to recognize a live process, and which
built-in parser reads its transcripts.

[**ADAPTERS.md**](docs/ADAPTERS.md) is the reference: the full schema, the closed set
of parser kinds, a from-scratch worked example, and how to whole-replace a
bundled adapter. The schema is stable at v1, so a file you write today keeps
working.

Two things worth knowing before you start:

- A parser `kind` must be one of the implemented ones. If your agent's
  transcript format does not match any of them, that part *is* a code change,
  and an issue describing the format is the right first step.
- `verified_against` means *empirically captured against this CLI version*.
  Leave it out rather than guessing; a wrong value makes Tori's drift warning
  meaningless.

If your adapter works and covers an agent others use, open an adapter request
with the TOML attached and it can join the bundled set.

## Building from source

### Prerequisites

- **macOS.** Tori is macOS only today, developed and tested on macOS 15.
- **Xcode Command Line Tools**: `xcode-select --install`
- **Rust**, via [rustup](https://rustup.rs). `rust-toolchain.toml` pins the
  version: run `rustup toolchain install` once in the repo to fetch it.
- **Node.js 22** (`.node-version`) and **pnpm** (`corepack enable pnpm`, or see
  [pnpm.io](https://pnpm.io/installation)).
- **cargo-audit** for the audit checks: `cargo install cargo-audit --locked`.

### Run it

```sh
git clone https://github.com/gettori/tori.git
cd tori
pnpm install
pnpm tauri:dev
```

`pnpm tauri:dev` layers `src-tauri/tauri.dev.conf.json` over the main config:
the app is named "Tori Dev", wears an orange stripe and a `dev` chip in the
topbar, and uses its own identifier (`app.gettori.tori.dev`) so it keeps its
own data dir and can run beside the installed build. It runs `pnpm lsp:install`
and `pnpm dap:install` first, which fetch the bundled language servers and the
debug adapter into `src-tauri/resources`. The first Rust build takes a while;
later ones are incremental.

To build a release bundle locally:

```sh
pnpm tauri build
```

### Checks

```sh
scripts/check.sh all   # everything CI runs; run it before opening a PR
```

CI runs the same script, one target per job, so passing it locally is passing
CI. The targets also run alone: `ts` (frozen install, type check for desktop
and mobile, `pnpm test`, both vite builds), `rust` (desktop tests, mobile
check) and `audit` (npm and crate advisories).

`pnpm test` runs `scripts/check-tokens.mjs` before the unit tests. That guard
fails the build on any color literal outside `src/styles/tokens.css` and its
committed allowlist, and on any dark token missing a light counterpart. If you
add a color, add it to the token layer for **both** themes rather than to the
allowlist.

Known flake: `hooks::tests::status_for_maps_known_events` fails intermittently
under the full Rust suite because it writes to the real `~/.config/tori` path.
It is not caused by your change.

## Conventions

- **Colors go through tokens.** See the guard above. Two tiers: `--tori-*`
  primitives that do not follow the theme, and semantic tokens that do.
- **Blocking work does not go in a sync Tauri command.** Commands without
  `async` run on the main thread, so blocking I/O there freezes the window.
- **Match the surrounding style** rather than introducing a new one, and keep
  changes to what the fix needs.

## Reporting things

Use the issue templates: bug reports want the macOS version, the Tori version
(Settings > Advanced shows it), the agent CLI and its version, and what you
expected instead. If Tori closed on its own, Settings > Advanced also has the
crash file, and Report a bug there opens the form with it filled in. Adapter
requests want a link to the agent's CLI and, if you can get
one, a sample session transcript, which is what determines whether an existing
parser kind fits.

## License

Tori is licensed under the [Apache License 2.0](LICENSE). Third-party material
and its licences are listed in [NOTICE](NOTICE). Anything you post in an issue,
a diff included, is offered under the same licence.
