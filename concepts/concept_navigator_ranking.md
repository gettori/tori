---
summary: Cmd+K ranks every word per field by tier, numbers by kind and never scattered, then breaks ties by picks, visits, current last
status: current
updated: 2026-11-20
source: "plan \"Cmd+K navigator\" (personal/tori, branch `cmdk-improvements`), Phases 5, 6, 8, 11 and 12; commits `7bb1bbc0`, `84e3748d`, `1bcfa5f1`, `8cc77a78`, `6cef3f21`; `src/utils/navRank.ts:29`, `src/utils/navNumber.ts`, `src/utils/pickHistory.ts`, `src/utils/visitLog.ts`"
---

# How Cmd+K ranks places, commands and settings

`rank(items, query, input, history)` in `src/utils/navRank.ts` is a pure
ranker written for the navigator. `fuzzyMatch` stays as it is for file mode and
its other callers; one subsequence score cannot tell a whole-word hit from
letters scattered through a long branch name, and the navigator needs that
difference more than anything.

## How it works

- **Every word of the query must match somewhere** in a row's fields, or the
  row is out. Each word takes its best hit, and the scores add up.
- **Tiers per field** (`navRank.ts:29`): the field equals the word (110), starts
  with it (100), has it at a word start, camelCase included (85), contains it
  (40), or holds its letters in order, less 6 per gap (from 40). The last two
  only in the `title` slot.
- **Fields have slots.** `title` scores in full; any other visible field (a
  place's trail) drops 10; a hidden field drops 15 and is drawn only when it is
  what matched. A Topic's issue title is hidden, so a row found by its issue
  can show that title as its subtitle. Commands and settings take a 6 point
  penalty, so a place wins a tie with them.
- **Keywords are one hidden field each.** A typed keyword is then an exact hit
  (110 - 15 - 6 = 89), above a word start in some other command's title
  (85 - 6 = 79). One joined keyword field scored only a word start, tied with
  "Preferences: Usage notifications" on `usage`, and lost on input order.
- **Numbers are their own tier.** `numberQuery(word)` reads `92`, `#92`,
  `name#92`, `owner/name#92` and an issue or PR URL; `numberHit` compares repo
  plus number, so a typed repo narrows and a bare number matches any repo. An
  exact number scores by kind: linked issue 130, PR 125, a digit run in a branch
  name 120, a mention 115. A run inside a longer number scores 70 down to 55. A
  numeric word never reaches the scattered tier, so `14` never finds `#1924`.
- **Ties** (`tieOf`, `navRank.ts:105`): rows picked for this exact query come
  first, newest pick first (`pickHistory.ts`, 200 queries, 5 ids each), then by
  visit recency (`visitLog.ts`), then input order. The place you are on goes
  after all of them, even when picked. History never lifts a worse score.
- **Marks are per slot.** The result says which slots matched and where, so the
  row draws marks in the title, the trail, or inside a ticket or PR chip.

## Why it is this way

The list is re-ranked on every keystroke and Enter takes the top row, so the
order has to match intent closely: whole-word matches before scattered ones, a
place before a command that matches as well, and a learned pick only where the
scores already agree. Ties are where history earns its place without ever
overriding a better match, which keeps the list predictable while typing.

## Related

- [[component_nav_index]] the places and numbers this ranks
- [[concept_omnibox_prefix_router]] when the all home, and so this ranker, is in use
- [[concept_command_registry]] where command keywords come from
- [[component_issue_source]] repo plus number as an issue's identity
