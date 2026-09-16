---
summary: Array.prototype.at is ES2022 but tsconfig's lib caps at ES2020, so at(-1) passes vitest and fails tsc noEmit
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phase 10; `tsconfig.json:6`; commit 51f1f1a"
---

# `Array.prototype.at` is outside this repo's TS lib

Don't use `.at(-1)` in this codebase. Why: `tsconfig.json` sets `lib: ["ES2020", ...]` and `at` is ES2022, so it runs fine under vitest (real Node) and then fails `tsc --noEmit`, which means a green test run is not evidence the code compiles. Use `arr[arr.length - 1]`.
