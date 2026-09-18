---
summary: an account binds at spawn like the agent and stays fixed all session, beating a global switch or a model side pill
status: current
updated: 2026-09-05
source: "plan \"Multi-account: pick, lock and default an account per session\" (personal/tori, branch `multiaccount`), all four phases. Commits `8e670fb` (spawn and resume), `aa084e0` (catalogues), `0bac9e3` (the palette), `7b33143` (defaults); `src-tauri/src/chat/commands.rs`, `src-tauri/src/accounts.rs`, `src/panels/Terminal/Terminal.tsx`"
---

# An account is part of session identity, like the agent

A chat or agent session runs as one account of one agent, bound at spawn through the profile home variable, and it never changes for the life of that session. Fork and rewind inherit it, resume takes it from the transcript rather than from the caller, and a tab whose account has been removed is dropped rather than respawned on the user's own login. The alternative shapes were a global "active account" switch and an account pill beside the model pill; both were rejected.

## Considered Options

- **A global active-account switch** (rejected): it misdescribes what is on screen. Several sessions run at once and each is already bound to a login, so a single global answer would be wrong about every session but the last one started.
- **An account pill beside the model pill** (rejected): two controls that constrain each other. A catalogue is an account's answer ([[concept_the_account_is_half_the_key]]), so picking a model already picks an account, and a second control could only disagree with the first.
- **Account as session identity** (chosen): one pair, picked once, in the row that offers the models.

## Consequences

- **The backend is authoritative on resume.** `transcript_path` returns the root that matched, `resolve_profile(asked, found)` prefers it, and a caller naming a different account is refused. A caller that forgets to pass one still gets the right answer.
- **Removal has to see live sessions.** Chat claims and the PTY host's live table are asked together, in tab ids, because a fresh agent tab holds no claim until its session id exists.
- **Defaults are three layers, not a switch**: what this project last used, the agent's Settings default, the inherited login. See [[lesson_the_default_account_is_an_answer_not_a_silence]].
- **The default account stays the variable left unset**, which is what makes an existing login work with no migration. Only its *label* is stored, so renaming it changes a word on screen and nothing else. See [[adr_credential_custody]].
