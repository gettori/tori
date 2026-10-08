---
summary: bounding a store, trace what each reader computes from the field; taking `items` is not needing all of them
status: current
updated: 2026-10-04
source: "Open a chat with a bounded tail of history (personal/tori, branch `open-chat-with-bound`), ticket gettori/tickets#5; `src/panels/Chat/SessionDiffView.tsx` (`reasoningFor`), `src/panels/Chat/chatStore.ts` (`promptsSent`, `toolCallsSeen`)"
---

# Check what a reader does with a field, not that it takes it

## What happened

Planning to hold only a tail of a chat's history in the store, the reader check
listed the session diff view as "reads full items", because it is handed
`state.items`. A whole plan phase was built to load every page when the diff
view opens. At build time the view turned out to take its file list from the
backend for this run only and to use `items` for one lookup, `reasoningFor`, on
this run's calls, which are always loaded. The phase was dropped.

The opposite miss happened in the same ticket. The figure enumeration listed
every field `applyEvent` writes and found the summary small, but missed values
*derived* from `items`: `promptsSent`, `toolCallsSeen` and the touched-files
count all count rows, so a tail undercounted them. It surfaced only while
writing the wiki, after the phase had been committed.

## What we learned

A field's readers are not its consumers until you follow each use. Passing a
prop says nothing about how much of it is needed, and a store field nobody
writes can still be counted by a derivation.

## What to do differently

When a change bounds what a store holds, enumerate both directions: every
writer of each field, and every function and memo that **reads** the bounded
field, with what it computes from it. Then assert the computed values, not the
fields, in the equality test.

## Related

- [[adr_chat_opens_on_a_bounded_tail]]: the change this happened in
- [[component_history_tail]]: the summary that grew the counts
