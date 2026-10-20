---
summary: MV3 extension that reaches the daemon through tori as a native host; per tab worktree, picks, store build, welcome page
status: current
updated: 2026-10-20
source: "Browser: store release and onboarding, gettori/tickets#89 (branch `browser-extension`, commits 24465fe8, 49ba065f, 5fd3c397, 800655f7, e22ab1de, 46651e5a); earlier slices on the same branch from 05e0bd4f; `extension/`, `src-tauri/src/browser_host.rs`, `src-tauri/src/rpc/browsers.rs`, `src-tauri/src/rpc/hub.rs`; gettori/web#8"
---

# Browser extension (native host, picks, store build)

**Location:** `extension/` (MV3, Solid, built by the root `vp`), `src-tauri/src/browser_host.rs` (the native host), `src-tauri/src/rpc/browsers.rs` (credential, host manifests, status), Settings > Browser (`BrowserPane.tsx`), `extension/store/` (listing text and images), `.github/scripts/extension-*.sh`

A Chrome extension (Edge, Brave and Arc install it from the Chrome Web Store) that tells which worktree a `localhost` tab is serving and lets you pick elements on it and send comments to a chat in that worktree. It has no network of its own: everything goes through native messaging to `tori`, which relays to the daemon as the Browser caller.

## Responsibilities

- **The host is `tori` itself.** Chrome starts `tori chrome-extension://<id>/`; `browser_host::run` reads length-prefixed JSON frames and relays each to the daemon with the tab's worktree as a tag. The token comes from `browser.json`, minted by Settings > Browser > Install, which also writes the host manifest into every found browser's `NativeMessagingHosts`, allowing only `EXTENSION_ID`.
- **One extension id everywhere.** `EXTENSION_ID` in `browsers.rs` is the store item's id; the `key` in `manifests/chrome.json` pins unpacked builds to it, the host manifest allows only it, `browser_status.store` builds the store URL from it, and `extension-upload.sh` reads it to know where to upload. A second store item would get a new id and break all four.
- **Protocol range.** Every frame carries `protocol`; the host refuses outside `MIN_PROTOCOL..=PROTOCOL` with "update the Tori extension" or "update Tori", and reports the side to the daemon (`browser.refused`, off the method table) so Settings shows it. See [[adr_extension_protocol_range]].
- **Connected means seen since mint.** `hub.browser_seen` is set when a browser connection is tagged and cleared by `forget_browser` from `revoke_at` (so mint too); a daemon restart forgets it. The live check flickered, see [[gotcha_mv3_service_worker_drops_the_native_port_when_idle]].
- **First run.** `onInstalled` with reason install opens `welcome.html`, which calls `connection()` on open: that call is what makes Settings turn Connected without a localhost tab. Welcome and options share `src/options/rows.tsx`.
- **Store build.** `TORI_TARGET=store` merges `chrome.json`, drops `key`, refuses development mode. `extension-zip.sh` refuses a zip with a `key`, a version other than `package.json` minus the tag, or the `tori_dev` host.
- **Permissions are exactly six** (`nativeMessaging`, `tabs`, `tabGroups`, `storage`, `activeTab`, `scripting`) plus `localhost` and `127.0.0.1`. The optional `debugger`, `webRequest` and `<all_urls>` sat unused from the first slice and were removed before the first submission; add one back only with the code that requests it.

## What leaves the browser

Only native messaging to the Tori on the same Mac. `fetch` reads a screenshot back from a `data:` URL; `pagelog.ts` wraps the page's own fetch and XHR to record failures and sends nothing itself; the extension sees every tab's address but sends only localhost ones. The count was redone for the store listing, the same discipline as [[lesson_privacy_claims_are_assertions_about_the_binary]].

## Store listing and images

`extension/store/listing.md` is the source for every dashboard field (none of them can be set by the API): descriptions, single purpose, a justification per permission, data use, the privacy URL `https://gettori.app/privacy-policy`, and reviewer test steps, which the dashboard caps at 500 characters. `extension/store/images/` holds the screenshots and the promo tile, rendered from the real `dist/` build with the browser APIs stubbed (a forced-open shadow root lets a scene script drive the picker) inside a drawn browser frame on a demo app; the harness was a scratch folder and is not in the repo. Avoid real brands in the demo app: fictional TV brands are still someone's trademark.

## Connections

- [[component_release_pipeline]]: the `extension` job uploads and submits each release.
- [[lesson_store_review_needs_its_legal_pages_live_before_the_merge]]: the ordering the first submission forced.
- [[gotcha_a_testing_oauth_app_mints_refresh_tokens_that_die_in_7_days]]

## Known gaps

- `MIN_TORI` is shown on the welcome and options pages and must move with the extension's own `PROTOCOL`; four copies to keep in step (see `docs/RELEASING.md`).
- `tabs` may be more than the extension needs, since host permissions already expose localhost URLs; not tested.
- `LOCAL_HOSTS` includes `[::1]` but the host permissions do not.
