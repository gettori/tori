---
summary: Kobalte looks an option up by an unescaped [data-key] selector, so a value with a quote in it (a pasted URL) breaks the list
status: current
updated: 2026-11-20
source: "plan \"Cmd+K navigator\" (personal/tori, branch `cmdk-improvements`), Phases 5 and 6, commits `7bb1bbc0`, `84e3748d`; `src/utils/navIndex.ts:98`, `src/components/Omnibox/Omnibox.tsx:1016`"
---

# Kobalte finds an option by an unescaped data-key selector

Do NOT build an option's value from text the user typed or pasted. Kobalte finds an option's element with `[data-key="<value>"]` and does not escape the value, so a `"` in it (a URL typed as a query) makes the selector invalid and the highlight and scroll break. Give such rows a constant id (the Omnibox's lookup row is `lookup`, a pasted row `pasted`), and join composite ids with a character no part can hold (a unit's place id joins folder and branch with a space, since no branch name has one). Why: the value is used as the DOM key verbatim.

## Related

- [[component_combobox]] where values become option keys
- [[component_nav_index]] the place ids this constrains
