# Contributing

Thanks for looking. Tori is open source, and for now its code is not open to
contributions: **pull requests from outside the project are turned off.** One
person maintains it, it is not at 1.0 yet, and the design still moves faster
than a review queue could keep up with. Reading the code, building it and
forking it are all welcome under the [licence](LICENSE).

What helps most is an issue:

- a **bug report** with steps and versions,
- a **feature request** that says what you were trying to do,
- a **pack request** for an agent whose transcripts no parser Tori has can
  read.

A question, or an idea that is not a request yet, goes in
[Discussions](https://github.com/gettori/tori/discussions). Everyone taking part
is asked to follow the [code of conduct](CODE_OF_CONDUCT.md).

If you have already written the fix, say so in the issue and link your fork or
paste the diff. That is useful as a description of the problem even when the
change that lands is a different one.

## Contribute a pack

Every language server, linter, debugger, formatter, theme and agent Tori knows
about is a pack: one file in [gettori/packs](https://github.com/gettori/packs),
and that repo takes pull requests. Its README says what a pack needs and how
to validate one before you open the PR. Once merged, a pack is listed at
[gettori.app/packs](https://gettori.app/packs) and in the "Add a ..." button
of its Settings pane, without waiting for a Tori release.

## Adding a language, debugger, formatter, theme or agent is a pack

None of these needs a fork or a code change. A file dropped into
`~/.config/tori/packs/<kind>/`, where the kind is `lsp`, `dap`, `formatters`,
`themes` or `agents`, loads at the next start (a theme loads at once), whether
or not it is in the catalog. Its kind's Settings pane lists it, or lists why it
did not load under "Needs fixing". The schemas:
[LSP-SERVERS.md](docs/LSP-SERVERS.md), [DEBUGGERS.md](docs/DEBUGGERS.md),
[FORMATTERS.md](docs/FORMATTERS.md), [THEMES.md](docs/THEMES.md) and
[ADAPTERS.md](docs/ADAPTERS.md).

Two things worth knowing before you write an agent:

- A parser `kind` must be one of the implemented ones. If your agent's
  transcript format does not match any of them, that part *is* a code change,
  and a pack request describing the format is the right first step. An agent
  that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
  needs no parser.
- `verified_against` means *empirically captured against this CLI version*.
  Leave it out rather than guessing; a wrong value makes Tori's drift warning
  meaningless.

## Sign-off (DCO)

When the maintainer does take a pull request from outside, every commit on it
carries a `Signed-off-by:` trailer whose email matches the commit author's.
`git commit -s` adds it. It certifies the
[Developer Certificate of Origin](https://developercertificate.org): that you
wrote the change, or have the right to submit it under the project's licence.
There is no CLA and nothing else to sign.

CI checks it. The `dco` job in `.github/workflows/dco.yml` walks every
non-merge commit of the pull request and fails naming each one whose trailers
have no `Signed-off-by` for the author's email. Two things trip it that are
not obvious:

- If your employer owns what you write, get their permission before the first
  commit. Clause (a) of the certificate, that you have the right to submit the
  change, is only true with it.
- A suggestion applied through GitHub's web UI lands as a commit with no
  trailer. Apply review suggestions locally and sign them off instead.

Forgot one? `git commit --amend -s` fixes the last commit, and
`git rebase --signoff <base>` fixes a branch; then force-push.

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
CI. The sign-off check is a workflow of its own, `dco.yml` (see
[Sign-off](#sign-off-dco)), with nothing to run locally. The targets also run
alone: `ts` (frozen install, type check for desktop and mobile, `pnpm test`,
both vite builds), `rust` (desktop tests, mobile check) and `audit` (npm and
crate advisories).

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
crash file, and Report a bug there opens the form with it filled in. Pack
requests want a link to the agent's CLI and, if you can get one, a sample
session transcript, which is what determines whether an existing parser kind
fits.

## License

Tori is licensed under the [Apache License 2.0](LICENSE). Third-party material
and its licences are listed in [NOTICE](NOTICE). Anything you post in an issue,
a diff included, is offered under the same licence.
