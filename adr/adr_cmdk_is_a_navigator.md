---
summary: Cmd+K opens one ranked list of places, commands and settings with / for files, reversing July's no-places palette
status: current
updated: 2026-11-20
source: "plan \"Cmd+K navigator\" (personal/tori, branch `cmdk-improvements`), Decisions; commits `2e647536` (homes), `7bb1bbc0` (places); `src/utils/omniboxModes.ts`, `src/utils/commands.ts` (`command-palette`)"
---

# Cmd+K is a navigator, not a command list

## Context

Since wave 6 one box served both keys: a bare query meant files and Cmd+K
opened it with `>` typed. In July the palette had dropped every session row,
because the History dropdown listed sessions per branch better than a fuzzy
line could. That left no way to reach a space, project, worktree, Topic, chat
or session by typing, or by the issue or PR number people actually think in.

## Decision

Cmd+K opens the box on an `all` home: one list where places, commands and
settings rank together (**Go to Anything**). Cmd+P still opens on files, and
`/` reaches files from Cmd+K. A bare query means what the opening key asked
for, so the box carries a home for its lifetime and its tag shows it. Places
return, sessions in every space included, read from one read-only listing that
never enters the session store. The box stays on `Dialog` and `Combobox`,
extended with hooks, and gets its own ranker.

## Alternatives rejected

- **A separate navigator overlay.** Two boxes, two rankers and two ideas of
  "recent" is what the omnibox merge removed in wave 6.
- **Places behind a prefix inside Cmd+K.** The most common question would cost
  an extra keystroke every time, while commands, the rarer one, sat bare.
- **Places in Cmd+P's list.** The file list is long and ranked by frecency;
  places would drown in it, and files stay out of the all list for the same
  reason.
- **Keeping the mode a pure function of the text.** It would make a bare query
  mean the same from both keys, which is exactly what the two keys exist to
  avoid.

## Consequences

- The box has one piece of state the text cannot show, the home, which is why
  the tag lights up when a prefix leaves it ([[concept_omnibox_prefix_router]]).
- `#` plus digits had to become a number in the all home and stay a symbol
  search from Cmd+P.
- Places need the resolved tree pushed in by the sidebar
  ([[component_nav_index]]), and other spaces' PRs come from a remembered last
  value, never from a poll ([[concept_forge_rate_budget]]).
- The July "The palette lists no sessions" section of
  [[component_command_palette]] is superseded.

## Related

- [[concept_navigator_ranking]] how the one list is ordered
- [[component_combobox]] and [[component_dialog]] the surfaces it stays on
