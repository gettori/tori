---
summary: a background subagent's task notification lands as a user turn, so a tag allowlist must cover it too
status: current
updated: 2026-09-04
source: "\"Subagent lanes in the chat panel\" (personal/tori, branch `bugfix-260903`); Phase 4; `src-tauri/src/sessions.rs::task_notification`, `dev/fixtures/sessions/subagent-background.jsonl`; commit d1bdc8f"
---

# A backgrounded subagent's ending arrives as a message under the user's own role

When a `run_in_background` subagent finishes, the CLI writes its ending into the **session transcript** as a `user` record whose content is a `<task-notification>` XML envelope: `<task-id>`, `<tool-use-id>`, `<status>`, `<summary>`, `<result>` and a `<usage>` block. It is one machine talking to another, written for the model to read, and the person never typed it.

`is_human_prompt` already excluded it from the counts, because it rejects anything starting with `<`. `turn_from_line` did not, because `is_command_envelope` matches six specific `<command-*>` tags and this is not one of them. So the same file gave two answers: the prompt count was right and the replayed conversation showed the raw envelope as the user's own message. It is now its own turn role (`subagent`), which also takes it out of `prompt_boundary`'s rewind candidates, since it was never a boundary anyone could mean.

The general shape is worth more than the tag: when one file has two readers and one of them filters, check the other filters the same things. A filter that is a list of literal tags will not cover a seventh.
