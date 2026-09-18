---
summary: Show's callback receives the resolved when value, so a boolean guard like x !== null renders true, not the number
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (personal/tori, branch `chat`); Phase 12; `src/panels/Chat/SessionInfo.tsx`
---

# Solid's `<Show>` callback carries the `when` value, so a boolean guard yields `true`

Do NOT write `<Show when={x !== null}>{(n) => <>{n()} tools</>}</Show>` and expect `n()` to be the number: the callback receives the resolved `when` value, which here is the boolean `true`, and it renders as "true". Either read the value from its own source in the body, or make `when` the value itself. The value form has its own trap, though: `when={x}` on a number hides the row when `x` is `0`, so a genuine zero must use the `!== null` guard plus a direct read. Both mistakes render something plausible rather than throwing.
