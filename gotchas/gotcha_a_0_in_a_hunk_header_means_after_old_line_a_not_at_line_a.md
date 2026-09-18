---
summary: a hunk header's zero length old span means after old line a, not at line a, so mapped lines land one row too high
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phase 9; `src-tauri/src/agent_lines.rs`; commit 6dc425f"
---

# `-a,0` in a hunk header means "after old line a", not "at line a"

Don't read a unified-diff hunk header's zero-length old span as a position. Why: `@@ -a,0 +b,n @@` describes an insertion **after** old line `a`, so treating it as "at line `a`" puts every attributed or mapped line exactly one row above the line it describes. It is a single off-by-one with no visible symptom other than being consistently wrong by one, which reads as a rendering nudge rather than a bug. Branch on the zero-length case explicitly and give it its own test; collapsing the two branches is a mutation that should fail several tests at once.
