---
summary: handing a generic Kobalte part to a Component<P> slot cannot infer P, so it becomes {} and selection collapses
status: current
updated: 2026-08-15
source: "plan \"Dedupe icon and swatch grids into one IconGrid\" (personal/tori, branch `109-dedupe-icon-and-swatch-grids`, issue #109); `src/lib/toggle-group.ts`; commit cd09a5e"
---

# A generic polymorphic component cannot be inferred from

Do NOT hand a Kobalte part straight to something typed `Component<P>` and expect `P` to be its props. Kobalte declares its parts as generic functions over what they render as (`ToggleGroupItem<T extends ValidComponent = "button">`), and TypeScript cannot infer a type argument *from* a generic signature, so `P` silently resolves to `{}`. Everything then compiles: the part's required `value` stops being required, and at runtime every item registers under the same undefined key, so selection collapses onto one phantom entry. It fails as "clicking any tile selects nothing", never as a type error. The fix is to hand out a concrete instantiation beside the generic one (`ButtonItem: Item as Component<PolymorphicProps<"button", ToggleGroupItemProps<"button">>>`) and infer off that. Keep the generic export too, `as={SomeComponent}` consumers need it. See [[component_toggle_group]].
