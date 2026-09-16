---
summary: macOS PTY canonical mode buffers a typed line and silently truncates past a per-line limit, write long values to a file
status: current
updated: 2026-07-18
source: "Prove the adapter: opencode + claude hooks (personal/sway, branch `topbar`); Phase 3 (post-review live bug report); `src-tauri/src/hooks.rs` (`write_claude_settings_file`)"
---

# A PTY's canonical mode truncates a single long typed line

Do NOT pass a large value (a KB+ blob) as one argv element of an agent's `init` command; every agent tab's launch command is typed into its login shell byte-by-byte via `pty.rs`'s `deliver_init`, not passed as real argv. Why: macOS PTYs default to canonical (cooked) line-discipline mode, which buffers a line in the kernel up to a hard per-line limit and silently truncates/drops bytes beyond it — a shell-quoted ~2KB inline `--settings <JSON>` value landed on an unclosed quote mid-line, so the command appeared on screen but the shell just sat waiting for the closing quote (visible as a stuck prompt, `enter` doing nothing). If a value must be long, write it to a file and pass a short path instead.
