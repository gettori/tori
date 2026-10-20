---
summary: page errors live in the extension (icon count, tray list, DevTools panel) and reach a chat only when sent; the Inbox holds chat items only
status: current
updated: 2026-10-21
source: "Browser: page errors in the extension, gettori/tickets#91 (branch `browser-extension`, commits 57d30b0a, 14c2e5e1, bbf66e60); `extension/src/reportable.ts`, `extension/src/background.ts` (`paint`), `extension/src/panel/`"
---

# Page errors stay in the browser

**A page's errors are counted on the extension's toolbar icon and listed in the tray and the Tori DevTools panel, where the person checks the ones to send to a chat. Nothing about them goes into Tori's Inbox, the needs-you log, the digest, a notification or the sidebar.** Tori's Inbox holds chat related items only.

## Considered Options

- **One Inbox row per error on the worktree's latest chat** (the ticket's proposal), with a count and Send to session. Rejected: a project throwing hundreds of errors buries the Inbox, and counting repeats does not help when the texts differ.
- **One counted row per worktree tab** ("localhost:5173: 312 errors"). Rejected for now: it still puts browser news in a chat list.
- **Raising needs-you** (notification, badge, tray). Rejected: a half done change throws constantly.
- **Opening DevTools from the icon.** Not possible: no extension API opens DevTools or picks its panel, so the icon opens the tray and the tray points to the panel.

## Consequences

- You only notice errors while looking at the browser. That is the trade: Tori stays quiet, the browser holds the signal.
- No per project switch. The count rides the extension's existing page log option.
- The DevTools panel is where later DevTools work lands: comment on `$0`, the Elements sidebar pane, and the Recorder export (gettori/tickets#93, #96). A Send on a Console message is not possible, since no API exposes Console messages to an extension. The panel's checkbox list stands in for it.
- Request and response bodies leave only from the panel, for a row the person opened. Any redaction rule written for later features (replay, recordings) has to say the same.

Related: [[component_browser_extension]], [[component_needs_you_log]], [[adr_tori_opens_the_url_the_extension_folds_the_tab]].
