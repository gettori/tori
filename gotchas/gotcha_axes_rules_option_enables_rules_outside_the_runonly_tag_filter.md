---
summary: axe's rules option is not scoped by runOnly's tag filter, a shallow merge lets a caller re-enable an excluded rule
status: current
updated: 2026-08-12
source: "plan \"axe-core harness in the jsdom vitest project\" (personal/tori, branch `97-axe-core`, issue #97); `src/test/axe.ts:98`, `src/test/axe.test.tsx:88`; commit 0010b81"
---

# axe's `rules` option enables rules outside the `runOnly` tag filter

Do NOT merge caller-supplied axe options over your defaults with a shallow spread. `rules` is not scoped by `runOnly`: axe documents combining `runOnly: {type: 'tag', values: ['wcag2a']}` with `rules: {'color-contrast': {enabled: true}}` precisely to pull in a rule the tags exclude. So a shallow `{...defaults, ...overrides}` lets any caller overriding one unrelated rule drop the whole disabled list, and re-enabling a rule that is unjudgeable under jsdom is one key away. Merge per key and spread the disabled set **last** (`rules: { ...overrides.rules, ...JSDOM_BLIND_RULES }`), and test it with a **two-key** fixture, since with one key a shallow and a per-key merge are indistinguishable. Why: the option reads like a filter and behaves like an override.
