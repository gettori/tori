# Chrome Web Store listing

The text pasted into the Web Store developer dashboard for the Tori item.
Keep it in step with `manifests/base.json`: every permission there has a
justification below, and nothing below names a permission the manifest does
not ask for.

## Name

Tori

## Short description

Comment on your localhost app from the browser and send it to the agent working in that Tori worktree.

## Long description

Tori is a Mac app for supervising coding agents, each working in its own git worktree. This extension connects your browser to the Tori app on the same Mac.

It needs the Tori desktop app on macOS, version 26.1020.0 or later. Without it the extension shows that Tori is not set up and does nothing else.

On a localhost tab served by one of your worktrees:

- The toolbar icon shows a dot in the worktree's space colour, and hovering it names the branch and the project.
- Tabs can be grouped by branch.
- Press the pick shortcut (Ctrl+Shift+C on a Mac) to pick elements or select text and write a comment on each.
- Send the picks to a chat running in that worktree, open them as a new chat draft in Tori, or copy them as Markdown.
- The toolbar icon counts the page's own errors: uncaught errors, build errors and failed requests to its own server. The tray lists them, and you choose which ones to send.
- A Tori panel in DevTools lists the same errors with the failed requests' bodies, and sends the ones you pick.

Each pick carries what an agent needs to find the code: the element's HTML, text, selector and computed styles, the component chain, props and source file on React, Vue and Svelte pages, the CSS rules that style it with their files and lines, and optionally screenshots and the page's console errors and failed requests.

Nothing leaves your browser except to the Tori app on your own Mac. The extension talks to no server, ours or anyone else's, and collects nothing.

## Category

Developer Tools

## Single purpose

Connect localhost tabs to the Tori desktop app on the same computer, so a developer can see which Tori worktree serves a tab and send comments on its page to that worktree's coding agent.

## Permission justifications

- `nativeMessaging`: the only channel the extension uses. It talks to the Tori app on the same Mac through its native messaging host, installed from Tori > Settings > Browser.
- `tabs`: reads each tab's URL to find the ones on localhost, and their port, so it can ask Tori which worktree serves them.
- `tabGroups`: groups localhost tabs by the branch that serves them. The user can switch this off in the options.
- `storage`: keeps the options (tab grouping, screenshots, console and network), and the picks waiting to be sent from a tab.
- `activeTab`: takes a screenshot of the tab the user is picking on, after they press the shortcut or click the toolbar icon.
- `scripting`: injects the picker into a localhost tab when the user starts picking, and the script that records the page's console errors and failed requests when that option is on.
- Host permission `*://localhost/*` and `*://127.0.0.1/*`: the extension only works on dev servers on this computer. It reads no other site.

## Data use

- Collected by the developer: nothing. There is no server and no analytics.
- Website content: on localhost tabs only. Their address goes to the Tori app on the same computer to find the worktree, and when the user picks an element or selects text and sends it, the HTML, text, styles, screenshots and page log of that pick go there too, over native messaging, and nowhere else. A failed request's body goes there only when the user opens it in the Tori DevTools panel and sends it. Other tabs' addresses are read only to tell them apart and never leave the browser.
- Sold or transferred to third parties: no.
- Used for anything but the single purpose: no.
- Used for creditworthiness or lending: no.

Certify all three disclosures in the dashboard: no sale, no use beyond the single purpose, no creditworthiness use.

## Privacy policy

https://gettori.app/privacy-policy

## Test instructions (for the reviewer)

The dashboard field takes 500 characters at most; paste the block as is.

```text
Needs the Tori Mac app 26.1020.0 or later.
1. Install Tori from gettori.app and open it.
2. Add a web project and start its dev server from Tori.
3. In Tori: Settings > Browser > Install.
4. Add this extension. The welcome page says Tori is running and set up.
5. Open the dev server's localhost tab. The icon shows a dot; hovering names the branch.
6. Press Ctrl+Shift+C, click an element, comment, then Copy as Markdown or Send.
Without Tori running, tabs show "Tori is not running".
```

## Screenshots (1280x800)

In `images/`. The extension UI is the real build, rendered with the browser APIs stubbed, inside a drawn browser frame on a demo localhost app (acme), set on the site's gradient with a headline and an orange callout on the Tori part. Upload five; the order below is the store order.

1. `1-worktree.png`: two branches' tab groups, the toolbar icon's dot, and its tooltip naming branch and project.
2. `2-pick.png`: picking an element, with its outline and the comment box open.
3. `3-tray.png`: the tray with three comments marked on the page, the page log line, and Send.
4. `4-sent.png`: the tray after sending to a live chat, with Show in Tori.
5. `6-options.png`: the options page. `5-welcome.png` (the first run page) is the alternative.

## Small promo tile (440x280)

`images/promo-440x280.png`: the Tori mark and "Comment on localhost, send it to your agent." on the site's poster gradient.
