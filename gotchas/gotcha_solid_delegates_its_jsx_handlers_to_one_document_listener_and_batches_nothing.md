---
summary: solid attaches one delegated listener per event type on document, a capture phase stop upstream deletes jsx handlers
status: current
updated: 2026-08-16
source: "plan \"Revive tab selection, and make an unnamed segment a type error\" (personal/sway, branch `116-optional-accessible`, issue #116); `node_modules/solid-js/web/dist/web.js:477`, `src/panels/Editor/Editor.tsx` `closeTab`"
---

# Solid delegates its JSX handlers to one `document` listener and batches nothing

Do NOT reason about an `onClick` or `onKeyDown` prop as a listener on its own element. `eventHandler` in `solid-js/web` attaches once to `document` for every delegated type (click, pointerdown, keydown, mousedown, focusin and the rest) and walks the composed path itself, calling the `$$click`-style properties it finds. Two consequences that decide real behaviour. **A capture-phase `stopPropagation` upstream deletes those handlers entirely**, since the event never reaches `document` for the walk to start, which is how `OverflowTabBar` suppresses Kobalte's select-on-press without touching the default action. And **the handler is not batched**: `eventHandler` wraps nothing, so two signal writes in one handler flush as two separate update cycles and effects observe the state in between. A panel that closes a tab with `setTabs(remaining)` followed by `setActiveId(next)` therefore renders once with the list short and the id stale, which is exactly the render Kobalte's tab root heals ([[gotcha_kobaltes_tab_root_force_selects_the_first_key_and_calls_onchange_doing_it]]).
