---
summary: test an askpass bridge offline with `git credential fill` and a stub socket server, skip the real network and GUI
status: current
updated: 2026-07-10
source: Askpass credential bridge for backgrounded git (personal/tori, branch code-mirror-6); commit 3fff674
---

# Test the askpass bridge offline with `git credential fill`

## Problem

The acceptance for [[component_askpass]] ("a real fetch pops the dialogs and completes") needs a private remote + network + real credentials + the running GUI - none of which is reproducible in a unit test or CI. But the risky, non-obvious part is not the network: it is whether **git actually spawns our helper per field and wires stdout back into the credential**. That can be proven fully offline.

## Insight

`git credential fill` runs git's credential machinery **without any network**. With no `credential.helper` configured, no TTY, and `GIT_ASKPASS` set, it invokes the helper for `Username` then `Password`, then prints the assembled credential:

```
printf 'protocol=https\nhost=example.com\n\n' \
  | GIT_ASKPASS=<tori-bin> GIT_TERMINAL_PROMPT=0 LC_ALL=C \
    TORI_ASKPASS_SOCK=<sock> TORI_ASKPASS_TOKEN=tok TORI_ASKPASS_OP=op \
    git -c credential.helper= credential fill
```

Stand up a stub Unix-socket server (a few lines of Python) that answers each connection - "myuser" when the prompt contains "Username", a token otherwise - and assert the output is `username=myuser` / `password=<token>`. This exercises the **entire** HTTPS path: git → our re-exec'd helper → socket → scripted answer → git, with the real built binary. The stub stands in for the in-app dialog.

Two supporting techniques from the same build:
- **Helper answer-only check:** run the built binary directly with the marker envs + a stub socket and assert stdout is *exactly* the answer (no newline, no diagnostics) and that no-socket → empty stdout + non-zero exit.
- **Server unit tests without Tauri:** `start(emit)` takes the fan-out as an injected closure, so tests record emissions and call `resolve()` directly to cover concurrency, wrong-token refusal, latched-cancel, and timeout - no `AppHandle` needed.

## What stays manual

Only the GUI acceptance and SSH host-key `accept-new` against a real unknown host need a human + network. The credential plumbing itself is covered offline.

## Related

- [[concept_askpass_bridge]] · [[component_askpass]]
- [[lesson_pure_core_for_global_stores]] - same "inject the impure edge for hermetic tests" instinct.
