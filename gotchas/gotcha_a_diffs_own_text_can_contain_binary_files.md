---
summary: diff.contains("Binary files ") fires on a content line that says it; match git's unprefixed marker line instead
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1), phase provenance-core; src-tauri/src/provenance.rs (replay); the old agent_lines.rs had the same check"
---

# A diff's own text can contain "Binary files "

Do NOT detect a binary diff with `diff.contains("Binary files ")`. The resolver's own source file had that string in it, so its diff matched and the file read as binary with no claims at all. Why: git's marker is a line of its own with no prefix, while every content line starts with `+`, `-` or a space. Test `diff.lines().any(|l| l.starts_with("Binary files "))`.

## Related

- [[component_provenance]] where it bit
