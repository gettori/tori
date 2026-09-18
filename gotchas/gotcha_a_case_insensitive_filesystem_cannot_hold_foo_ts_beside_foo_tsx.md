---
summary: macOS cannot hold breadcrumbs.ts beside Breadcrumbs.tsx, tsc reports it as an import error not a collision
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 7 (personal/tori, branch `wave-6`); `src/panels/Editor/breadcrumbTrail.ts`; commit c6177fa"
---

# A case-insensitive filesystem cannot hold `foo.ts` beside `Foo.tsx`

Do NOT name a pure module after the component it serves. macOS cannot hold `breadcrumbs.ts` and `Breadcrumbs.tsx` in one directory, and `tsc` reports it as TS1149/TS1261 (casing of the imported file) rather than as a missing file, which does not read as a filename collision. Suffix the module instead: `breadcrumbTrail.ts`. Why: the error message points at the import site, so the first instinct is to fix the import.
