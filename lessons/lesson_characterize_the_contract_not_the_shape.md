---
summary: split a characterization test into a contract block that survives a refactor intact and a shape block that shifts
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven simple dialogs onto Dialog\" (personal/tori, branch `99-migrate-seven-dialogs`, issue #99, part of #93); `src/components/Dialogs/*.test.tsx`, `src/components/ShortcutSheet/ShortcutSheet.test.tsx`; commits `2f4df8a`, `7c07e0d`, `3abcd42`; applied again by plan \"Migrate the seven complex dialogs onto Dialog\" (branch `100-migrate-seven-conplex-dialogs`, issue #100, PR #125); commits `7c21e5e`, `11464ba`, `97a1eb6`, `d6a640f`"
---

# Characterize the contract, not the shape

## What happened

Seven dialogs with no tests at all had to move onto [[component_dialog]] without changing behavior, so characterization tests came first and "the tests pass unchanged" was to be the proof. That framing does not survive contact: a shell swap changes the DOM and the event wiring on purpose, so a portion of any test written against the old component is guaranteed to break, and it is not the portion anyone cares about.

Three assertions could not survive in their original form. Dismissal moved from a `mousedown` on a real backdrop element to a `pointerdown` anywhere outside the panel, installed a macrotask late. Enter-to-confirm stopped being a handler at all and became the browser clicking a focused button, which jsdom will not do. And every consumer helper that found a field through `getByText(title).parentElement` broke at once, because the flat modal became `.head` / `.body` / `.actions`.

## Why

A characterization test has two kinds of assertion inside it and they have opposite fates under a refactor. One kind states what a caller relies on: an empty string is a valid prompt answer, cancelling askpass relays `null` so the whole git op aborts, the PR form does not submit on Enter. The other kind states how today's markup happens to deliver that: which element the press lands on, which ancestor carries the handler. Mixed together in one file, the second kind's breakage is indistinguishable from a real regression, so the safety property the tests were written for is exactly what gets lost at the moment it is needed.

## What to do next time

Split the file before the migration, not during it. Two `describe` blocks:

- **contract**, written so every assertion holds for both implementations. This block must survive byte for byte, and an unchanged block is the actual proof that nothing changed.
- **shape**, holding what is coupled to today's DOM and event wiring, with a comment saying it is expected to be rewritten.

Then the migration diff shows a rewritten `shape` block and an untouched `contract` block, and a reviewer can see the safety argument rather than take it on trust. Write contract assertions through the accessibility tree (role plus accessible name), never through DOM shape, so they survive nesting changes for free. When a behavior genuinely cannot be expressed identically on both sides, move it to `shape` and say why in place; do not quietly weaken it and leave it in `contract`.

## What the second application added (#100)

Running it again on seven harder dialogs sharpened three things the first pass did not surface.

**The split is a judgement about the destination, not a property of the assertion.** #99 filed Enter under `shape`, because there `Dialog` had no key seam and Enter-to-confirm became the browser clicking a focused button, which jsdom will not do. #100 added `onKeyDown` to the wrapper, and that reasoning stopped holding: an explicit handler now exists on *both* sides, so an Enter fired at a child element bubbles to one either way and the assertion is contract after all. The plan's own decision was reversed and the reversal written down rather than silently ticked. So re-derive the split against the shell you are actually moving to; inheriting a previous migration's classification is how a contract assertion gets demoted for no reason.

**Reclassification runs both ways.** The same pass moved an assertion *out* of contract: "focuses nothing in a mode that has no field" asserted `activeElement === document.body`, and where focus lands when a dialog names no target is the shell's business, not something a caller relies on. The migration deliberately changes it (the panel takes focus, which is what makes Enter reachable there at all). A contract block that only ever grows is a sign the question is not being asked honestly.

**Report the diff you actually got.** Two of the eleven contract blocks did change, both because a later task in the same plan *required* it (deleting an axe rule override is not optional once the field is named). The task was marked `[~]` with the two files and the reasons, not ticked. "The contract blocks pass unchanged" is worth something only while it is allowed to come back false; the honest partial is the artifact, and the four byte-identical blocks either side of it are what carry the proof.

## Related

- [[component_dialog]] - the shell the seven moved onto, and what it takes over from each of them
- [[gotcha_do_not_reach_a_dialogs_field_through_its_titles_parent]] - the trap this hardened into
- [[gotcha_jsdom_does_not_click_a_focused_button_on_enter]] - why the Enter assertion had to move
- [[lesson_a_test_that_passes_against_the_broken_code]] - the neighbouring failure, a test that proves nothing rather than one that breaks loudly
- [[lesson_a_gate_only_sees_the_configuration_the_test_builds]] - the other way a characterization file can be green about the wrong thing
- [[component_picker_modal]] - the one body that changed rather than moved, so its `shape` block was rewritten to ask the accessibility tree what it used to ask a CSS class
