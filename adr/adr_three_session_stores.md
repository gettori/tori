---
summary: Tori keeps three session stores, transcripts as truth, a rename overlay that is not rebuildable, a discardable index
status: current
updated: 2026-08-15
source: Make a harness installable, signed in, and discoverable (personal/tori, branch `harness-lifecycle`); Phases 0 and 4; `src-tauri/src/sessions.rs` (`set_session_name`, `load_overlay`/`save_overlay`, `stamp_listing`)
---

# Tori keeps three session stores, and only the third is derived

Supporting several harnesses and several accounts per harness needed a faster, uniform session list than scanning every root on every open, which looked like it would contradict [[concept_filesystem_source_of_truth]]. We resolved it by naming what already exists: Tori keeps **three** session stores, not one. Harness transcripts are the truth, the **rename overlay** is Tori-authored and deliberately not rebuildable, and the new **index is derived and discardable**. `concept_filesystem_source_of_truth` constrains only the third, so a cache that can always be thrown away and rebuilt is not a source of truth and the original property survives intact.

The overlay was not invented here. `set_session_name` has always written user renames to a store outside the watched transcript dirs, keyed by session id, pinned by `an_overlay_written_before_archiving_was_removed_keeps_its_renames`. The plan that preceded this ADR described only two stores and would have let an implementer fold names into the new index, where the first rebuild would have erased every rename.

## Considered Options

- **A Tori-owned ledger as the authoritative session list** (rejected: it makes Tori's record able to drift from the harnesses', needs a backfill migration that can lose history, and would leave the profile-to-session mapping unrecoverable the moment the file was deleted).
- **Stay entirely derived, with no Tori-side index** (rejected: listing then requires spawning every installed harness, which is slow and impossible offline; and an ACP `session/list` row carries only `sessionId`, `cwd`, `title` and `updatedAt`, with no branch, which the sidebar shows).

## Consequences

- The index must hold no user-authored field, and that is a testable invariant: discard it, relist, and every row plus every rename must return. Enforced structurally: nothing before `pub fn list_sessions(` may assign `name` or `profile_label`, both of which are stamped at list time from their own stores.
- **Profile attribution lives in the index, and that is now settled.** Phase 0 measured that transcripts *do* relocate under an isolated home, so the profile is derived from the root that produced the row. Attribution never touches the rename overlay, and the discardability invariant above covers the profile tag too: delete the index, rescan the `(profile, root)` set, and every tag comes back. The overlay stays cosmetic-only and load-bearing for nothing.
- The schema hinge is `accounts.home_default`, two declared paths rather than one declared suffix: a profile's transcript root is `[discovery] dir` with the harness's default home swapped for that profile's home. A `dir` that does not sit under `home_default` yields **no** root rather than a guessed one, and the loader refuses `supports_isolation = true` beside a `[discovery]` table with no `home_default`, because that pair is an account that signs in and then shows an empty history forever.
- A label is sent only when there is a second account to confuse it with, so a machine that never added one renders exactly the list it always did, with no frontend rule about when to show a badge.
- An ACP row is **unattributed** rather than defaulted: its locator records no account and no root produced it. Defaulting it to whichever account the user happens to have would be a guess that reads as a fact.
- Sessions started in a terminal under a config dir Tori has no profile for are simply **never discovered**, which is an honest gap rather than a misattribution: Tori only scans roots it has profiles for.
- Two profiles holding one session id stay two rows, because the cache is keyed by path and a path belongs to one root. What Tori cannot fix is resume, since `--resume <id>` takes the harness's own id and would be ambiguous to the harness before it was ambiguous to Tori.

## Related

- [[concept_filesystem_source_of_truth]] - the property this decision preserves by scoping it to the derived store
- [[concept_locator_scheme_for_db_backed_sessions]] - the six path-consuming functions any store-less session must still answer
- [[component_session_scanner]] - what the derived index is built from
- [[adr_credential_custody]] - the sibling decision from the same plan
