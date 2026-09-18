---
summary: SchemaStore plus two bundled schemas attach validation to Tori's own settings, three delivery paths failed silently
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/tori, branch `wave-7`); Phase 5 (commit a620384), Phase 6 (506d7e7); `src-tauri/src/lsp/schemastore.rs`, `src-tauri/lsp/json.toml`, `yaml.toml`, `src-tauri/resources/schemas/*.schema.json`, `src/utils/toriSettingsFiles.ts`, `src/panels/Editor/lspClient.ts:262-323`"
---

# Schema-backed JSON and YAML, including Tori's own settings

A JSON file is only as good as the schema someone remembered to attach, so wave 7 bundled two more servers (`vscode-json-languageserver`, `yaml-language-server`) and made the attaching automatic: SchemaStore's catalog for the world's files, and two schemas this build ships for Tori's own `settings.json`. The interesting part is not the schemas, it is that **three separate delivery mechanisms all fail silently**, and each was found by an end-to-end check that reported nothing wrong in a way that could not be true.

## How it works

**The catalog.** `schemastore.rs` splits three ways so the interesting part needs no network: a pure `associations_from_catalog` (catalog JSON in, `json/schemaAssociations` payload out, unit-tested offline), a `catalog_text` cache whose fetch is a *parameter* (so "a cache hit issues no request" is a test that panics if it does), and a process-wide `OnceLock`. Offline falls back to a stale cache in preference to nothing, and to nothing in preference to an error. Non-`http` schema URLs are refused: the server fetches these itself, and a `file:` URL out of a document nobody here wrote is a request to read a local path of someone else's choosing.

**Tori's own two schemas** are bundled resources, resolved through `bundled_entry` (`lsp_schema_dir`) and handed to the server as `file:` associations alongside the catalog's. There are **two** files because `editor` collides: in `~/.config/tori/settings.json` it is the per-project override *map* keyed by project path, and in `<workspace>/.tori/settings.json` it is the override block itself. One schema covering both would misreport whichever it was not written for. A test holds the two editor blocks **identical by value**, which is what keeps [[concept_workspace_settings_overlay]]'s fourth home one home rather than two.

The associations are built in **TypeScript**, unlike the catalog's, because the rule that says which files they describe is also the rule that decides their language id (below). Rust does only the part that needs it. They are gathered *separately* from the catalog's and prepended, because the offline path returns early on an empty list: folded in after that check they would be dropped exactly when they are the only ones left.

**Globs, not absolute paths**, and that is the server's choice rather than a shortcut: `FilePatternAssociation` prepends `**/` to every pattern it is given (`jsonSchemaService.js:41`), so an absolute path built from the home directory is matched as a suffix anyway.

## Why it's this way

**The YAML server ignores pushed settings entirely.** It answers `workspace/didChangeConfiguration` by *pulling* its configuration back with `workspace/configuration` (`settingsHandlers.js:34`), and `onInitialized` pulls unprompted anyway. Unanswered, the library replies `-32601`, the pull rejects, `setConfiguration` never runs, and `updateConfiguration` (where the schema store is actually built) never runs either. The server defaults `schemaStore.enable` to **true** and still validates nothing, with no error anywhere. So `[settings]` is delivered **both** ways, and the pull is answered through [[concept_server_request_router]].

**`json/schemaAssociations` cannot be sent as a bare array.** The server is built on `vscode-jsonrpc`, which reads a JSON-RPC `params` *array* as a positional argument list and **spreads** it, so a 1281-entry catalog arrives as one association. Sent as `[associations]` it is one positional argument that happens to be a list. Found by an e2e reporting zero diagnostics, then four wire forms tried against the running server.

**Both servers root at `.git` only.** `root_for` returns the first ancestor holding *any* marker, so listing `package.json` would spawn a server per package in a monorepo and buy no correctness, since neither server has per-package configuration to be right about.

**And the language id, not just the schema, is part of the answer.** Tori's own settings files are read with json5 (`settings.rs:2`, `workspace_settings.rs:44`), so comments are supported. The JSON server sets `comments: 'error'` for every language id but `jsonc` (`jsonServer.js:285`). Shipping the server therefore made Tori report every comment in the user's own settings file as an error. `languageIdFor` now returns `jsonc` for those two paths, gated on the server having advertised `jsonc`, and changes only the *id*, never which server is asked.

## Related

- [[concept_server_request_router]] — how the YAML server's configuration pull is answered
- [[concept_workspace_settings_overlay]] — the settings shape these schemas describe, and the fourth home
- [[component_lsp_host]] — the registry, the `[settings]` table, and `bundled_entry`
- [[gotcha_vscode_jsonrpc_spreads_a_json_rpc_params_array]] — the trap that made the catalog arrive as one entry
- [[gotcha_the_json_server_errors_on_comments_for_every_language_id_but_jsonc]] — the one this introduced and then fixed
- [[gotcha_filepatternassociation_prepends_a_leading_glob_to_every_pattern]] — why an absolute path buys nothing
- [[gotcha_a_toml_key_after_a_table_header_belongs_to_that_table]] — why `[settings]` is documented last
