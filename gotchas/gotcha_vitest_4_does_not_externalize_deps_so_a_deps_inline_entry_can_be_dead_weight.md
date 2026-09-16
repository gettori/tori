---
summary: vitest 4 no longer externalizes deps by default, so a deps.inline entry added on reasoning alone can be dead weight
status: current
updated: 2026-08-12
source: "Design system foundation: src/lib boundary, Kobalte install, import guard (personal/sway, branch `94-design-system-foundation`, issue #94); `vitest.config.ts:47`; commit e90eba3"
---

# vitest 4 does not externalize deps, so a `deps.inline` entry can be dead weight

Do NOT add a package to `deps.inline` in `vitest.config.ts` on reasoning alone; remove it and watch a real mounted test before believing it is load-bearing. `@kobalte/core` looks like a textbook case (its `solid` export is untransformed `.jsx`, its `default` export resolves `solid-js/web` itself) and was added on exactly that reasoning, but vitest 4 no longer externalizes dependencies by default, so Vite transforms it either way: with the entry gone the dialog still mounts, still portals, and is still cleaned up between tests. The entries that remain there predate vitest 4 and were each measured. Why: the file's existing comments describe real failures in convincing detail, which makes adding a fourth entry feel like following the pattern rather than like adding an untested claim.
