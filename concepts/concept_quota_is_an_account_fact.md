---
summary: quota windows are filed per (agent, account), and which usage chips are lit also decides how deep the source reads
status: current
updated: 2026-09-06
source: "Agent usage preview plan (personal/tori, branch `agent-usage`), phases 1 to 5 and the design pass after them . PR #169 . `src/utils/usageStore.ts:117` . `src/utils/usageSettings.ts:85` . `src/utils/chatRateLimit.ts:101`"
---

# A quota window is a fact about a login

Everything Tori knows about quota is filed per (agent, account), because that is the unit the thing itself has: two Claude logins on one machine hold two five-hour windows on two plans, and three chats open on one of them are three views of a single number. A per-chat store would show the same figure three times and still not answer "how much is left", and a per-agent one could only ever describe one of the two logins. This is [[concept_the_account_is_half_the_key]] applied to a quota, and the account settings followed the data: the windows an account shows, its warn point and its notify switch all live under `agent.usage.accounts.<id>`, never under the agent.

The surprising half is that the display setting and the read depth are the same setting. Which windows an account puts in the titlebar is also how deep Tori reads for it: nothing lit means nothing is read, the two generic windows come off whatever rung the adapter offers for free, and the model-scoped weekly window is the one thing only the account token can answer. So the rung is derived from the chips rather than stored beside them, and there is no separate source control to disagree with what is on screen.

## How it works

**The store.** `usageStore.ts` holds `Record<AccountKey, Record<kind, WindowReading>>`, where `AccountKey` is the agent and the account joined by U+0000 (`usageStore.ts:58`, built with `String.fromCharCode(0)`, never typed, see [[gotcha_a_raw_nul_in_a_source_file_type_checks_and_passes_every_test]]). `recordReadings` (`usageStore.ts:117`) folds a source's answer in **per kind and only forward**: it updates the kinds the sample names and leaves the rest alone. That is what lets a passive frame carrying two windows land on an account whose third window came from a deeper read without blinking it out every turn. It is also the rule behind the one that matters most: **a window is missing only when nothing has ever returned it**, so absence is a property of the source and never a level of zero. A Pro account shows no empty Fable bar.

**Two vocabularies of state, and they answer different questions.** `quotaState` (`chatRateLimit.ts:101`) is `ok | approaching | reached | expired`, resolved in that precedence: expiry first (a level from a window that has since reset is a memory, and checking it after `reached` kept a banner up for hours past the reset that cleared it), then the source's own refusal, then the account's threshold. `temporalOf` (`usageStore.ts:161`) is `live | stale | expired`: how much of the reading can still be believed. The two are orthogonal on purpose. Old and wrong are drawn differently everywhere, a stale reading keeping its number and dimming while an expired one loses the number and says "reset".

**Colour is a third thing, and fixed.** `quotaBand` (`chatRateLimit.ts:133`) is `clear | warm | hot` at 60 and 80 percent, with a source's own refusal always hot. It deliberately does not read the account's warn point: warn-at governs when Tori **says** something (the chat's banner, the OS notification), while the band is a scale the eye reads without a legend. A user who moved their warn point to 90 still wants a bar at 85 to look like one. Green paints the bar alone; warm and hot take the figure with them.

**The chips are the control.** `accountWindows` (`usageSettings.ts:85`) resolves the stored list, and `usageRungFor` (`usageSettings.ts:103`) derives the rung from it: no rung declared or nothing lit is `off`, the model chip plus a declared `token` rung is `token`, otherwise the cheapest declared rung. Because the model chip is what authorises the Keychain read, pressing it is the entire opt-in, and the backend re-reads that same stored chip before it touches the vault (`settings.rs:595`, `usage_token.rs:216`), so nothing enters the vault on the frontend's word. See [[adr_usage_source_ladder]].

**Absence of an answer is not "off".** No stored entry resolves to the two generic windows, because that reading costs nothing and needs no permission; an empty list is the user's own no, and no later adapter bump undoes it. Writes patch one named field at a time (`usageSettings.ts` `patchAccount`), so answering "notify off" does not freeze in the window list that happened to be on screen. This is [[lesson_the_default_account_is_an_answer_not_a_silence]] a second time: absence and a chosen value must not be the same stored thing.

**One window, three names.** `chatRateLimit.ts:187` and its siblings give every window a card name (`Session . 5h rolling`), a titlebar letter (`5H`, `W`, `F`), a settings-chip word (`5H`, `Week`, `Fable`) and a sentence form (`your rolling 5-hour limit`). Four lengths because no card name survives being dropped into "your ... limit", and the strip is scanned while the chat's notice is read. The model-scoped window's name is learned at read time from the endpoint's own `display_name`, so there is no list here that could go stale against it.

## Why it's this way

The alternative shape, one reading per chat, is what the first sketch had, and it is wrong in a way that only shows up with two logins or three tabs. The account is the unit the vendor bills, resets and refuses on.

Deriving the rung instead of storing it came out of a user question that had no good answer while both existed: if the source ladder says `sessions` and the chips light the model week, which one is true? Making the chips the only control removed the question rather than answering it. The cost is that one control now carries two meanings, which is why the settings chips are words while the titlebar is letters: the control has to read before the strip's shorthand has been learned.

The fixed colour ladder was a later correction. Bands originally came off `quotaState`, so an account with a warn point at 90 had a bar that stayed green at 88, which is the one moment colour exists for.

## Related

- [[component_usage_pipeline]] - the sources, the store and the notification that fill this model
- [[component_usage_strip]] - the two surfaces that draw it
- [[adr_usage_source_ladder]] - the decision about where readings come from, and the Keychain opt-in
- [[concept_the_account_is_half_the_key]] - the general rule this is one more instance of
- [[concept_spend_ceilings]] - Tori's own ceilings, which share the three-state vocabulary and not the source
- [[lesson_the_default_account_is_an_answer_not_a_silence]] - absence and a chosen value must differ in storage
- [[gotcha_a_raw_nul_in_a_source_file_type_checks_and_passes_every_test]] - the account key's separator, hit three times on this ticket
