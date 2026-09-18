---
summary: a wildcard asset protocol scope cannot reach a dot directory on Unix, name the dotted path explicitly instead
status: current
updated: 2026-09-04
source: "\"Labelled path attachments in the chat composer\" (personal/tori, branch `bugfix-260903`), follow-up after phase 3, `src-tauri/tauri.conf.json`, _2026-09-04_"
---

# An asset-protocol scope cannot see a dotted directory

Never expect `"scope": ["**"]` to reach a file under `~/.config` or any other dot directory: the request is denied and the only sign is a broken image in the webview. Why: Tauri's fs scope defaults `require_literal_leading_dot` to true on Unix, so a component starting with `.` matches only a pattern that spells it out (`tauri-2.11.3/src/scope/fs.rs:214`). Name the path in the scope (`$HOME/.config/tori/**`) rather than turning the flag off, which would open every dotfile on the machine.
