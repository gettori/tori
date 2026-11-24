---
summary: Toast.Region's focus hotkey cannot be disabled, only matched, and an empty combo matches every keystroke
status: stale
updated: 2026-11-21
source: "plan \"Toasts onto Kobalte Toast\" (personal/tori, branch `105-toasts`, issue #105); `src/components/Toasts/Toasts.tsx`; `@kobalte/core@0.13.13` `dist/chunk/DX4MAOJL.js:113`; see [[component_toasts]]"
---

# A Kobalte toast region cannot be turned off, only mismatched

> Stale: Kobalte left in gettori/tickets#106, so this describes the old implementation. See [[adr_own_primitives_on_native_layers]].

`Toast.Region` has no way to disable its built-in focus hotkey; it only takes a combo to match, and it matches with `hotkey.every((k) => event[k] || event.code === k)`. Do NOT "clean up" that prop to an empty array: `[].every()` is `true`, so every keystroke in the app would focus the toast stack. `ToastRegion` passes a sentinel string no key can be, and `Toasts.test.tsx` pins it ("does not grab focus on an unrelated keystroke"). The real key is a `commands.ts` row, because Kobalte's listener sits on the document and never checks `defaultPrevented`, so it would double-fire against the registry, and its Alt+T default types a glyph on macOS besides.
