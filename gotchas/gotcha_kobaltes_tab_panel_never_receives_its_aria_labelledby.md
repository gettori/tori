---
summary: Tabs.Content reads aria-labelledby from a non reactive Map filled after render, so it never gets labelled, supply both
status: current
updated: 2026-08-16
source: "plan \"Tab and OverflowTabBar onto Kobalte Tabs\" (personal/tori, branch `111-tab-and-overflow-tab-bar`, issue #111); `src/panels/Settings/Settings.tsx`, `node_modules/@kobalte/core/dist/chunk/7DPKSDZL.js`"
---

# Kobalte's tab panel never receives its `aria-labelledby`

Do NOT trust `Tabs.Content` to label itself. It reads `aria-labelledby` from `context.triggerIdsMap()`, a **plain `Map`** that each `Tabs.Trigger` fills from a `createEffect`. The panel's JSX getter runs during render, before any effect has fired, so it reads `undefined`; and a `Map` is not reactive, so the getter never re-runs once the map is filled. The attribute is simply absent, forever, and nothing warns. `aria-controls` on the trigger looks like it works only because it is wrapped in a memo over the selection, which changes after mount and forces a re-read. Supply both ends yourself (`id` on the trigger, `id` + `aria-labelledby` on the content) and the ordering stops mattering. This is what kept Settings' `tabId`/`paneId` helpers alive when the migration was meant to delete them.
