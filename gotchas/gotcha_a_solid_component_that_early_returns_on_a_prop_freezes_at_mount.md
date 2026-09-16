---
summary: an early return gating a component on a prop freezes that branch at its mount value forever, since the body runs once
status: current
updated: 2026-08-14
source: Chat surface plan, phase 11 (personal/sway, branch `chat`); `src/panels/Chat/RuleList.tsx`, **deleted 2026-08-14** with the rule UI; the Solid behaviour is unchanged
---

# A Solid component that early-returns on a prop freezes at mount

Do NOT gate a component on a prop with an early `return` in its body (`if (!props.hooks) return <X/>`). Props are getters and the body runs **once**, so the branch is frozen at whatever the prop was at mount: a capability that resolves a moment later leaves the component permanently showing the wrong half. Use `<Show fallback>`. Test it by driving a signal, since a static render passes either way.
