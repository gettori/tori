---
summary: the repo has no prettier config, so prettier's write flag defaults to 80 columns and reflows a 120-column file hugely
status: current
updated: 2026-08-25
source: Features phase 1 (#153), branch `feature-workspace`; `src/panels/LeftSidebar/LeftSidebar.tsx`
---

# No formatter config, so prettier defaults to 80 columns here

Do NOT run `npx prettier --write` on an existing file: the repo has no prettier config, the default is 80 columns, and it reflowed the 2800-line sidebar into a 1300-line diff. Format new files with `--print-width 120`, which is what the code is written at, and leave existing files alone.
