---
summary: grep here skipped CodeEditor.tsx as binary and printed nothing, making the agent gutter look unwired; count with python or rg -a
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1), self-review of phase provenance-core; src/panels/Editor/CodeEditor.tsx"
---

# grep here skips files it thinks are binary

Do NOT trust an empty `grep` over `src/panels/Editor/CodeEditor.tsx`. The shell's grep classified it as binary and silently matched nothing, so `agentLinesFor` and `setAgentMarkers` looked like they had no caller and the gutter looked dead when it was wired. Why: an empty result reads as "not there" whether the file was searched or skipped. Confirm absence with `rg -a`, `grep -a`, or a python count before acting on it.

## Related

- [[concept_line_provenance]] the gutter that looked unwired
