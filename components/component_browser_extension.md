---
summary: MV3 extension that reaches the daemon through tori as a native host; per tab worktree, picks, error count, DevTools panel
status: current
updated: 2026-10-31
source: "Browser: page errors in the extension, gettori/tickets#91 (branch `browser-extension`, commits 57d30b0a, 14c2e5e1, bbf66e60); Browser: store release and onboarding, gettori/tickets#89 (branch `browser-extension`, commits 24465fe8, 49ba065f, 5fd3c397, 800655f7, e22ab1de, 46651e5a); earlier slices on the same branch from 05e0bd4f; `extension/`, `src-tauri/src/browser_host.rs`, `src-tauri/src/rpc/browsers.rs`, `src-tauri/src/rpc/hub.rs`; gettori/web#8"
---

# Browser extension (native host, picks, store build)

**Location:** `extension/` (MV3, Solid, built by the root `vp`; the DevTools panel in `extension/src/panel/`, its collector in `extension/src/devtools.ts`), `src-tauri/src/browser_host.rs` (the native host), `src-tauri/src/rpc/browsers.rs` (credential, host manifests, status), Settings > Browser (`BrowserPane.tsx`), `extension/store/` (listing text and images), `.github/scripts/extension-*.sh`

A Chrome extension (Edge, Brave and Arc install it from the Chrome Web Store) that tells which worktree a `localhost` tab is serving and lets you pick elements on it and send comments to a chat in that worktree. It has no network of its own: everything goes through native messaging to `tori`, which relays to the daemon as the Browser caller.

## Responsibilities

- **The host is `tori` itself.** Chrome starts `tori chrome-extension://<id>/`; `browser_host::run` reads length-prefixed JSON frames and relays each to the daemon with the tab's worktree as a tag. The token comes from `browser.json`, minted by Settings > Browser > Install, which also writes the host manifest into every found browser's `NativeMessagingHosts`, allowing only `EXTENSION_ID`.
- **One extension id everywhere.** `EXTENSION_ID` in `browsers.rs` is the store item's id; the `key` in `manifests/chrome.json` pins unpacked builds to it, the host manifest allows only it, `browser_status.store` builds the store URL from it, and `extension-upload.sh` reads it to know where to upload. A second store item would get a new id and break all four.
- **Protocol range.** Every frame carries `protocol`; the host refuses outside `MIN_PROTOCOL..=PROTOCOL` with "update the Tori extension" or "update Tori", and reports the side to the daemon (`browser.refused`, off the method table) so Settings shows it. See [[adr_extension_protocol_range]].
- **Connected means seen since mint.** `hub.browser_seen` is set when a browser connection is tagged and cleared by `forget_browser` from `revoke_at` (so mint too); a daemon restart forgets it. The live check flickered, see [[gotcha_mv3_service_worker_drops_the_native_port_when_idle]].
- **First run.** `onInstalled` with reason install opens `welcome.html`, which calls `connection()` on open: that call is what makes Settings turn Connected without a localhost tab. Welcome and options share `src/options/rows.tsx`.
- **Store build.** `TORI_TARGET=store` merges `chrome.json`, drops `key`, refuses development mode. `extension-zip.sh` refuses a zip with a `key`, a version other than `package.json` minus the tag, or the `tori_dev` host.
- **Permissions are exactly six** (`nativeMessaging`, `tabs`, `tabGroups`, `storage`, `activeTab`, `scripting`) plus `localhost` and `127.0.0.1`. The optional `debugger`, `webRequest` and `<all_urls>` sat unused from the first slice and were removed before the first submission; add one back only with the code that requests it.

## Opening a server from Tori

Tori opens a port with the system opener after recording the URL in the daemon; `tabs.onCreated` reads `pendingUrl ?? url` on a tab with no opener, asks `browser.opened`, and on true focuses the tab used last on that port and closes the new one. `keeperOf` and `addressOf` in `collapse.ts` hold the testable half; `localPort` moved to `tab.ts`. A new method, not a new frame, so `PROTOCOL` did not move. See [[adr_tori_opens_the_url_the_extension_folds_the_tab]].

## Page errors: the count, the tray list, the DevTools panel

Page errors stay in the browser ([[adr_page_errors_stay_in_the_browser]]).

- **What counts.** `reportable.ts` decides when `pagelog.ts` records an entry, and the result is stored on `LogEntry.reportable`. These count:
  - uncaught errors and rejections whose source (the filename, else the top stack frame) is the page's origin
  - a rejection with no source at all
  - overlays
  - same origin requests answering >= 500 or failing, with aborts excluded

  A bundler scheme such as `webpack-internal:` has a null origin and counts as the page's code. Console output, warnings and 4xx never count.
- **Sent is a set.** `Logbook` marks sent seqs individually (`mark(seqs)`), so a selective send leaves the unchecked entries unsent. The picker's `mark` also carries `seq` (the max) for a page still running the pre-update page log. `tally()` gives `{ count, overflow }`. `overflow` holds reportable entries the book let go of unsent, which no send can clear, so the badge never counts them.
- **The relay.** `pagerelay.ts` is an isolated world script registered and unregistered with the page log. It is wrapped in an IIFE like the page scripts, since it shares a world with the picker. It forwards `tally` posts to the worker. Load order between the two worlds is not fixed, so the page log posts at start and also answers the relay's `tally?`. `pageshow` with `persisted` reposts for a page coming back from the back/forward cache.
- **The badge.** `paint()` in `background.ts` is the only badge writer. It reads two `storage.session` keys, `worktree:<tab>` written by `show()` and `tally:<tab>` written by `tallied()`. They are two keys rather than one record so the two writers never overwrite each other's half, and session storage keeps them while the worker sleeps. The page sets the count, so a reload resets it and a route change cannot.
- **The tray.** The Page log line toggles a checkbox list, with `leftOut` holding the unchecked seqs. `chosenLog()` feeds Send and Copy, while `logged()` still decides whether the tray shows.
- **The panel.** `devtools_page` (`devtools.ts`) creates the Tori panel and collects failed same origin requests from `onRequestFinished` from the moment DevTools opens ([[gotcha_a_devtools_panel_page_loads_only_when_first_shown]]). It hands a `DevToolsNetwork` over through `window.attach` on `onShown`.

  Entries travel through a chain of ports, named by `PANEL_PORT` and `LOG_PORT`: panel -> worker -> `chrome.tabs.connect` to the relay. The relay sends `ask` and streams `entries` and `tally` back, and marks return the same way. A tab with no relay answers `missing` after five retries.

  `rows.ts` merges a page log `request` entry with the DevTools requests carrying the same text that finish at most 2 s before it. A request only DevTools saw is its own row, with `reportable: false`. Bodies go only for a row open at Send, through `withDetail`, capped at 4 KB.

  `entries` carries `page: performance.timeOrigin`, so the panel clears its choices on a reload but not on a route change ([[gotcha_a_reload_restarts_the_page_logs_seq_numbers]]).

  `send.log` goes to `sendLog`, which shares `deliver` with `sendBatch` but leaves the pick batch alone. Panel requests carry `tabId` and are accepted only from a sender without a tab.

## What leaves the browser

Only native messaging to the Tori on the same Mac. `fetch` reads a screenshot back from a `data:` URL; `pagelog.ts` wraps the page's own fetch and XHR to record failures and sends nothing itself; a failed request's bodies leave only from the DevTools panel, for a row the person opened and sent; the extension sees every tab's address but sends only localhost ones. The count was redone for the store listing, the same discipline as [[lesson_privacy_claims_are_assertions_about_the_binary]].

## Store listing and images

`extension/store/listing.md` is the source for every dashboard field (none of them can be set by the API): descriptions, single purpose, a justification per permission, data use, the privacy URL `https://gettori.app/privacy-policy`, and reviewer test steps, which the dashboard caps at 500 characters. `extension/store/images/` holds the screenshots and the promo tile, rendered from the real `dist/` build with the browser APIs stubbed (a forced-open shadow root lets a scene script drive the picker) inside a drawn browser frame on a demo app; the harness was a scratch folder and is not in the repo. Avoid real brands in the demo app: fictional TV brands are still someone's trademark.

## Connections

- [[component_release_pipeline]]: the `extension` job tags `extension-v<version>`, then uploads and submits each release that ships the extension.
- [[lesson_store_review_needs_its_legal_pages_live_before_the_merge]]: the ordering the first submission forced.
- [[gotcha_a_testing_oauth_app_mints_refresh_tokens_that_die_in_7_days]]

## Known gaps

- `MIN_TORI` is shown on the welcome and options pages and must move with the extension's own `PROTOCOL`; four copies to keep in step (see `docs/RELEASING.md`).
- `tabs` may be more than the extension needs, since host permissions already expose localhost URLs; not tested.
- `LOCAL_HOSTS` includes `[::1]` but the host permissions do not.
