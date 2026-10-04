---
summary: a limit-stopped claude chat gets one limit-reset note 45s after its reset, armed in the webview so the ceiling and queue hold still apply
status: current
updated: 2026-10-04
source: plan "Resume a session when its usage limit resets" on branch resume-a-session, ticket gettori/tickets#3; src/panels/Chat/resumeAtReset.ts; src/panels/Chat/chatStore.ts:1850 (limitStopOf); src/panels/Chat/ChatView.tsx:1244 (the fire callback); dev/fixtures/claude/usage-limit.jsonl
---

# Resume at reset

A claude chat that stopped on a usage limit can continue by itself once the window resets. `chatDefaults.resumeAtReset` (off by default) arms every such chat, and the limit banner's **Resume at reset** button arms a single one. At the reset Tori sends one note, `<tori kind="limit-reset">`, asking the agent to continue where it left off. The transcript shows it as a Tori row, not as a user bubble.

## How it works

- **The stop.** `limitStopOf` (`src/panels/Chat/chatStore.ts:1850`) records a `limitStop` when a turn completes `errored` while the session's newest `rateLimit` reads `rejected` with a `resetsAt` later than the moment the turn ended. If the reset is already past, the window is gone, and arming on it would retry into a loop. Any send clears `limitStop` (`pushUserTurn`).
- **The arm.** `resumeAtReset.ts` is a webview store keyed by session. Each (session, turn, resetsAt) arms once, so the setting cannot re-arm something the user cancelled. The button passes `byHand`, which skips that check and also survives the setting being turned off.
- **The fire.** The timer goes off at `resetsAt + 45s`. Firing on the exact second can be refused because of clock skew, and the refused turn would then report a reset no later than its own end, so the resume would vanish with nothing on screen. Due sessions on one (agent, account) go one at a time. The next one goes when the previous fire settles: sent, refused, cancelled or closed.
- **The send.** `ChatView` registers a fire callback for its session. That callback checks `stopped()` itself, because `sendBlocks` does not ([[gotcha_sendblocks_does_not_check_the_spend_ceiling]]). It sets `continuing`, and when that turn completes the reducer releases the queue hold that the errored turn put on, so messages typed during the limit run after the continue.
- **Who arms.** Only `claude_stream_json` chats, not the cockpit, and not sessions under the autopilot lock. Arming reads this session's own `limitStop` and not the account-wide banner, so a sibling chat on the same login never offers the button.
- **Cancel.** A user send (`onSend`), the session ending, the view unmounting (`register`'s disposer), and the banner's Cancel.
- **The fixture.** No probe scenario can hit a limit on demand. `usage-limit.jsonl` is rebuilt from the limit record in a real sdk-cli transcript, whose `quotaLimits` is the same object as `rate_limit_info`. The result frame's `subtype` is the one field that was never observed, and the rule does not read it.

## Why it is this way

**The webview, not Rust.** The ticket proposed a Rust timer so it could "fire with the tab closed". But closing a tab ends the session through `ChatHost::close`, and a hidden tab stays mounted. A Rust timer firing through `ChatHost::deliver` would also get past the spend ceiling and the queue hold, which only the webview enforces.

**No persistence.** A restart drops every arm. t3code resumes overdue continues after a restart, but here that would mean spawning agents just because the app opened, which [[adr_lazy_tab_attachment]] rules out. Firing when a tab is opened was also rejected, because opening a tab would then start a turn.

**Claude only.** ACP forwards no reset time, so there is nothing to arm on.

## Related

- [[concept_spend_ceilings]]: the ceiling the fire callback has to check itself
- [[concept_tori_notes]]: the `limit-reset` kind
- [[concept_quota_is_an_account_fact]]: the account-wide banner the button sits on
- [[adr_lazy_tab_attachment]]: why a restart drops the arms
- [[gotcha_sendblocks_does_not_check_the_spend_ceiling]]: the trap the fire callback avoids
