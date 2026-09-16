---
summary: casting a tauri event payload with as suppresses the check catching a wrong field, the guard reads undefined always
status: current
updated: 2026-08-01
source: "Fix the stale `fs://changed` payload contract in ReviewPanel (personal/sway, branch `wave-1-3`); `src/utils/events.ts:127`, `src/panels/Editor/ReviewPanel.tsx:481`; issue #12"
---

# An `as` cast on an event payload opts out of the contract

Don't reach for `as` to type a Tauri event payload: `listen("fs://changed", (e) => (e.payload as { path?: string })?.path)` compiles forever against a backend that emits `{ paths: string[] }`, and the read is simply `undefined`. Why: an assertion is the one construct that suppresses exactly the check that would have caught it, so the guard built on that value (`if (!open || !changed || changed.endsWith(open.path))`) short-circuits true on every event and a refresh written to be selective is silently unconditional, in this case refetching the open diff on every watcher burst in the project. Pass the shared type as the type argument instead (`listen<FsChanged>`), which turns a wrong field into a compile error. Note which half does the work: a payload type in one place is worth less than never casting, because the type cannot rescue a call site that opted out of it. Related in shape to [[gotcha_replacing_an_enum_with_a_string_silently_disarms_a_compile_time_check]] and [[lesson_narrowing_a_type_can_entrench_a_bug]].
