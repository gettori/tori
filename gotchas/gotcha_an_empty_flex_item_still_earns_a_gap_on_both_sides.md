---
summary: a wrapper with only an absolutely positioned child is still a zero height flex item and earns a full gap either side
status: current
updated: 2026-08-16
source: "plan \"Re-audit Dialog and Tooltip against the solid-ui reference\" (personal/tori, branch `130-re-audit-dialog-and-tooltip`, issue #130); `src/components/Dialog/Dialog.module.css`, `Dialog.tsx`, `src/components/Omnibox/Omnibox.tsx:649`"
---

# An empty flex item still earns a gap on both sides

Do NOT assume a wrapper with nothing visible in it costs nothing once its parent switches from margins to `gap`. A gap is paid between *flex items*, and an item qualifies by being in flow, not by having height: a `div` holding only an absolutely positioned child is a zero-height flex item that still collects a full gap on each side. This is precisely what margins did not do - a margin on an out-of-flow child affects no sibling - so moving spacing from margins to `gap` is not the value-preserving refactor it looks like. `Dialog`'s head wrapping a `titleHidden` title would have opened the command palette with a dead band above its filter field. Give the wrapper `display: contents` when it has nothing in flow, which drops its own box and leaves the out-of-flow child exactly where it was. Nothing automated sees this either; the configuration that breaks is also the rarest one, which is [[lesson_a_gate_only_sees_the_configuration_the_test_builds]] again.
