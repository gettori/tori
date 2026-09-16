---
summary: vscode-js-debug 404s on npm and ships as a github tarball whose server listens on a port, unlike LSP stdio
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP), Phases 1-2 (personal/sway, branch `wave-8`); `src-tauri/src/dap.rs:288`, `scripts/install-dap.mjs`; commit cdb4cd2"
---

# vscode-js-debug is not on npm and listens rather than speaking stdio

Do NOT plan a DAP host around `npm i vscode-js-debug` or around an adapter's stdin/stdout. The package 404s on npm; it ships as a GitHub release tarball (`js-debug-dap-v1.117.0.tar.gz`, 1.2 MB / 70 files), and its entry `dapDebugServer.js [port|socket path] [host]` calls `net.createServer().listen()` and waits for a client to dial in. Only the `Content-Length` framing carries over from an LSP host. Connecting needs retry-and-backoff: an immediate single connect failed **100%** of the time, and success took **6 attempts / ~106 ms** across five runs. Why: every part of the spawn-and-talk shape is different, so a plan written from the LSP host is wrong about the transport, the process count and the acquisition all at once.
