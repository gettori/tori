---
summary: claude's task_started channel carries backgrounded shell commands too, discriminate on task_type not on one seen value
status: current
updated: 2026-09-04
source: "\"Subagent lanes in the chat panel\" (personal/tori, branch `bugfix-260903`); follow-up after phase 6; `src-tauri/src/chat/claude.rs::map_task_started`, `dev/fixtures/claude/background-shell.jsonl`"
---

# Not every task on Claude's task channel is a subagent

`system/task_started` and its `task_progress` / `task_updated` / `task_notification` siblings describe **tasks**, and a subagent is only one kind. A backgrounded `Bash` call rides the identical channel. The discriminator is `task_type`: `local_agent` for a subagent, `local_bash` for a shell command. A shell task also carries neither `subagent_type` nor `prompt`, so a mapper reading those gets empty strings rather than a signal.

Missed because it looked like a constant. Every fixture captured while building the lane strip was a subagent, so `task_type` read `local_agent` in all of them and was dropped from the mapper as noise. It shipped, and the first real session that backgrounded a shell command put "Wait 90 seconds in backgro..." on the lane strip as a subagent, with a "Read what this subagent did" link to a transcript that does not exist.

Key on the known-good value (`task_type == "local_agent"`) rather than on a denylist, so an unrecognised kind gets no lane instead of a wrong one. The general shape: **a field that is constant across every sample you captured is not a constant, it is a field you have only seen one value of.** Ask what else could be on the channel before deciding a discriminator is noise.
