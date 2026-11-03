---
summary: clearing a non-keyed Show whose child reads the accessor in a reactive prop throws a stale read, use keyed
status: current
updated: 2026-11-03
source: Global space ticket (branch global-space), phase attached-folders; commit 11a1c775; the move, attach and detach dialogs in src/panels/LeftSidebar/LeftSidebar.tsx
---

# A non-keyed Show child that reads its accessor throws when the condition clears

Do not render a dialog as `<Show when={req()}>{(r) => <Dialog prop={r().x} />}</Show>` without `keyed` when clearing `req` is how the dialog closes. Why: the child's reactive prop re-reads `r()` while the Show tears down, and Solid throws a stale value error; `<Show when={req()} keyed>` hands the child a plain value instead.

## Related

- [[gotcha_a_non_keyed_show_callback_read_once_at_mount_freezes_its_value]] - the opposite trap with the same construct
- [[gotcha_a_zero_parameter_show_child_is_not_a_callback_so_keyed_does_nothing]] - when keyed does nothing
