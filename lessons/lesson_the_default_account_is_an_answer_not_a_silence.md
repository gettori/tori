---
summary: a value with a natural unset spelling needs three stored states, since nullish coalescing treats the default as nothing
status: current
updated: 2026-09-05
source: "plan \"Multi-account: pick, lock and default an account per session\" (personal/tori, branch `multiaccount`), phase 4; `src-tauri/src/settings.rs` (`ChatPrefs::profile`), `src/utils/agentHealth.ts` (`knownProfile`), `src/utils/agentEnabled.ts` (`draftChatProfile`)"
---

# Store "the default account" as a value, never as null

## What happened

A new tab picks its account from three layers: what this project last used, the agent's Settings default, the login the user already had. A tab spells the default account `null`, so storing the tab's spelling in `ChatPrefs` would have made "this project chose the default account" and "this project has never chosen" the same stored value, and the Settings default would have silently overruled a project that had answered.

## Why

`null` is a fine spelling for the default account at the spawn boundary, where being default *is* the variable left unset. It is a terrible spelling in storage, where absence already means something else. The reader has the same problem in the other direction: `knownProfile` has to answer three things (this account, the default account, no answer), because a two-answer function forces the caller into `a ?? b`, and `??` treats the default account as nothing and falls through it.

The same trap has a second face: writing the default account's id on a **one-account** install stores an answer the user never gave, which then outranks the per-agent default they set after adding their second login. So the write is gated on there being two accounts to tell apart ([[concept_naming_an_account_needs_two]]).

## What to do next time

When a value has a natural "unset" spelling *and* a layered fallback behind it, the store needs three states and the reader needs three returns. Write the explicit id (`"default"`), keep absence for "never answered", and cross between the two spellings at exactly one place per direction.

## Related

- [[concept_one_directory_two_spellings]] - the crossings, `asProfileId` and `asTabProfile`
- [[concept_the_account_is_half_the_key]]
- [[adr_account_is_session_identity]]
