---
summary: Solid's JSX.Element type includes undefined, so a required label prop is satisfied by label={undefined}
status: current
updated: 2026-08-16
source: "plan \"Revive tab selection, and make an unnamed segment a type error\" (personal/tori, branch `116-optional-accessible`, issue #116); `node_modules/solid-js/types/jsx.d.ts:30`, `src/components/SegmentedControl/SegmentedControl.tsx`"
---

# Solid types `JSX.Element` as including `undefined`

Do NOT build a "one of these two props is required" union on a required `label: JSX.Element`. Solid's `JSX.Element` is `Node | ArrayElement | string | number | boolean | null | undefined`, so the property is required to be *present* but is satisfied by an explicit `label={undefined}`, and a union written to guarantee a control has a name guarantees only that somebody typed the word. `NonNullable<JSX.Element>` is the spelling that holds. The omitted-property case is caught either way, which is why this passes a casual read: the reported defect is fixed while one spelling of it still compiles.
