---
summary: du sums each file's own allocated blocks and knows nothing about blocks an APFS clone shares, so it double-counts
status: current
updated: 2026-07-29
source: Chat surface plan, phase 12 (personal/tori, branch `chat`); `src-tauri/src/attempts.rs` (`clone_dep_dirs`, `cloned_dependencies_are_usable_and_cost_far_less_than_three_copies`)
---

# `du` cannot see an APFS clone

Do NOT measure the disk cost of a copy-on-write clone with `du` (or any per-file size sum): `du` reports each file's own allocated blocks and knows nothing about blocks two files share, so a perfect clone reads there as a full second copy, and a test asserting "far below three copies" fails against a *correct* implementation. Why: only **free space on the volume** sees sharing. Measured: three clones of a 200MB tree consumed zero blocks while `du` still reported 200MB apiece.
