---
summary: an ACP switch promise resolving means only that the request exists, not acceptance, so a .then can record a refusal
status: current
updated: 2026-09-04
source: plan "Confirm an ACP mode or model switch from the agent's own answer" (personal/tori, branch `bugfix-260903`, issue 164, commit 1aedc0b), `src/panels/Chat/ChatView.tsx` (`recordConfirmed`, `askedMode`), `src-tauri/src/chat/acp_transport.rs:413`, [[concept_acp_config_options]], _2026-09-04_
---

# An ACP `chat_set_mode` or `chat_set_model` resolving is not acceptance

Do NOT record, hold a message on, or settle anything in the `.then` of an ACP switch invoke. Why: `chat_set_mode` resolves on staging (the mode is held and sent with the next prompt) and `chat_set_model` on enqueue (`send_command` is an `unbounded_send`), so the resolved promise means "the request exists", and the agent's answer arrives later as a `configOptions` event, or a `ModeRefused`. Recording on `.then` wrote a refused mode into the tab's draft pick and the project prefs, so every later draft in the project reopened on it. `pickRidesArgv` is the switch: claude's resolved invoke is acceptance, ACP's is not. The opening-pick comment in `ChatView.tsx` says the invoke can only reject a switch the transport refuses synchronously (`Switch::Unsupported` or `Unknown`).
