---
summary: Tori owns its primitives on native dialog, manual popovers and CSS anchor positioning; one JS layer stack owns dismissal and focus
status: current
updated: 2026-11-21
source: solid-2-stage-a-own-primitives plan, phase webview-spike; gettori/tickets#106; epic gettori/tickets#105
---

# Tori owns its primitives, built on native layers

Supersedes [[adr_headless_primitives]]. Kobalte leaves, along with every other package that ties Tori to a Solid version. Each styled component in `src/components` owns its behaviour. What stays shared in `src/lib` is one layer module (placement, the dismissal stack, focus restore, scroll lock, presence) and the keyboard helpers (roving focus, typeahead).

The trigger was Solid 2.0: 1.x and 2.0 cannot share a bundle, and Kobalte had only an alpha for 2.0 with open bugs in Dialog, Popover, Select, Combobox and Tabs. The old ADR's gate (wait for a stable Kobalte) would have left the move waiting on someone else's release.

## What the spike settled

Measured on 2026-11-21 in a WKWebView on macOS 27.2.1 and in Android System WebView 157, with real key and pointer input.

- Placement is CSS only. `position-area` picks the side and `position-try-fallbacks` flips at the window edge, inside a modal dialog and for a submenu. No JS placement code.
- A caller owned anchor gets a unique `anchor-name` per layer instance. A shared name without `anchor-scope` resolves to the last match in tree order, which is the wrong row in a list.
- A menu at the pointer anchors to a zero size fixed element placed at the pointer.
- Popovers are `popover="manual"`. One capture `keydown` listener pops the top layer and calls `preventDefault`. Intercepting the dialog's `cancel` event is not enough: Chromium's close watcher can deliver it as not cancelable, and the dialog then closes with its popovers still reporting open. The layer treats a native `close` as truth.
- A toast region outside a modal dialog is inert, even when shown after it. The region lives inside the topmost open modal while one is open.

## Alternatives rejected

- Kobalte's 2.0 alpha behind the existing seam. Smallest change, but the switch would ship on an alpha.
- Another primitives library. None had a stable Solid 2 release, so it is the same dependency with a different name.
- `popover="auto"` and native dialog dismissal. Least JS, but jsdom has neither, so the test shim would reimplement the browser and the tests would test the shim.
- JS placement. That is the code anchor positioning replaces. Placement stays in one module so a fallback can be added there if a platform ever needs it.

## Consequences

- Minimum macOS rises from 13.4 to 26. Builds already shipped have no OS check in the updater, so an older Mac takes the update and fails to launch. Accepted.
- Tori now owns Combobox typeahead, the listbox keyboard model and the dismissal stack, the work the old ADR called undifferentiated. The `src/components` APIs, stories and axe tests are the contract that keeps it honest.
- Own primitives keep emitting the state attributes the CSS selects on (`data-expanded`, `data-closed` and the rest).
- Not verified on macOS 26 itself.

## Related

- [[adr_headless_primitives]], the decision this replaces
- [[component_lib_boundary]], the seam that made the swap an edit to wrappers
- [[adr_stack_choice]], Solid as the framework
