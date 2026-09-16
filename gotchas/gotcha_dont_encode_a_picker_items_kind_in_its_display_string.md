---
summary: inferring a picker item's kind by parsing its label misroutes a local branch literally named like a remote one
status: current
updated: 2026-07-11
source: Unified Attach Existing Branch -> Add Branch/Worktree (personal/sway, branch code-mirror-6); `src/components/Sidebar.tsx` (`addBranch`, `addWorktree`)
---

# Don't encode a picker item's kind in its display string

When one picker mixes items of different kinds that route differently (*Add Branch* / *Add Worktree* show **local** branches and **remote** `origin/<name>` branches, routed to `attach_branch` vs `attach_remote_branch`, or resolved to a bare branch for `create_worktree`), do NOT infer the kind by parsing the display string (e.g. `label.startsWith("origin/")`). Why: a local branch can be literally named `origin/x` (a valid `refs/heads/origin/x`), so `list_branches` returns `origin/x` and prefix-routing misfires it to the remote sink. Carry kind **out-of-band**: build a `Map<label,{kind,branch}>` as the single source of truth and route by `map.get(label).kind`. On a label collision (a local `origin/main` vs a remote `main` both wanting `origin/main`) insert locals first and skip the dup, so local wins deterministically.
