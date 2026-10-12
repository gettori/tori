---
summary: one last-look mark in Rust shared by Mac and phone, moved only when the Since you looked tab was shown, never by focus
status: current
updated: 2026-10-12
source: "Morning digest plan (branch `phase-1-block-2`, gettori/tickets#37); `src-tauri/src/needs_you_log.rs` (`looked_at`, `looked`), `src/utils/digest.ts`, `mobile/src/Inbox.tsx`"
---

# The digest's mark moves only when the digest was seen

## Context

The ticket asked for "since you last looked" as the app's last focus time, kept in Rust so a relaunch does not reset it. Tori usually stays running overnight, and the phone answers approvals at night.

## Decision

One mark, `looked_at` in the needs-you log, shared by the Mac and the phone. It moves only when the Since you looked tab was shown: to the `asOf` the client read, when the tab is left, the Inbox closes, the window blurs or the phone goes to the background while it shows. It never moves back. The digest keeps rows since the mark for up to 7 days.

## Alternatives rejected

- **Last focus time.** Approving one thing from the phone at 3am, or a ten second glance at the Mac, would move the mark and empty the morning's digest.
- **A mark per device.** The Mac would repeat what was already read on the phone.

## Consequences

A person who never opens the tab keeps a growing digest, bounded by the 7 day prune. Auto-open needs its own away rule (four hours unfocused or idle), separate from the mark.

## Related

- [[component_digest]] the reader
- [[component_needs_you_log]] where the mark lives
