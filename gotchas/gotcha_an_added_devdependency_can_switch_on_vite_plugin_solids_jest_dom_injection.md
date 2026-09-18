---
summary: adding an unrelated devDependency can resolve vite-plugin-solid's optional jest-dom peer and silently inject test setup
status: current
updated: 2026-08-12
source: "plan \"Storybook 10 workshop with a11y addon and theme toolbar\" (personal/tori, branch `96-storybook`, issue #96); `package.json`, `vitest.config.ts:78`; gettori/tori#120"
---

# An added devDependency can switch on vite-plugin-solid's jest-dom injection

Do NOT assume a dependency addition is inert because the versions of the shared packages did not move. `vite-plugin-solid` declares an **optional** peer on `@testing-library/jest-dom`, and when that peer resolves it appends `@testing-library/jest-dom/vitest` to vitest's `setupFiles` on its own (`getJestDomExport` in its `config` hook; the entry is appended to the user's array, not substituted for it). Adding Storybook dragged jest-dom into the tree, which satisfied the peer and flipped the injection on, changing the lockfile's resolution key from `vite-plugin-solid@2.11.12(solid-js@…)(vite@…)` to `vite-plugin-solid@2.11.12(@testing-library/jest-dom@6.9.1)(solid-js@…)(vite@…)`. Because jest-dom was undeclared, whether it got linked at the project root was a hoisting accident: it was on macOS, so the full suite passed locally, and it was not on CI, where **all 103 `dom` files failed to collect** with `Cannot find module '<repo>/@testing-library/jest-dom/vitest'` and a telltale `setup 0ms`, meaning `domSetup.ts` never ran either. Declare the package so the root link is deterministic. The wider trap: a post-install check of the form `pnpm list <shared deps>` compares **versions** and cannot see a changed **peer resolution key**, so it reports green on exactly this class of change; diff the lockfile's importer entries instead. See [[component_storybook_workshop]] and [[lesson_a_gate_that_cannot_fail_is_not_a_gate]].
