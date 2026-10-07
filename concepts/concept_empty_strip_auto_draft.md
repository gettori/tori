---
summary: an empty worktree gets one chat draft after both restores, and it yields to the next explicit open until you type in it
status: current
updated: 2026-10-08
source: ticket gettori/tickets#17 plan, branch phase-1-block-1; src/panels/Terminal/Terminal.tsx draftIntoEmpty, untouchedAutoDraft, dropAutoDraft
---

# Empty strip auto draft

Selecting a branch or worktree whose strip holds no chat, terminal or file tab opens one chat draft there, so the work area never sits blank. A draft starts no process, so it costs nothing until the user sends.

## How it works

The selection effect in `Terminal.tsx` calls `draftIntoEmpty` for any selection that is not a session and not a Topic, including the one restored at launch. It awaits `stripEmpty` (both restores, see [[gotcha_stripready_waits_only_for_terminal_tabs]]), drops out if the selection moved on meanwhile (the draft would pull the user back), and opens only when `draftAgent` answers and `profileSignedOut` is false for its account. Health still loading counts as signed in.

The draft's id is kept per workspace in `autoDrafts` while it is untouched: open, no session id, empty composer text. The next explicit open takes it over:

- `spawnSession` (sidebar New session, the agent launch) closes it after its own tab is open.
- `NEW_CHAT_AT` with a prompt (a worktree from an issue) writes the prompt and origin into it instead of opening a second draft.
- The first strip `+` brings it forward instead of adding another empty draft. A `+` with a picked agent always opens a new one.

Typing in it ends the handover for good. Closing the last tab does not bring a draft back.

## Why it is this way

Selection and the explicit open race each other: the selection is set before `NEW_SESSION` or `NEW_CHAT_AT` is emitted, and both sides await restores. Suppressing the draft when a caller is "about to" open would need an intent flag across two async paths. Letting the explicit open take over is correct in either order, because the emptiness check and the open run in one synchronous step after the awaits.

## Related

- [[gotcha_terminal_focustab_never_writes_the_pane_pick]]
- [[component_tab_restore]]
