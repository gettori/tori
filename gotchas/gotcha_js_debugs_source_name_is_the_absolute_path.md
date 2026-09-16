---
summary: js-debug puts the whole absolute path in a frame's source.name, take the basename only when it starts with a slash
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP), Phase 10 (personal/sway, branch `wave-8`); `src/utils/debugStack.ts` (`shortSource`)"
---

# js-debug's `source.name` is the absolute path

Do NOT render or compose a DAP frame's `source.name` expecting a basename. For a frame with a file behind it js-debug 1.117 puts the **whole absolute path** there, which is a full path in a narrow stack column and was **891 characters** of repeated directory in one composed message. Normalize once on the way in (`frameOf`), taking the basename only when the name starts with `/`, since the names that are not paths (`<node_internals>/internal/modules/cjs/loader`, `<eval>/VM123`) are already short and unreadable with their prefix removed. Why: the field name says basename, so nothing prompts you to check, and it renders as "long" rather than as "wrong".
