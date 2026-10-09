# Contributing

Thanks for looking. Tori is open source, and **pull requests are open for the
adapters**: the bundled TOML files in `src-tauri/packs/agents/`, the captures
they were measured against under `dev/fixtures/`, and
[`docs/ADAPTERS.md`](docs/ADAPTERS.md). That is the part of Tori that breaks
most often, since the agent CLIs ship weekly, and the part someone else can own
without touching the core. Repairs to a bundled adapter and new adapters are
both welcome; [Sending an adapter PR](#sending-an-adapter-pr) says what one
needs.

The core is still issue-first. One person maintains it, it is not at 1.0 yet,
and the design still moves faster than a review queue could keep up with.
Reading the code, building it and forking it are all welcome under the
[licence](LICENSE). For anything outside the adapters, what helps most is an
issue:

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

If your adapter works and covers an agent others use, send it as a pull
request and it can join the bundled set. The next section says what that
takes.

## Sending an adapter PR

An adapter PR touches the adapter's TOML, the captures it was measured
against, and the adapter's part of ADAPTERS.md, the three paths named at the
top of this file. Open it with the adapter template: after pushing, add
`?template=adapter.md` to the compare URL GitHub gives you (`&template=` when
the URL already has a `?`) and reload.

- **Measure, do not transcribe.** Run the real CLI, capture what it does with
  one of the probes in `dev/`, and commit the capture. Set `verified_against`
  to the version you measured (`<cli> --version`), and leave it out rather than
  guessing; the [Supported agents](docs/ADAPTERS.md#supported-agents) section
  of ADAPTERS.md says why bundled is not the same as measured.
- **Regenerate the fallback fixture.** The frontend keeps a hand-written mirror
  of the bundled adapters for the first paint, and a test checks that mirror
  against what the backend produces. After editing a TOML, run

  ```sh
  cargo test --manifest-path src-tauri/Cargo.toml emit_bundled_adapters_for_the_typescript_fallback
  pnpm test
  ```

  The first rewrites `dev/fixtures/agents/bundled.json`; commit it. If the
  second fails in `FALLBACK_ADAPTERS agrees with the bundled adapters`, the
  matching edit to `FALLBACK_ADAPTERS` in `src/utils/agents.ts` is part of
  your PR. That is the one core file an adapter repair may touch.
- **A guard test may refuse your claim.** Tests in `src-tauri/src/agents.rs`
  pin what the bundled adapters are allowed to claim:
  `only_a_measured_adapter_claims_account_isolation`,
  `an_unmeasured_bundled_adapter_declares_no_verified_version`,
  `the_bundled_claude_adapter_declares_its_measured_config_files` and
  `a_bundled_adapter_declares_only_the_rungs_tori_can_climb`. If one fails on
  a claim you measured, edit that assertion in the same PR and say in the PR
  who measured it and against which version. If it fails on a claim you did
  not measure, drop the claim.
- **Run the checks** in [Checks](#checks) before opening the PR, and sign off
  every commit, see [Sign-off](#sign-off-dco).

### Wiring a new adapter

A new bundled adapter is its TOML plus the few places in the core that list
the bundled set. These are the only core files a new-adapter PR may touch;
nothing else in the core is open:

- `src-tauri/src/agents.rs`: a `BUILTIN_<ID>` const (`include_str!` of the
  TOML) and its entry in `BUNDLED`
- `src/components/Icon/agentMarks.tsx`: the agent's glyph
- `src/components/Icon/ProviderIcon.tsx`: the agent to provider mapping
- `src/panels/Settings/panes/AgentsPane/AgentsSection.tsx`: the vendor name on
  its card
- `src/utils/agents.ts`: its `FALLBACK_ADAPTERS` entry
- `README.md`: a row in the Supported agents table

Anything beyond that list (a new parser kind, a new chat transport, a new
discovery backend) is a code change: open an adapter request describing the
format first.

## Sign-off (DCO)

Every commit on a pull request from anyone other than the maintainer carries a
`Signed-off-by:` trailer whose email matches the commit author's. `git commit
-s` adds it. It certifies the
[Developer Certificate of Origin](https://developercertificate.org): that you
wrote the change, or have the right to submit it under the project's licence.
There is no CLA and nothing else to sign.

CI checks it. The `dco` job in `.github/workflows/check.yml` walks every
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
CI. The one job outside the script is `dco`, which reads the sign-off on each
commit of a pull request from outside (see [Sign-off](#sign-off-dco)) and has
nothing to run locally. The targets also run alone: `ts` (frozen install, type
check for desktop and mobile, `pnpm test`, both vite builds), `rust` (desktop
tests, mobile check) and `audit` (npm and crate advisories).

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
