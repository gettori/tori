---
summary: a save fires the fs watcher for the same path 250ms later, mark it a self write or the editor reloads its own save
status: current
updated: 2026-06-29
source: CM6 migration (personal/tori); `src/selfWrites.ts`; commits bef939a, 784724b
---

# Save triggers its own fs-watcher echo

Do NOT treat every `fs://changed` as an external edit; a `⌘S` makes the watcher fire ~250ms later for the same path. Why: without suppression the editor auto-reloads/banners the buffer you just saved (and the gutter double-diffs). On save call `markSelfWrite(path)`; every `fs://changed` consumer checks `isSelfWrite(path)` (a non-consuming TTL peek so multiple consumers can each skip it) and ignores the echo. The gutter still refreshes via an explicit on-save call so suppression doesn't starve it.
