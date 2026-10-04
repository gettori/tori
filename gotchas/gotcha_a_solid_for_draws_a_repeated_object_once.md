---
summary: never put the same object twice in a Solid For list; it drew two identical cached preview fences as one
status: current
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7, phase large-preview; `src/panels/Editor/previewBlocks.ts` `unique`; `src/panels/Editor/previewCodeBlocks.test.tsx`
---

# A Solid `For` draws a repeated object once

Do not cache rows by content and hand `For` the same object twice: two identical fences in the markdown preview shared one cached segment and rendered as one block. Why: `For` keys rows by reference, so a repeated reference is one row. Number repeats in the cache key (`unique` in `previewBlocks.ts`) so each occurrence is its own object.

## Related

- [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]]: the same keying, from the other side
- [[component_markdown_preview]]: where it bit
