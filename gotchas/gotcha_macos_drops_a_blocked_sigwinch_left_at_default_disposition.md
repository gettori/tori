---
summary: on macOS a SIGWINCH blocked at its default disposition is discarded, so sigwait never sees it; use a handler and a pipe
status: current
updated: 2026-10-15
source: gettori/tickets#24 phase tori-attach, commit 244f5b94; src-tauri/src/pty/attach.rs:58
---

# macOS drops a blocked SIGWINCH left at its default disposition

**Blocking SIGWINCH and waiting for it with `sigwait` works on Linux and never fires on macOS.** SIGWINCH's default action is to ignore it, and Darwin discards an ignored signal at generation, blocked or not, so there is nothing pending to wait for.

`tori attach` needs every resize of the outer terminal to send a RESIZE frame. The fix in `pty/attach.rs`: install a real `sigaction` handler, which makes the signal not ignored, and have it write one byte to a self pipe (`WINCH`, `attach.rs:58`); a thread reads the pipe, reads the size with `TIOCGWINSZ`, and sends the frame. The handler does nothing but the async-signal-safe `write`.

## Related

- [[component_tori_cli]]: the `attach` command
- [[component_pty_host]]: the RESIZE frame it sends
