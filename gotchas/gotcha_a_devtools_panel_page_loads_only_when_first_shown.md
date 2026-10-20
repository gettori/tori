---
summary: a DevTools panel's page loads only when first shown, so onRequestFinished there misses earlier requests; collect in the devtools_page
status: current
updated: 2026-10-21
source: "Browser: page errors in the extension, gettori/tickets#91 (branch `browser-extension`, commit bbf66e60); `extension/src/devtools.ts`, `extension/src/panel/Panel.tsx` (`attach`)"
---

# A DevTools panel page loads only when first shown

`chrome.devtools.panels.create` gives the panel its own page, but that page loads only the first time the person switches to the panel. A `chrome.devtools.network.onRequestFinished` listener in the panel therefore misses every request made while DevTools sat on Elements or Console. That is usually the request that failed.

The `devtools_page` loads with DevTools itself, so the listener goes there. `devtools.ts` keeps the failed requests and their HAR objects, and hands the panel a `DevToolsNetwork` (`list`, `detail`, `listen`) on `panel.onShown`, which receives the panel's `window`. The panel defines `window.attach` and ignores a second attach of the same object, since `onShown` fires on every switch.

Even so, nothing before DevTools opened is seen. The page log covers that for fetch and XHR.

Related: [[component_browser_extension]].
