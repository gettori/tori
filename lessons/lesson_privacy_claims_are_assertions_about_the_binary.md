---
summary: a no telemetry README claim was written from memory and was false, so it needs a count of every outbound call site
status: current
updated: 2026-07-28
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/tori, branch `topbar`); Phase 5; `README.md`, `src-tauri/src/model.rs:11`, `docs/INSTALL.md`"
---

# A privacy claim is an assertion about the binary, not a copy decision

## What happened

The v0.1 README needed a no-telemetry statement. The first draft said Tori "makes exactly one network request on its own behalf: a once-a-day check against the GitHub Releases API," and that everything it stores is a plain file under `~/.config/tori/`.

Both sentences were false. `model.rs:11` fetches `https://openrouter.ai/api/v1/models` daily for the context meter's per-model window sizes (invoked from `Toolbar.tsx:48`), and caches the result to `~/Library/Caches/tori/`. `docs/INSTALL.md` carried the same error from an earlier phase, telling users that deleting `~/.config/tori/` "removes every trace."

Nothing was hidden. The update check was simply the network call that came to mind, and the sentence was written from memory of the architecture rather than from the code.

## Why

Every other line in a README is a description, and a description that is 90% right is a good README line. A privacy statement is not a description, it is a **claim about what the binary does**, of the same kind as a licence or a security guarantee. It gets read by people deciding whether to trust the thing, and being wrong about it is a different category of wrong than an out-of-date feature list.

The mechanism that catches it is not care, it is the shape of the check. "Which network calls do I remember?" returns what you already believe. "Which call sites exist?" returns the truth, including the module you forgot was wired up. On the first pass I mis-grepped and briefly concluded `model_context_caps` was dead code; only checking the registration in `lib.rs` and the frontend caller proved it live.

## What to do next time

Write the claim, then verify it **exhaustively rather than illustratively**: enumerate every call site of the outbound primitive and every storage-root helper, and check that the count matches what the prose says. Here that is two `ureq::get` sites in non-test code and one `cache_dir()`, and the README now names exactly those.

Two things fall out of this that are worth keeping:

- **Writing the honest version is a design review.** Enumerating the calls is what surfaced that `model_context_caps` was a sync Tauri command doing unbounded blocking network I/O on the main thread. The privacy paragraph found a UI-freeze bug.
- **Fix every copy of the claim.** The same falsehood was in `INSTALL.md`, because docs get copied from docs. Grep the assertion, not just the file you are editing.

## Re-audited 2026-07-28 (native chat)

Re-run exhaustively when chat became the default surface, since the whole feature is a network-adjacent one. Result: Tori's own outbound HTTP is **still exactly two** `ureq::get` call sites, unchanged. `ureq` remains the only HTTP client in `Cargo.toml`; there is no `fetch`/`XHR`/`WebSocket` anywhere in the frontend; there is no Tauri http or updater plugin; git's `clone`/`fetch`/`push` are user-initiated subprocesses. The chat work added **zero** Tori-originated network paths - the MCP module touches local files only, hook events are in-band, and the harness override spawns a local binary.

The claim still needed editing, though, which is the point of re-auditing rather than re-asserting. It said nothing about the fact that Tori now routinely **starts a process that talks to a vendor**. Added: the agent's traffic is its own, under the user's own subscription, and for MCP, Tori writes the config while Claude - not Tori - connects to whatever it names. A true statement can still mislead by omission once the product around it changes.

## Related

- [[adr_native_chat_surface]] - the change that triggered the re-audit.
- [[component_release_pipeline]] - the update check, the other of the two calls.
- [[gotcha_a_tauri_command_without_async_runs_on_the_main_thread]] - the bug the audit turned up.
- [[lesson_verify_after_the_last_edit]] - the same theme: a claim is only as good as the run behind it.
