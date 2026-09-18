---
summary: import.meta.glob keys are normalized relative to the importing file, so filtering by a folder name in the pattern fails
status: current
updated: 2026-08-12
source: "Design system foundation: src/lib boundary, Kobalte install, import guard (personal/tori, branch `94-design-system-foundation`, issue #94); `src/lib/boundary.test.ts:28`; commit e90eba3"
---

# `import.meta.glob` keys are normalized against the importing file

Do NOT filter `import.meta.glob` keys by a folder name that appears in the pattern. Globbing `../**/*.{ts,tsx}` from `src/lib/` returns siblings as `./dialog.ts`, never as `../lib/dialog.ts`, so an exclusion written as `path.startsWith("../lib/")` matches nothing. This bit `boundary.test.ts` on its first run: the guard reported the very re-export it exists to permit. Test for the `../` prefix instead, since everything the guard polices is a directory up. Why: the pattern you wrote and the keys you get back are in different frames of reference, and the filter fails open in the direction that still looks like a working test.
