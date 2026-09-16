---
summary: a component mounted through Portal attaches to document.body as a sibling of render's container, not inside it
status: current
updated: 2026-08-12
source: "plan \"axe-core harness in the jsdom vitest project\" (personal/sway, branch `97-axe-core`, issue #97); `src/components/Toasts/Toasts.test.tsx`, `src/test/axe.ts`; commit 0010b81"
---

# A portalled component is not inside `render`'s container

Do NOT scope an assertion to the `container` returned by `@solidjs/testing-library`'s `render` when the component under test mounts through a `<Portal>`. The portal attaches to `document.body`, making it a **sibling** of that container, not a descendant, so `container` stays empty and any assertion over it passes while looking at nothing. This is 19 components: everything in `src/components/Dialogs/`, plus `Popover`, `Omnibox`, `Toasts`, `ShortcutSheet`, and `Settings.tsx`. Scope to `document.body` instead, which is safe per-test because `src/test/domSetup.ts` unmounts after each one. `Toasts.test.tsx` asserts both halves so the rule cannot rot. Why: it fails open, and the components it fails open on are the modals and menus whose accessibility matters most.
