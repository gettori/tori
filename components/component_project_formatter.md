---
summary: saving runs the project's own Biome or Prettier over stdin, never the file in place, since it is not yet on disk
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/sway, branch `wave-4`); Phase 6; commit cbb4497; `src-tauri/src/format.rs`, `src/panels/Editor/formatOnSave.ts`, `docDiff.ts`"
---

# Project formatter: the repo decides how its files are written

Saving a file runs the formatter **the project already uses** — Biome or Prettier, detected from config, executed from the project's own `node_modules`. A repo with neither is unchanged: the language server's formatting is still what ⇧⌥F reaches. The iron rule is that the editor never imposes a default formatter.

## Detection

- **Walks up from the file, nearest wins, with a floor at the project root.** A monorepo package that formats differently from the repo around it is the case that decides it. The floor is not decoration: without it a file outside the root (a Shared-tree tab) or an empty root walks to `/`, and a stray `~/.prettierrc` reformats a project that never asked.
- **Biome ahead of Prettier in one directory.** A directory holding both configs is a repo that migrated and left the old dotfile behind; the newer tool is the one CI runs.
- **Prettier configs are matched by prefix, not by a list of exact names.** Eight `.prettierrc` extensions and five `prettier.config.*` ones, and the set grows — a spelling an exact list had not caught would read as "this project does not format" rather than as an unrecognised file. `package.json`'s own `prettier` key is checked separately; the *file's* presence means nothing on its own.

## Running

- **Over stdin/stdout, never by pointing a CLI at the file.** What is being formatted on save is by definition not on disk yet. A formatter told to fix `a.ts` in place would format the version the save is about to overwrite, and the write would put the unformatted text straight back.
- **The project's `node_modules/.bin` beats the login PATH.** A repo pins its formatter's version precisely so everyone's output matches; a globally installed Prettier one major behind would reformat the whole file on the first save and put that diff in somebody's pull request.
- **`format_document` never fails as a command.** A missing binary, a syntax error, a wedged formatter: all come back as the original text plus a sentence to show. There is no shape of `FormatResult` that asks the caller to decide whether the text is safe to write, because the failure that matters is half a file on disk. A *configured but uninstalled* formatter says so rather than doing nothing — that is the state a fresh clone is in before `npm install`, and silence there reads as "this project has no formatter".
- Stdin is written on its own thread and the child waited on another, with a `recv_timeout` and a `kill -9` on expiry, so neither a large document nor a wedged process can hold a save open. A 512 KB test proves the pipe cannot deadlock; a `sleep 60` proves the timeout fires.

## The race, which is the interesting half

Formatting is a subprocess. Node starts, the file is parsed, output comes back, and a fast typist puts several characters into the buffer while that happens. Those characters are in no formatter output, so applying the result afterwards **deletes work the user just did, as part of a save they asked for**.

CodeMirror has no document version counter, but `Text` is immutable: the *identity* of `state.doc` is the available handle on "is this still the document I sent?". That is the guard the library's own `formatDocument` has at `index.js:1132-1135`, and an out-of-band CLI path has nothing equivalent unless it is written.

`formatOnSave.ts` is that decision, as a pure function with injected deps (the shape [[concept_lsp_workspace_bridge|`lspRename.ts`]] established), because every branch in it is about somebody's unsaved keystrokes and none of them should need CodeMirror standing up to test. It never throws and never returns half a file: every refusal ends in the text the caller already had.

**`current(path)` takes the path, not "whatever is on screen."** That is a fixed data-loss bug, not a style point: a 300 ms subprocess is exactly long enough for an ordinary tab click, and answering with the buffer the user switched *to* wrote `b.ts`'s entire contents into `a.ts`. Leaving the screen is not closing the tab, so the save still lands — it just lands on the right file.

The formatted text goes in as a **minimal change, not a whole-document replace**: a full replace maps the caret to the end of the change, so saving would move the cursor on every save. This is `diffChanges` in `docDiff.ts`, shared with the workspace bridge for a different reason ([[gotcha_a_whole_document_replace_collapses_every_position_map]]).

## Settings, and one command

`formatOnSave` **defaults off**. The project's config decides *which* formatter runs, but a repo carrying a `.prettierrc` is not necessarily a repo that is currently formatted, and the first save in one would rewrite a file the user never touched. Opting in is cheap; opting out after the fact is a revert. Global default in `editorDefaults`, per-project override in `editor[path]`, where `null` (no answer) is deliberately distinct from `false` (this project said no) — see [[component_settings_store]].

**One format command, not two.** `lsp-format` (⇧⌥F) tries the project's formatter and falls back to the language server only where there is none. Two palette entries both called "Format document" would make the user answer "with what?", which is the project's question, not theirs. `SaveText` carries the detected formatter so the fallback needs no second round trip.

## Not covered by tests

Biome's and Prettier's own output. Neither is a dependency of this repo, so the plumbing is driven through stub formatters written to a temp dir — the same trick as the `/bin/cat` echo server in [[component_lsp_host]].

## Related

- [[component_cm6_editor]] — the save path this hooks into.
- [[component_settings_store]] — where the toggle and the per-project override live.
- [[concept_fs_change_pipeline]] — `isSelfWrite`, which every write routes through.
- [[gotcha_bare_npx_prettier_reformats_this_repo_wholesale]] — the cautionary tale behind "never impose a default formatter".
