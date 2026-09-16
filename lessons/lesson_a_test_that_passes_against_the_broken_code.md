---
summary: six tests across two waves asserted something true of every implementation while named for the thing they skipped
status: current
updated: 2026-08-28
source: "Editor Wave 6: the IDE surface (personal/sway, branch `wave-6`); Phases 9, 11, 12 (#57, #50, #61); commits 3cbbde1, 48af914, 98b038b, extended by Editor wave 7: language intelligence depth (branch `wave-7`); Phases 7, 8, 9; commits a862bbe, a1511d7, d7a6e3e"
---

# Run the new test against the unfixed line before believing it

## What happened

Three phases in one wave wrote the obvious test for a bug they had just fixed, watched it pass, and only later noticed it passed against the broken code too.

- **Bookmarks (#57).** Marks past the end of a shortened file were being deleted. The obvious test (make a file shorter, check the marks survive) passes either way, because the bug needs a mark that *can* be seen to move in the same file as one that cannot, in the same transaction.
- **Editable search results (#50).** A results buffer revisited after a tab switch silently ignored ⌘S, because the kept `EditorState` carried the destroyed first mount's extensions. The obvious test (the edits are still there) passes against the broken code, since the document survives fine; only the *rules* stop working.
- **Search history (#61).** The recall cursor was surviving a project switch, so the first arrow press in a new project could type the old project's draft into the box. The obvious test (arrow in a fresh project, nothing happens) passes either way, because an empty history short-circuits before the cursor is ever read.

## Why

Each of these is a bug in *state that carries across a boundary*: a document edit, a component remount, a workspace switch. A test that exercises only the near side of the boundary never reaches the carried state, so it asserts something true of both versions. The test looks like it covers the fix because it names the fix in its title.

## What to do next time

- **Run the new test against the unfixed line.** Revert the fix, watch the test fail, restore it. This is a few seconds and it is the only thing that proves the test discriminates. All three of these were caught that way, and the third phase wrote it into its notes as a step rather than an accident.
- **Ask what makes the bug possible, then put that in the fixture.** For the bookmarks it was two marks with different visibility; for the search buffer it was a second mount; for the history it was a *second* workspace that already has history of its own, seeded through storage.
- **When the state survives but the behaviour does not, assert the behaviour.** The search-results test now checks that the guard still refuses a line-count change on the second visit, not only that the text came back.

## It happened again, in the other direction (2026-08-08, wave 7)

Three more phases in one wave, and this time the tests were not written for a bug already fixed: they were written to *confirm something believed true*, and confirmed nothing. The difference matters, because the wave-6 advice ("revert the fix, watch it fail") does not apply when there is no fix to revert. What caught all three was **mutating the product code and re-running**.

- **Phase 7.** A `destroy()` teardown was asserted by "the peek is gone", which is true with the teardown deleted, since CodeMirror removes the widget's DOM either way. A `scrollTop` check jsdom cannot make (it is 0 before and after anything) was passing against every implementation. And a workspace check had no wiring at all between the workspace it built and the code under test.
- **Phase 8.** "Lets the same symbol be expanded separately at two places" never put the same symbol at two places, so symbol-keyed and chain-keyed expansion behaved identically and it passed against both. Separately: a double-fetch guard was added, and *no test noticed the fix*, which only a second mutation pass revealed.
- **Phase 9.** "Discards a reply for a tab that has since been left" handed its fake a `current` that answered null from the **first** call, so the request was refused before it was even made and the post-await guard it was named for was never reached. And a grouping test counted rendered strips, which counts the same whether the merge kept both labels or only the last.

The shared shape: **an assertion that is true of every implementation, wearing the name of the one thing it does not test.** Reading these tests does not reveal it — six of them survived review across three phases — because they read exactly like tests that work.

**So the rule generalises.** Reverting the fix is the special case where the mutation is obvious. The general form is: *change the line the test claims to be about, in any direction, and require a named test to fail.* Do it for every guard, cap, ordering rule and cache key, not only for bug fixes. Where a mutation survives, the test is the thing to fix, not the code. And revert mutations from a **copy**, never `git checkout`, which restores HEAD and eats the uncommitted work ([[gotcha_reverting_a_mutation_with_git_checkout_restores_head_not_your_work]]).

## The case where no test in the suite can discriminate (2026-08-16, #116 branch)

The rule above assumes a mutation *can* be caught by some test you are able to write. Once, it could not. Every tab strip in the app was unclickable for a whole commit, and 279 test files stayed green - not because the assertions were weak, but because the failure lives in a timing rule the test environment does not implement. The gate expired at a microtask checkpoint the browser runs between listeners; `fireEvent` dispatches from a busy JS stack, so no checkpoint fires and jsdom never runs one anyway. Mutating the product code changes nothing a jsdom test can observe.

Two things covered it, and neither is a normal test:

- **A source guard.** `src/test/tabBarGate.test.ts` reads `OverflowTabBar.tsx` as text and fails if a deferred clear reappears in it. Asserting the *shape* of a fix is a poor substitute for asserting behaviour, and it is the right trade when no behaviour is observable: mutation-checked by putting `queueMicrotask` back, which is a mutation the whole rest of the suite ignores.
- **A real browser.** The fix was proved by driving the component's Storybook story with trusted CDP input, run against the unfixed code first so the before/after is a table rather than a claim ([[concept_trusted_input_verification]]).

**The tell to look for**: a defect that only reproduces under real user input, real layout, or real CSS. All three are things the suite stubs, and a green run over a stub is not evidence about any of them. When you notice you are in that territory, stop trying to write the discriminating unit test and go get the environment that can see it.

## And it happens to tests written for a fix you just made (2026-08-28, #159 phase 4)

Two bugs found in self-review, two fixes, two tests written to pin them. Both tests passed. Both also passed with the fix reverted, and the reason is the same in each: **the test reproduced the shape of the bug but not its timing.**

- **A status that answered while neither dialog was open.** `remove()` clears the delete confirm before awaiting `delete_feature` and opens the sweep after, so a `worktree_status` resolving in that window lands nowhere. The test held the *status* open and released it after clicking Delete, which is too late: `delete_feature` was an already-resolved promise, so its microtask ran first and the sweep was open by the time the status folded. Holding `delete_feature` open as well is what put the release inside the real window.
- **A dialog reopening after it was dismissed.** The test asserted `queryByRole("dialog")` immediately after `waitFor`-ing the invoke, so the reopen had not flushed yet and the assertion ran too early. One macrotask (`setTimeout(0)`) made it discriminate.

The tell for both: the fixture had the right *actors* and the wrong *clock*. When a bug lives in a gap between two async steps, the fixture has to be able to hold **both** ends open, not one. A single gate proves nothing, because the ungated side reorders the microtasks under you.

Same remedy as everywhere on this page, applied to two fixes in a row: revert, run, watch it fail. Both survived the revert until the gate was widened.

## Related

- [[concept_trusted_input_verification]] — what to do when the mutation is invisible to every test you can write.
- [[lesson_the_file_is_the_witness_not_the_buffer]] — two of the bugs this hid.
- [[lesson_verify_after_the_last_edit]] — the neighbouring discipline on the other end of a change.
- [[lesson_a_guard_keyed_on_what_changed_is_inert]] — the wave-7 defect a discriminating test caught.
- [[lesson_the_handshake_succeeded_and_the_feature_is_silent]] — the failures no mutation could catch, because every test asks a fake server.
- [[concept_editable_search_results]] — the store whose kept state carried the Major.
- [[gotcha_a_kept_editorstate_carries_the_configuration_it_was_built_with]] — the trap in one line.
- [[gotcha_reverting_a_mutation_with_git_checkout_restores_head_not_your_work]] — how to revert a mutation safely.
- [[component_feature_list]] — the dialogs whose two async gaps needed two gates, not one.
