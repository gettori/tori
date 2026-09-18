---
summary: plain grep treats CodeEditor.tsx as binary and skips it, use grep -a or tsc instead of trusting a grep sweep for usage
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 5 (personal/tori, branch `wave-6`); `src/panels/Editor/CodeEditor.tsx`; commit 2f3f046"
---

# `grep` skips `CodeEditor.tsx` as binary

Do NOT trust a plain `grep` sweep of this repo to prove a symbol is unused. `grep` treats `CodeEditor.tsx` as binary and silently omits it; `grep -a` finds it. Why: a phase concluded `editor-toggle-vim` emitted an event nobody listened to and removed the listener; `tsc` caught it, but a less type-visible removal would have shipped. Related to [[gotcha_a_raw_nul_byte_makes_git_treat_a_source_file_as_binary]], but this is grep's own heuristic, not git's.
