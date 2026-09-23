---
summary: macOS caps a unix socket path at 104 bytes in sockaddr_un, so an over-long path fails or truncates silently
status: current
updated: 2026-07-10
source: Askpass credential bridge for backgrounded git (personal/tori, branch code-mirror-6); `src-tauri/src/askpass.rs` (`start`); commit 3fff674
---

# Darwin caps unix socket paths at 104 bytes

A `UnixListener::bind(path)` copies `path` into `sockaddr_un.sun_path`, which is **104 bytes on macOS** (108 on Linux); an over-long path fails to bind (or silently truncates). So the askpass socket lives in a **short** `$TMPDIR`-based dir (`$TMPDIR/tori-akp-<pid>-<seq>/s`), not a deep path, and `start()` **checks the length and returns an `Err`** (fail soft, the caller logs and the app still runs) rather than panicking startup on a pathological `$TMPDIR`. A per-start counter in the dir name keeps concurrent servers (e.g. parallel tests, same pid) off each other's sockets.

## Related

- [[concept_askpass_bridge]] - the first socket kept short for this
- [[component_app_socket]] - checks the same cap for `tori-rpc-<pid>-<seq>/s`
