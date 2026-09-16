---
summary: a login route built once for every profile row would have signed one account into another's default, unseen by a test
status: current
updated: 2026-08-15
source: Make a harness installable, signed in, and discoverable (personal/sway, branch `harness-lifecycle`); Phase 3 self-review; `src-tauri/src/auth.rs` (`login_route`), `src/panels/Settings/AgentAccounts.tsx`
---

# A per-row value hoisted to a container is invisible to a unit test

`AccountsView` carried **one** `login` route, built once with `home: None`, and every profile row used it. So pressing "Sign in" on a row labelled "Work" would have opened `claude auth login` with no `CLAUDE_CONFIG_DIR` set, signed the user into the login they already had, reported success, and left two profiles that were one account. The exact failure the multi-account feature exists to prevent, shipped by the feature itself.

`a_harness_with_login_args_opens_a_terminal_carrying_the_profile_home` passed throughout. It called `login_route` directly with a home and asserted the environment came back carrying it. The function was correct. **Nothing tested the caller that decided which home to pass.**

## The shape

A value that logically belongs to each row, computed once on the container and shared. It reads as a harmless hoist, and it is invisible to any test that exercises the function rather than the call site: the function still takes the parameter, still honours it, still has a green test. The bug lives entirely in the argument the caller chose, and there is only one caller, so nothing looks suspicious.

It is a close relative of a constant folded too early. What makes it worse than an ordinary bug is that **the wrong behaviour is indistinguishable from the right one in the success case**: signing in works, the terminal opens, the flow completes. Only the identity is wrong, and identity is exactly what nobody re-checks after a green login.

## What to do

- When a value is per-row, **put it on the row**, not on the container. `login_route` moved onto `ProfileStatus`.
- When a unit test asserts a function honours a parameter, ask what picks that parameter. If the answer is "one place, and nothing tests it", that place is the test you are missing.
- The regression test presses the button on **two** rows and compares the environments. One row cannot fail this way; the whole class of bug needs two of something to appear.
- Applies beyond auth: anything keyed by identity (a profile home, an account id, a workspace root, a tenant) where the container renders many and holds one.

## Related

- [[adr_credential_custody]] - the isolation this would have silently defeated
- [[lesson_a_test_that_reads_what_its_subject_wrote]] - the sibling failure, a test that cannot fail rather than a caller nothing tests
- [[lesson_a_test_that_passes_against_the_broken_code]] - the same family: green, and proving nothing
