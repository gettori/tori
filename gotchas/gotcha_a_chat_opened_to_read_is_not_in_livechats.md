---
summary: a chat tab opened only to read, or closed, is not in liveChats, so routeFor sends to it the PTY way, never the chat route
status: current
updated: 2026-10-11
source: plan "Hunk comments: hold several, send them as one message" (branch phase-1-block-2, ticket gettori/tickets#35); src/panels/Chat/ChatView.tsx:1244, src/panels/Terminal/Terminal.tsx:1665
---

# A chat opened to read is not a live chat

Don't write a chat-route branch for a chat that isn't started or has no tab: it is unreachable. Why: ChatView registers in `liveChats` only once started (`ChatView.tsx:1244`), and `routeFor` reads the same list (`Terminal.tsx:1665`), so such a send takes the PTY route instead. A closed chat session gets resumed in a terminal with the text placed there. A read-only chat tab makes the probe wait until the request times out.

## Related

- [[concept_held_hunk_comments]] where two such branches were written and removed
- [[concept_safe_send]] the route this decides
