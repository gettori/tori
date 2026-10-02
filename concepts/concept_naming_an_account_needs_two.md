---
summary: namedProfiles returns empty until there are two accounts, so every surface stays silent on a single-account install
status: current
updated: 2026-09-05
source: "plan \"Multi-account: pick, lock and default an account per session\" (personal/tori, branch `multiaccount`), phases 2 and 3; `src/utils/agentHealth.ts` (`namedProfiles`, `profileLabel`), `src-tauri/src/sessions.rs` (`profile_label`)"
---

# Naming an account only means something when there are two

"Default" is a word for the only thing there is. On an install with one login, every surface that could name the account renders exactly what it rendered before accounts existed; the moment there are two, the same surfaces name them. The rule is written once, in `namedProfiles`, and every surface spreads that list rather than counting accounts and deciding again.

## How it works

`namedProfiles(agentId)` returns the sweep's accounts for that agent, or an **empty list** when there is only one. Callers spread it and fall back to one unnamed row:

- The palette emits one provider row per account, or `[null]` for the plain row (`agentPaletteData.ts`).
- The model pill appends the account ("Opus / Globex") only when the list is non-empty (`ModelPicker.tsx`).
- The launch menu is one Claude row per account, in a single parenthetical ("Claude (Globex, terminal)"), or the bare name.
- The Agents card shows the plan and the Default radio only where there is a choice.
- The project's remembered account is written only for an agent that has two, so a one-account install stores nothing and a Settings default set later still applies.
- `sessions.rs::profile_label` applies the same rule to session rows, so History says nothing on a single-account machine.

## Why it's this way

A label nobody can act on is noise, and on one-account installs (which is most of them) every one of these surfaces would grow a word that never changes. Deciding it once also keeps the surfaces honest with each other: the picker cannot name an account the session header is silent about.

The cost is that `namedProfiles` reads the health sweep, so a surface that never loaded it answers "one account" forever. `Terminal` had exactly that bug until it called `ensureAgentHealthLoaded` beside `ensureAdaptersLoaded`.

## Related

- [[concept_the_account_is_half_the_key]] - what is filed per account
- [[component_agent_health_cards]] - the sweep this reads
- [[adr_account_is_session_identity]]
