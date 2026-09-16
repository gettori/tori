---
summary: a JSX-returning factory runs once eagerly, so a For row it builds freezes when its store item mutates in place
status: current
updated: 2026-09-04
source: "\"Subagent lanes in the chat panel\" (personal/sway, branch `bugfix-260903`); Phase 3 self-review; `src/panels/Chat/LaneStrip.tsx`, `src/panels/Chat/LaneStrip.test.tsx`; commit 785aa61"
---

# A factory returning JSX freezes a row built from a store object mutated in place

`const chip = (label: string, tone: string) => <button class={tone}>{label}</button>` inside a component looks like a component and is not one. Its arguments are computed **eagerly**, at the moment the call is written, so nothing inside re-runs when their sources change. That is usually harmless because the enclosing `For` re-renders the row when its item changes identity.

It is not harmless when the item is a store object the reducer mutates **in place**, which is what `produce` does. `For` sees the same reference, never re-runs the row, and the factory's already-computed strings stand forever. In the lane strip this meant an elapsed clock frozen at the value it was first handed and a status dot that would never have changed colour, on a row whose whole job is to move.

The fix is to make it an actual component (`const Chip = (p: { lane: Lane }) => ...`) so every read is a tracked access inside its own reactive scope. The tell: any factory taking already-resolved values rather than a props object is a snapshot, and no test that asserts a single render will catch it. The regression test advances fake timers and asserts the figure moved.
