---
summary: Tori opens a server through the system and records the URL; the extension folds only a tab the daemon says Tori opened in 10 s
status: current
updated: 2026-10-21
source: "Browser: open in the browser when the server starts, gettori/tickets#90 (branch `browser-extension`, commits 387dcb1d, c94c925e); `src-tauri/src/ports.rs` (`open_in_browser`), `src-tauri/src/rpc/hub.rs` (`note_opened`, `take_opened`), `src-tauri/src/rpc/server.rs` (`browser_opened`), `extension/src/background.ts` (`collapse`)"
---

# Tori opens the URL, the extension folds the tab

**Tori always opens a server's URL with the system opener, after telling the daemon it did (`browser.opening`). When a new tab with no opener appears on a local port that already has a tab, the extension asks `browser.opened { url }`; on true it focuses the tab used last on that port and closes the new one.** The daemon answers true once per URL, within 10 s of the open.

## Considered Options

- **Push from the daemon to the extension.** Rejected: the host is request and reply only, a new frame shape is a protocol bump gated on the store ([[adr_extension_protocol_range]]), and the MV3 worker sleeps after about 30 s ([[gotcha_mv3_service_worker_drops_the_native_port_when_idle]]), so a push cannot reach it. `tabs.onCreated` wakes it.
- **The extension polls Tori** with `chrome.alarms`. Rejected: 30 s at best.
- **A marker in the URL** (query or fragment) the extension recognises. Rejected: the dev server and the app see it.
- **Collapse any opener-less tab on a port that already has one.** Rejected: session restore and Cmd+Shift+T also create opener-less local tabs, and several tabs on one server is normal. Asking the daemon keys the fold to what Tori itself opened.

## Consequences

- No protocol bump: `browser.opened` is a new method off the method table (beside `browser.refused`), so no agent sees it as a tool, and an older Tori answers method not found, which leaves the tab open.
- Without the extension, or in a browser that is not the default, every open is a new tab, which is the fallback for free.
- The record is keyed on the exact URL, `http://localhost:<port>/` with Chrome's trailing slash, and read from `pendingUrl ?? url`, since a tab another app opened is created with its address pending.
- A restored tab on exactly that root URL within the 10 s can still be folded; accepted.
- The record waits at most 1 s on the daemon, so a stalled daemon never holds the browser back.
- `tori open --browser` opens without a record, so its tabs are never folded.

Related: [[component_browser_extension]], [[component_ports]], [[component_run_command]].
