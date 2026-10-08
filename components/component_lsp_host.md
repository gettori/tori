---
summary: a language server is a config file, sessions key by server id and root so a package never borrows a sibling compiler
status: current
updated: 2026-10-09
source: "CM6 editor migration plan; Phase 11; commit 15d039e, rewritten by Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phases 1-2, 5, 7; commits 7bb34d2, 0802a17, cbc5b0a, 075b5d7, extended by Editor wave 7: language intelligence depth (branch `wave-7`); Phases 1, 5, 6, 9; commits c4750d7, a620384, 506d7e7, d7a6e3e; Support Astro plan (branch `phase-1-block-1`, gettori/tickets#70); commit 7d4a6ee2"
---

# LSP host: a registry of language servers, one session per root

**Location:** `src-tauri/src/lsp.rs`, `src-tauri/src/lsp/registry.rs`, `src-tauri/src/lsp/schemastore.rs`, `src-tauri/lsp/*.toml`, `src/utils/lspServers.ts`, `src/panels/Editor/lspClient.ts`, `serverRequests.ts`, `LSP-SERVERS.md`

A language server is a **config file, not a branch of code**. Bundled TOML under `src-tauri/lsp/` is merged with `~/.config/tori/lsp/*.toml` overrides into a `OnceLock`, mirroring [[component_agent_adapter_registry]]. Tori ships four — bundled `typescript-language-server`, `vscode-json-languageserver` and `yaml-language-server`, plus rust-analyzer resolved from the login PATH — which is what proves the shape is real; Python and Go become config files with no code change. `LSP-SERVERS.md` documents the schema and a doc test fails if a field is added without documenting it, the way `ADAPTERS.md` does. Governed by [[adr_cm6_editor]].

The schema uses a **`[languages]` map** (extension to LSP language id), not parallel lists: the frontend needs the language id *for a given file* to send `didOpen`, and two lists would have to be zipped at every call site and could disagree. Unknown *fields* warn and are ignored so a config written for a newer Tori still loads; unknown *enum kinds* (`launch.kind = "docker"`) are a hard error. Missing required fields are reported all at once.

## Sessions are keyed by `(server_id, root)`

Not by server id. A monorepo's `packages/a` and `packages/b` each resolve their own `tsconfig.json`, and keying by id alone lets the second borrow the first's compiler config — silently, and with wrong answers rather than no answers.

**`lsp_start` returns the handle it resolved, and the frontend addresses that.** Root resolution therefore exists in exactly one language. `root_for` walks up to the nearest `root_markers` hit and falls back to the project root; it is deliberately *not* exposed as a command, because exposing it invites a second implementation in TypeScript where a disagreement would pair a client with the wrong server. A grep for `tsconfig.json` in `src/` finds only a file-icon map.

- **Longest root wins** when a file sits under two live sessions (`lspPluginFor`, `lspTargetFor`). This subsumes the older `isUnderPath(path, currentRoot)` guard, so Docs-tree and `.shared/` files still get no plugin.
- **Started lazily, on the first file of a language under a root**, not at project open. A project with a `Cargo.toml` costs nothing until a `.rs` file is actually opened.
- **`ensureLspFor` asks the backend on every first-open of a file, with no "already covered" short-circuit.** The obvious optimisation is wrong: once a repo-root server is up, a package with its own `tsconfig.json` would never get one, reintroducing exactly the failure `(id, root)` keying exists to prevent. Only the backend knows a file's root, so it is asked every time and the *answer* is deduplicated.
- **Starts are serialized per server id.** Two files of one language opened at once would otherwise both call `lsp_start` before either registered a session — and the backend reuses a running session and returns the handle **without wiring the new call's Channel**, so the second client would sit connected to a transport no frame ever reaches. See [[gotcha_lsp_start_reuses_a_running_session_and_returns_without_wiring_the_new_channel]].
- **A `generation` counter, captured before the first await**, covers a project switch that happens while a start is queued or in flight. The in-flight case stops its server by handle rather than dropping it, since `lsp_stop_all` has already swept past.

## Capabilities and the transport

The library advertises no symbol and no semantic-token support at all, so Tori adds its own blocks and answers four server-initiated requests. That surface has its own rules — see [[concept_lsp_capability_contract]] for what may be declared and [[concept_server_request_router]] for the seam that answers. `LspTarget` is the narrow view a caller gets: root, `ready`, `supports`, `capability`, `sync`, `request`. A caller holding the `LSPClient` could reconfigure or disconnect the session.

Each session gets its own frame-reader thread and `Channel<String>`; `lsp_send` re-frames outgoing JSON onto stdin. The channel handler routes inbound frames through `serverRequests.ts` before fanning out, because `receiveMessage` would answer every server-initiated request `-32601`.

## An optional `[settings]` table, and what it turned out to be for (wave 7)

A server config may carry `[settings]`, sent as `workspace/didChangeConfiguration` once `initialize` has been answered, and documented **last** in `LSP-SERVERS.md`'s schema block so no top-level key follows it (see [[gotcha_a_toml_key_after_a_table_header_belongs_to_that_table]] — the documented block was already wrong, and a test now parses it verbatim). Both new uses are cases where a server does nothing at all without it:

- **`yaml.toml`** turns on the server's own SchemaStore support. It reads the values by *pulling* them back with `workspace/configuration` rather than from the push, so the table is delivered both ways.
- **`typescript.toml`** enables `referencesCodeLens` and `implementationsCodeLens`. Without it `textDocument/codeLens` answers `[]` forever while `codeLensProvider` is advertised.

Both new servers use `root_markers = [".git"]` with `package.json` **omitted rather than reordered**: `root_for` returns the first ancestor holding *any* marker, so order changes nothing while `package.json` is in the list, and neither server has per-package configuration to be right about. A paired test asserts one root for three packages, and that adding `package.json` back splits them.

`lsp_schema_dir` resolves the bundled `resources/schemas` directory through the same `bundled_entry` fallback the servers use, so Tori's own settings schemas work in a packaged build and under `cargo run` alike. `schemastore.rs` owns the catalog fetch and cache — see [[concept_schema_backed_json]]. A Rust test now parses every `#[tauri::command]` out of `lsp.rs` and asserts each appears in `lib.rs`'s `generate_handler!`, because forgetting that line compiles, the invoke rejects, and the caller's fallback makes it indistinguishable from a build that ships nothing.

Per-server `request_timeout_ms` replaces the library's 3 s default (20 s TS, 90 s rust-analyzer). The default covers `initialize` too, so 3 s would take the whole client down on a cold cargo project rather than failing one request.

## Lifecycle discipline

- **Two mutation points only** (`addSession`, `dropAllSessions`), so no transition can skip the `onLspChange` notify. The registry landing fires it too, which is what makes a file opened during startup attach without being reopened. An empty registry is a correct state, not a degraded one: nothing is claimed, so nothing gets a plugin.
- **A `Compartment` per buffer**, not one shared: `client.plugin(uri)` is file-addressed. `reattachLsp` reconfigures the shown buffer through `view.dispatch` and every background one through `state.update` — a background buffer is in no view, so `dispatch` cannot reach it. That distinction is pure and lives in `lspReattach.ts`.
- **Stopping means killing *and* reaping.** `kill()` only delivers the signal; the process stays a zombie. `stop()` does both, and `lsp_stop`/`lsp_stop_all` route through it. Latent in the original single-server host, and it matters more now that a session-per-root registry stops many more servers.
- **`install_session` re-checks under the second lock.** Two concurrent starts for one handle both spawned, and the loser kept running unreachable — for rust-analyzer, an orphan indexing at full tilt until logout. The lock is still deliberately *not* held across the spawn, because `command_for` can resolve a binary through a login shell.

## Health cards

`lsp_health` renders one card per registered server in Settings, reusing [[component_agent_health_cards]]'s shape and its neutral-unknown rule. `check` takes `bundled_entry_missing` explicitly: probing `launch.program()` reports `node`, so in a dev tree without `pnpm lsp:install` the card said "found" while every start failed. Neither bundled config declares `verified_against` — the resource pins ranges, not versions, and rust-analyzer's version is whatever the user has, so any value would be a guess.

## Testing without a language server

The suite needs neither node nor rust-analyzer: the echo server is **`/bin/cat`**, which copies stdin to stdout byte for byte, so a written frame comes back identical. Nothing to install, commit, or keep in sync. The same trick reappears as stub shell scripts in [[component_project_formatter]].

## The shape a debug adapter host mirrors, and where it could not

Wave 8 built [[component_dap_host]] from this page deliberately: the same registry-of-configs idea, the same `(id, root)` thinking behind its own `root_for`, the same install-under-second-lock, the same kill-and-reap, the same `Content-Length` framing, the same command-registration test. Three things did **not** carry over, and each is a hazard for anyone reading one host as a template for the other:

- **A DAP adapter listens, it does not speak stdio.** `dapDebugServer.js` calls `net.createServer().listen()` and the client dials in, so the stdin/stdout pair here has no counterpart there.
- **One adapter process serves many connections.** Debugging is inherently multi-session ([[concept_dap_session_tree]]), so `dap_connect` exists beside `dap_start`; there is no LSP equivalent.
- **Termination is target-kind-dependent.** An attached debuggee is a process Tori never started and must never be killed.

## `initialization_options` comes back from `lsp_start`, resolved for the root

`lsp_start` answers `LspStarted { handle, initializationOptions }`, and both client kinds send *that*, never `server.initialization_options` from the registry snapshot. The snapshot is per server; the options are per start, because a placeholder in them depends on the root.

- **One placeholder, `${tsdk}`.** Any string inside `[initialization_options]` may carry it. `resolve_tsdk` fills it with the project's `node_modules/typescript/lib` (walking from the root up to the project), else Tori's bundled `resources/lsp/node_modules/typescript/lib`, else fails the start naming `pnpm lsp:install`. A config without it passes through untouched and resolves nothing. See [[gotcha_volar_servers_refuse_initialize_without_a_tsdk]] for why it exists.
- **The walk is skipped unless `root.starts_with(project)`.** `format::project_bin` stops on bare equality instead, which a symlink disagreement turns into a climb toward `$HOME`; this walk does not inherit that.
- **Resolved after `command_for` and the trust gate**, so an uninstalled server still fails as `not_installed` and the editor still offers Install.
- **The path used is written into the session's log tail** (`LspState::note`, capped like the stderr it sits beside), the log "Show log" opens on a crash.

Until `@codemirror/lsp-client` 6.3.0 this field reached no primary server at all: 6.2.5 had no config for it, so it was parsed, typed and documented and arrived nowhere (found in wave 7 Phase 5). The fix was the upgrade, not a rewrite of the `initialize` frame at the transport.

## Does NOT

Bundle a Node runtime (system `node` via `env::augmented_path`), support languages beyond the shipped configs without a config file, or answer server-initiated requests beyond the four routed ones.

**Known caveat, unresolved across all eight phases:** `root_for` compares non-canonicalised paths, so a project path that disagrees on symlinks (`/tmp` vs `/private/tmp`) falls back to the project root instead of walking. Latent only — in production both paths come from the same file-tree source. `format.rs`'s ancestry check inherits it.

## Related

- [[concept_lsp_workspace_bridge]] — how these sessions reach files that are not on screen.
- [[concept_lsp_capability_contract]] · [[concept_semantic_token_layering]] · [[component_editor_symbols]] — what is asked of them.
- [[concept_server_request_router]] — what they ask back, and how it is answered.
- [[concept_schema_backed_json]] — the two servers wave 7 added and what they needed to be useful.
- [[component_agent_adapter_registry]] — the registry pattern mirrored here.
- [[component_cm6_editor]] — the per-buffer consumer.
- [[component_code_actions]] · [[component_call_hierarchy]] · [[component_code_lens]] · [[component_peek_view]] — the wave-7 surfaces built on `LspTarget`.
- [[lesson_a_hoisted_export_can_outrun_its_own_module]] — `lspCodeActions` and `lspCodeLens` import back into `lspClient`, and a project switch reaching it through `import(...)` outran its own body; the warm-root LRU now lives in the cycle-free `lspWarmRoots.ts` and the switch calls that directly (#159).
- [[lesson_the_handshake_succeeded_and_the_feature_is_silent]] — why a health card saying "found" is not the end of the check.
- [[gotcha_gui_launched_processes_inherit_a_minimal_path]] · [[gotcha_lsp_client_assumes_one_editor_view_per_file]]
- [[gotcha_volar_servers_refuse_initialize_without_a_tsdk]] , what the `${tsdk}` placeholder exists for.
- [[component_dap_host]] , the sibling host built from this shape, and the three places it diverges.
