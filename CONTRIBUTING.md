# Contributing

Thanks for looking. Tori is a small project, so the most useful contributions
are usually the narrow ones: an adapter for an agent it does not support yet, a
bug report with steps, a fix for something that misbehaves on your machine.

## Adding an agent is not a code change

If you want Tori to drive an agent it does not know about, **you do not need to
fork it or open a pull request.** Agents are data: a `schema_version = 1` TOML
file dropped into `~/.config/tori/agents/` describes how to launch the agent,
where its session transcripts live, how to recognize a live process, and which
built-in parser reads its transcripts.

[**ADAPTERS.md**](ADAPTERS.md) is the reference: the full schema, the closed set
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

If your adapter works and covers an agent others use, an issue or PR adding it
to the bundled set is welcome.

## Building from source

### Prerequisites

- **macOS.** Tori is macOS only today, developed and tested on macOS 15.
- **Xcode Command Line Tools**: `xcode-select --install`
- **Rust (stable)**, via [rustup](https://rustup.rs). Tauri v2 needs no extra
  targets for a local dev build; the release workflow adds
  `aarch64-apple-darwin` and `x86_64-apple-darwin` for the universal bundle.
- **Node.js 22** and **pnpm** (`corepack enable pnpm`, or see
  [pnpm.io](https://pnpm.io/installation)).

### Run it

```sh
git clone https://github.com/gettori/tori.git
cd tori
pnpm install
pnpm tauri:dev
```

`pnpm tauri:dev` layers `src-tauri/tauri.dev.conf.json` over the main config:
the app is named "Tori Dev", wears an orange stripe and a `dev` chip in the
topbar, and uses its own identifier (`com.skarif.tori.dev`) so it keeps its
own data dir and can run beside the installed build. It runs `pnpm lsp:install` first, which installs the bundled
TypeScript language server into `src-tauri/resources/lsp`. The first Rust build
takes a while; later ones are incremental.

To build a release bundle locally:

```sh
pnpm tauri build
```

### Checks

```sh
pnpm test          # token-layer guard + vitest
npx tsc --noEmit   # frontend typecheck
cargo test --manifest-path src-tauri/Cargo.toml
```

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
(the app does not display it yet, so take it from the DMG filename or the
release you downloaded), the agent CLI and its version, and what you expected
instead. Adapter requests want a link to the agent's CLI and, if you can get
one, a sample session transcript, which is what determines whether an existing
parser kind fits.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
