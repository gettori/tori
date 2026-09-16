---
summary: Storybook's docgen assigns default.__docgenInfo for an export default function component, esbuild rejects it and hangs
status: current
updated: 2026-08-12
source: "plan \"Storybook 10 workshop with a11y addon and theme toolbar\" (personal/sway, branch `96-storybook`, issue #96); `.storybook/main.ts`; skarif2/sway#96 comment 5259157006"
---

# storybook-solidjs-vite's docgen breaks on an `export default function` component

Do NOT leave `docgen` on in this repo's Storybook framework options. Why: the generator appends `<displayName>.__docgenInfo = {...}` to each component module, and for `export default function Button()` the displayName it derives is literally `default`, so it emits `default.__docgenInfo = {...}`. `default` is a reserved word in expression position, esbuild fails with `Unexpected "default"`, and the preview build dies. Two things make it nastier than it sounds: `storybook dev` stays perfectly green, so it only surfaces in `build-storybook`, and the failed build **hung** instead of exiting, so it presents as a timeout rather than an error until you read the log. Every component in `src/components/` is an `export default function`, so this is not a one-component workaround: set `framework: { name: "storybook-solidjs-vite", options: { docgen: false } }` and let stories declare their own `argTypes`, which is what the props table would have inferred anyway. Observed on `storybook-solidjs-vite@10.6.0` with `storybook@10.5.7`. See [[component_storybook_workshop]].
