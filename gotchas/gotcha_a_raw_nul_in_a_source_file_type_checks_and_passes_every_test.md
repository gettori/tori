---
summary: a literal NUL byte in source is invisible in editors and passes tsc and vitest silently
status: current
updated: 2026-08-27
source: Features phase 4 (#156), branch `feature-workspace`, `src/panels/Editor/SearchPanel.tsx` (`NUL`, `rootsKey`), `src/panels/Editor/searchResultsDoc.ts` (`markKey`), commits 92d697f and 9c7ce7a, _2026-08-27_
---

# A raw NUL in a source file type-checks and passes every test

Do NOT write a NUL separator as a literal into source. Why: a raw `U+0000` byte in a `.ts` file is **invisible** in every editor, `tsc` accepts it, `vitest` accepts it, and the only thing that reports it is `file` or `grep` going quiet on that path. It got in twice in one ticket by two different routes: first typed straight into a template literal in `rootsKey()`, then written by an editing tool that interpreted the escape `\u0000` into the byte it names. Name it instead (`const NUL = "\u0000"`) so the source says what the value is and a review can see it, and audit with a script rather than by eye. The separator itself is worth having: `rootsKey()` had been space-joining root paths, and a path containing a space can spell another root set's key.
