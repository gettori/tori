---
summary: solidjs testing library's unmount clears the container without disposing the root, onCleanup never fires, use a toggle
status: current
updated: 2026-07-29
source: Chat surface plan, phase 3 (personal/tori, branch `chat`); `src/panels/Chat/MessageList.test.tsx`
---

# @solidjs/testing-library unmount does not run onCleanup

Do NOT test cleanup behaviour by calling the testing library's `unmount`: it clears the container without disposing the root, so `onCleanup` never fires and the test proves nothing about the app. Drive a real `<Show>` toggle instead, which is what the component does in production. Relatedly, jsdom gives every element a zero rect, so anything resolving "topmost visible element" picks the last one; pin that a value survives a round trip, not which element wins.
