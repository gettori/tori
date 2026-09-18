---
summary: rebuilds the notification stack on Kobalte's Toast keeping both old write APIs, focus hotkey is a command row now
status: current
updated: 2026-08-15
source: "plan \"Toasts onto Kobalte Toast\" (personal/tori, branch `105-toasts`, issue #105, part of #93); previous hand-rolled stack owned by `LeftSidebar.tsx`; commit c6b0e7b is the parent"
---

# Toasts

**Location:** `src/components/Toasts/Toasts.tsx` (key files: `Toasts.module.css`, `Toasts.test.tsx`, `Toasts.characterization.test.tsx`, `Toasts.stories.tsx`, `src/lib/toast.ts`)

The transient-notification surface, rebuilt on Kobalte's Toast through `src/lib/toast.ts` (allow-list: `Region`, `List`, `Root`, `Title`, `CloseButton`, `toaster`). Portalled, bottom-right, newest at the bottom, 8s per toast, no cap. Two kinds, `error` (the common case: a failed git op, a refused worktree removal) and `info`, plus an optional single action button for a notice whose undo has nowhere else to live.

The migration's defining constraint was that the write API could not move: 87 sites emit the `TOAST` event and the sidebar's `setError` has ~40 local callers. Both kept their signatures, so the diff is the stack itself and nothing that talks to it.

## Responsibilities

- Owns the one toast region for the app, mounted once by `App.tsx`, and the `TOAST` event bridge into it.
- Owns `pushToast(message, kind?, action?)`, the imperative write API, including the trim-and-drop guard for empty messages (the old "clear the banner" idiom, which some `setError("")` callers still use).
- Owns placement and chrome: the fixed bottom-right region, the per-kind left border on design tokens, the action and dismiss buttons composed from the shared `Button`.
- Does **not** own the list, the timers, pause-on-interaction, or Escape dismissal. Those are Kobalte's, configured through `Region` props.
- Does **not** own the focus hotkey. `⌘⌥T` is a row in the command table like every other key; the region only listens for the `FOCUS_TOASTS` event it emits. See [[gotcha_a_kobalte_toast_region_cannot_be_turned_off_only_mismatched]].
- The controlled `toasts`/`onDismiss` props API is retired. Kobalte's model is imperative and the props API had exactly one consumer.

## Key files & entry points

- `src/lib/toast.ts` - the Kobalte door, one namespace object per the [[component_lib_boundary]] convention; `Description`, the progress parts, the swipe handlers and `useToastContext` deliberately absent
- `Toasts.tsx` `pushToast` - builds one toast; `Toast.Title` carries the message so `aria-labelledby` resolves to it, and both buttons are `Toast.CloseButton as={Button}` so run-then-dismiss is Kobalte's own ordering
- `Toasts.tsx` `ToastRegion` - the default export; `duration={8000}`, `limit={Infinity}`, `pauseOnPageIdle={false}`, and a sentinel `hotkey` that no key can match
- `Toasts.characterization.test.tsx` - the behaviour pinned across the migration, through a `mount`/`push`/`hover` harness that is the only implementation-aware part
- `Toasts.test.tsx` - the wrapper contract: axe on `document.body`, the portal-scope guard, region and status roles, Escape, the focus event, the empty-message no-op, run-then-dismiss ordering
- `src/utils/commands.ts` `focus-toasts` - the `⌘⌥T` row, so the `⌘/` sheet prints it
- `src/utils/events.ts` - `TOAST` (unchanged, 87 emitters) and `FOCUS_TOASTS` (new)

## Connections

- Depends on [[component_lib_boundary]] - reaches Kobalte only through `src/lib/toast.ts`
- Depends on [[component_button]] - both the action and the dismiss control are `Button` under a polymorphic `as`
- Used by [[component_command_palette]] - the `focus-toasts` row is dispatched from the same table the palette lists
- Governed by [[adr_headless_primitives]] - the wholesale move of interactive primitives behind `lib/`

## Related

- [[component_popover]] - the sibling migration (#104), same wrapper conventions
- [[gotcha_a_kobalte_toast_region_cannot_be_turned_off_only_mismatched]] - the empty-hotkey-array trap
- [[gotcha_a_role_status_li_fails_axes_list_rule]] - why the region renders divs
- [[gotcha_kobaltes_toast_store_outlives_the_region_that_shows_it]] - the module-global store, in tests and with two regions
