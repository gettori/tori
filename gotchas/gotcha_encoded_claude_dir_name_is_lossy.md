---
summary: the encoded claude projects folder maps slash and dot both to a dash and cannot be reversed, read cwd from the jsonl
status: current
updated: 2026-06-28
source: Sway build plan (personal/sway); `src-tauri/src/sessions.rs` (`parse_session`); commit e121aeb
---

# Encoded Claude dir name is lossy

Do NOT reverse-decode `~/.claude/projects/<encoded-cwd>/` to recover a project path; read `cwd` from inside the `.jsonl` instead. Why: the encoding maps both `/` and `.` to `-` (e.g. `/Users/skarif/.dotfiles` becomes `-Users-skarif--dotfiles`), so the folder name cannot be uniquely reversed.
