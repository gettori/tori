---
summary: the sidebar onMount awaits five tauri listen calls before subscribing, so an early event lands on nobody
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown (branch `navigation`, phases 5-6); `src/panels/LeftSidebar/LeftSidebar.tsx`; commit 61eb767
---

# A window listener registered in an async onMount can miss a startup event

Do not register a window event listener after an `await` in `onMount`. The sidebar's `onMount` awaits five Tauri `listen()` calls first, and an event fired during that window lands on nobody. Why: it became load-bearing when tab focus turned into the *only* path from a tab to a `Selection` - an event lost there leaves the editor's Session panel blank with nothing to click to recover. Register in the component body; none of these listeners needs an await.
