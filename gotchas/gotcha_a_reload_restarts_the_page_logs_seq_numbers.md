---
summary: page log seqs restart at 1 on every load, so state keyed by seq lands on the wrong entry after a reload; key it by performance.timeOrigin too
status: current
updated: 2026-10-21
source: "Browser: page errors in the extension, gettori/tickets#91 (branch `browser-extension`, commit bbf66e60); `extension/src/pagelog.ts`, `extension/src/panel/Panel.tsx` (`page`)"
---

# A reload restarts the page log's seq numbers

Each document gets a fresh `Logbook`, so seq 3 after a reload is a different entry from seq 3 before it. Anything outside the page that remembers entries by seq, such as the panel's unchecked and opened rows, silently moves onto a new entry.

Clearing on `chrome.devtools.network.onNavigated` is not enough, because it cannot be trusted to tell a reload from a route change inside the app. Clearing there would also throw the person's choices away on every route change.

The page log's `entries` message carries `page: performance.timeOrigin`, which is unique per document and stays the same across pushState. The panel clears its choices when `page` changes. The tray needs no guard, since it is re-injected with each load.

Related: [[component_browser_extension]].
