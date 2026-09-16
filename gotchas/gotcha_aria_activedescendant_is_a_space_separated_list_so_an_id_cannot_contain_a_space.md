---
summary: aria-activedescendant splits on spaces into multiple ids, so a row key with a space reads as two and announces nothing
status: current
updated: 2026-09-05
source: "plan \"Multi-account: pick, lock and default an account per session\" (personal/sway, branch `multiaccount`), phase 3; `src/panels/Chat/AgentPalette.tsx`; commit `0bac9e3`"
---

# `aria-activedescendant` is a space-separated list, so an id cannot contain a space

Never build a DOM id from a key that joins with a space. The attribute takes several ids separated by spaces, so `providers-claude fonn` is read as two ids and the active row is announced as nothing. Why: the palette's row key is `catalogKey`, which joins agent and account with a space; `rowId` replaces it, which is lossless because neither id can carry one.
