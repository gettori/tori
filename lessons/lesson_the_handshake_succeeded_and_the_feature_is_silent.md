---
summary: three language features passed every fake server test and did nothing real, since a handshake only claims a server can
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/tori, branch `wave-7`); Phase 5 (commit a620384), Phase 6 (506d7e7), Phase 9 (d7a6e3e); issues #65, #68"
---

# Run the real server before believing a language feature works

## What happened

Three times in one wave, a feature passed every test, handshook correctly with a real server, and did nothing. Every test in the suite asks a **fake** server that answers, so none of them could have said so, and in each case the symptom was an empty result rather than an error.

- **`yaml-language-server` ignores pushed settings entirely.** It answers `workspace/didChangeConfiguration` by *pulling* its configuration back with `workspace/configuration`. Unanswered, that pull rejects, `setConfiguration` never runs, and the schema store, which is only built inside the configuration handler, never exists. The server defaults `schemaStore.enable` to true and still validates nothing.
- **`vscode-json-languageserver` reported every comment in Tori's own `settings.json` as an error.** Both settings files are read with json5, so comments are supported; the server sets `comments: 'error'` for every language id but `jsonc`, and `languageIdFor` was extension-only. Introduced by shipping the server, surfaced by being the reason anyone opens that file in Tori.
- **`typescript-language-server` advertises `codeLensProvider` unconditionally and then answers `[]`.** Both of its lens providers check the workspace configuration first, so a preference nobody sent reads as off. The capability said yes; the answer was an empty array.

## Why

A capability handshake is a claim about what a server *can* do, not a claim that it *will*. Between "advertised" and "answers usefully" sit at least three things a unit test cannot see: configuration the server pulls rather than accepts, a wire encoding that arrives differently than it was sent (`vscode-jsonrpc` spreads a `params` array, so a 1281-entry catalog became one association), and a feature the server keeps switched off until told otherwise.

All three failures share a shape: **the honest-looking empty answer**. Zero diagnostics, zero lenses, one association. Nothing logs, nothing throws, and the fake server in the test suite was written to answer, so it answers. This is the same silence [[concept_lsp_capability_contract]] was written about, arriving from the opposite direction: there, Tori fails to ask; here, Tori asks correctly and the server declines quietly.

## What to do next time

**Before marking a language feature done, run it against the actual binary and assert a non-empty result.** Not "it initialized", not "the request went out" — a real count, a real diagnostic, a real completion, written into the phase notes as a number.

**Treat an empty answer from a real server as a bug until proven otherwise.** Zero diagnostics on a file you know is wrong is a finding, not a pass. In all three cases the end-to-end check "succeeded" first and only looked wrong on the second reading.

**When a feature depends on server-side configuration, prove the delivery mechanism rather than assuming the obvious one.** Grep the installed server for where it reads the preference ([[lesson_grep_the_installed_dep_before_wiring_a_binding]] generalises here): the YAML server pulls, tsserver reads `getWorkspacePreferencesForFile` and not `initializationOptions`, and Tori's `initialization_options` reaches no server at all.

## Related

- [[concept_lsp_capability_contract]] — the mirror failure, where Tori is the one that fails to ask
- [[concept_schema_backed_json]] — where two of these three landed
- [[component_code_lens]] — the third, and the one whose whole feature hung on it
- [[lesson_grep_the_installed_dep_before_wiring_a_binding]] — the same habit, applied to a dependency's bindings
- [[gotcha_vscode_jsonrpc_spreads_a_json_rpc_params_array]]
- [[gotcha_the_json_server_errors_on_comments_for_every_language_id_but_jsonc]]
- [[gotcha_typescript_language_server_answers_no_code_lenses_until_a_workspace_configuration_enables_them]]
