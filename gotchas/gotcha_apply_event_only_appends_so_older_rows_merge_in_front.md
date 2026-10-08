---
summary: folding older events into a live ChatState draws them below; fold apart, splice ahead, shift maps, re-mint ids
status: current
updated: 2026-10-04
source: "Open a chat with a bounded tail of history (personal/tori, branch `open-chat-with-bound`); `src/panels/Chat/chatStore.ts` (`applyEvent`, `ensureTool`, `prependHistory`)"
---

# applyEvent only appends, so older rows merge in front

Do NOT feed older history to `applyEvent` on the live state: every row it makes lands at the bottom, and a completion whose declaration is not loaded yet already made a nameless card through `ensureTool`. Why: the reducer only appends and `toolIndex`, `questionIndex`, `openText` and `openThinking` are positions into `items`, so a page has to be folded into a scratch state, spliced ahead with those maps shifted, its ids re-minted from the live `seq`, and any call split across the cut joined into one card, which is what `prependHistory` does.

## Related

- [[component_history_tail]]: the merge
- [[adr_chat_opens_on_a_bounded_tail]]: why history arrives in pages
