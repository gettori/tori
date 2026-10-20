---
summary: an MV3 worker closes its native port about 30s idle, so a live connected flickers; count the browser as seen since mint
status: current
updated: 2026-10-20
source: "Browser: store release and onboarding, gettori/tickets#89 (branch `browser-extension`, commit 49ba065f); `src-tauri/src/rpc/hub.rs` (`browser_seen`, `forget_browser`); `extension/src/background.ts` (`open`)"
---

# An MV3 service worker drops its native port whenever it idles

Don't report a browser extension as connected by checking for a live native messaging connection. Why: a Manifest V3 service worker is shut down after about 30 seconds without events, and its `connectNative` port, and with it the `tori` host process and the daemon connection, goes with it. Settings > Browser polled `hub.browser_connected()` and flipped between Connected and Not connected while the extension was perfectly fine.

Track "has the current credential connected since it was minted" instead: `hub.browser_seen`, set when a browser connection is tagged, cleared by `forget_browser` on mint and revoke. A daemon restart forgets it until the extension next calls, which the welcome page does on first install so a fresh setup reaches Connected without a localhost tab.

Related: [[component_browser_extension]].
