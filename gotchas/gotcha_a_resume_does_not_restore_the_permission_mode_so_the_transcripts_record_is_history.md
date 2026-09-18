---
summary: claude's resumed session answers permission mode default with no flag, so the jsonl transcript names history not now
status: current
updated: 2026-09-04
source: plan "Seed a chat's mode and model from the pick that spawned it" (personal/tori, branch `bugfix-260903`, issue 163), `src/panels/Chat/ChatView.tsx` (the seed block, `shownModel`), [[component_chat_panel]], _2026-09-04_
---

# A resume does not restore the permission mode, so the transcript's record is history

Do NOT rebuild a session's *current* mode from its transcript. Measured on claude 2.1.259: the jsonl does record `permissionMode` on every `type: "user"` line (plus `effort` and `message.model` on every `assistant` line, and a bare `{"type":"permission-mode"}` line on a mid-session switch), so the data is right there and looks authoritative. It is not. Start a session `--permission-mode plan`, land a turn, then resume it with no mode flag: `system/init` answers `permissionMode: "default"`. The CLI does not carry the flag across a resume, so the transcript names what past turns ran under and never what the child in front of you is in. Only whatever Tori put on the argv knows that, which is the tab's `draftPick`. `--model` is the exception: a resume does bring it back and reports it on init.
