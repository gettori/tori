---
summary: the forge raise lifts a dot only while nothing moves, so a dot edge re-fires each turn on a red branch; count red checks off forge attention
status: current
updated: 2026-10-12
source: "Notifications inbox plan (branch `phase-1-block-2`, gettori/tickets#36); commit 27dc9364; `src-tauri/src/rpc/dots.rs` (compose, `raised`), `src-tauri/src/needs_you_log.rs` (log_ops)"
---

# A forge-raised dot rises again after every turn

Do NOT count red checks off the display dot's NeedsYou edge. `compose` raises the dot for forge attention only while the tier is Solid or Hollow, so on a red branch the agent starting a turn drops the dot to Working (a `cleared` edge) and the turn ending raises it again (a fresh `rose`). One red check reads as one event per turn. Watch the forge unit's `attention` fact instead, keyed by folder and branch, with a latch that only resets when attention falls.

## Related

- [[component_needs_you_log]] where this bit, and the `settled` latch that fixes it
- [[adr_rust_composes_the_dot_from_reported_facts]] why the dot and the agent state differ on a red check
