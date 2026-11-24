---
summary: a Kobalte combobox commits on Enter with or without Cmd, so note the modifier in your own onKeyDown and read it in onSelect
status: stale
updated: 2026-11-21
source: "plan \"Cmd+K navigator\" (personal/tori, branch `cmdk-improvements`), Phase 6, commit `84e3748d`; `src/components/Omnibox/Omnibox.tsx:1343` (`browserNext`)"
---

# A Kobalte combobox commits on Enter whatever the modifiers

> Stale: Kobalte left in gettori/tickets#106, so this describes the old implementation. See [[adr_own_primitives_on_native_layers]].

Do NOT expect Cmd+Enter to reach your `onSelect` as anything but a plain commit: Kobalte's combobox commits the highlighted option on Enter and passes no event, so the modifier is lost by the time the pick arrives. It calls the caller's `onKeyDown` first, so note the modifier there (the Omnibox sets `browserNext = e.key === "Enter" && e.metaKey`), read and reset it in `onSelect`, and do the other action from there. Why: the commit runs inside Kobalte's own key handler, and `Combobox` deliberately keeps `onSelect` as a value, not an event.

## Related

- [[component_combobox]] the wrapper whose `onKeyDown` runs before the primitive's
- [[component_command_palette]] Cmd+Enter opening a row's PR, issue or port
