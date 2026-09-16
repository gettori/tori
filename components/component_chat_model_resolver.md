---
summary: the one module every chat control reads for model and context, ordering live handshake data over cache over nothing
status: current
updated: 2026-09-04
source: originally plan "Make the session controls tell the truth about the CLI" (branch `chat`); reshaped by "Model catalogues from the harnesses themselves" (phases 2 and 4, branch `settings-and-chat`), then by "The composer offers every lever the agent published" (phases 1 and 2, branch `unified-chat`, commits 88713c9 / 7b9522b)
---

# Chat model resolver

**Location:** `src/utils/chatModels.ts` and `src/utils/modelCaps.ts`

The one module that decides what a chat session's controls may offer and what they show. The model picker, the effort control, the permission-mode menu, the context meter and the budget ceiling all read it, because four readers reaching into two differently-shaped sources is how they end up offering a model one of them cannot resolve - which had already happened: the same session rendered 200k in the composer and 1M in the status strip.

## Responsibilities

- Order the **live catalogue** (from the handshake, authoritative about what this machine's CLI can run) ahead of the **probe cache** ([[component_catalog_probe]], what the harness said last time it was asked), ahead of **nothing**. The adapter's `[[chat.models]]` table is gone; see [[lesson_a_declared_catalogue_describes_someone_elses_machine]].
- Resolve every control's offer as adapter declaration ∩ live model flags - see [[concept_capability_resolution]].
- Resolve the context window in a stated order, and return null rather than guessing.
- **Not** its business: fetching anything. `modelCaps.ts` owns the one network call and only reaches for it as a last resort.

## Key entry points

- `pickableModels(live, cached, reported)` - the offer list. Live first, then the probe cache, then nothing; deliberately **not** a merge, since folding one list into the other would re-offer a model the CLI no longer has. A cached row and a live row are the same JSON on purpose, which is what makes "cache fills in before a session exists, live wins after" a swap of source rather than of shape. **It takes no adapter any more:** the only thing it read from one was the fast-mode annotation, and the handshake publishes that flag itself, so a row is now entirely the agent's own answer about itself.
- `capabilitiesFor(model, chat, live)` -> `{ modes, fastMode }`. Filters modes by their declared `requires` flag against the model's live capabilities. **The `live` list is not optional in practice**: every ACP adapter declares an empty `[[chat.modes]]` on purpose, so omitting it makes every one of those agents read as having no modes at all. It was omitted at three sites until the draft work; see the gotcha below.
- `cachedModes(catalog, chat)` -> `{ modes, current }`. The pre-session half of what `pickableModes` and `ChatView`'s `shownModeValue` do together, for a draft that has no session to ask. An **ACP** agent's rows come from the probe cache and the mode it opens in from the `mode`-category option's `current`; a **declared-mode** agent (claude) gets the adapter's rows and `defaultMode`'s pick. No rows and no current for an agent that has neither, which renders no selector rather than an empty menu.
- `contextWindowFor(resolvedModel, reported)` - three steps now that no adapter declares a window: what the session reported → `foreignWindow` for non-Claude ids → null. **A Claude session therefore shows no denominator until turn one completes**, which is the accepted cost of not shipping a number that was measurably wrong.
- `reportedWindows(extra)` - reads `result.modelUsage`, keying each window under both the map key and `canonicalModel`, because they differ (`claude-haiku-4-5-20251001` vs `claude-haiku-4-5`) and either may be what `system/init` reports back.
- `contextPercent(used, window)` - null when the numbers contradict each other, never a clamp.
- `modeAfterModelSwitch(model, chat, current)` - re-resolves a mode the new model does not support, falling back to the default among what is still offered.
- `selectedModel(models, picked, resolvedModel)` - `value` and `resolvedModel` are separate fields on purpose; several values resolve to one id, so init alone can never say which was picked. **`picked` is matched first and returns before `resolvedModel` is looked at**, which is what makes the `picked` slot unsafe for a provisional value: anything put there outranks the session's own report until something clears it. `ChatView`'s `shownModel()` therefore calls this three times in a ranked chain rather than once; see [[gotcha_a_store_field_with_one_writer_cannot_double_as_a_provisional_value]].

## Things that bite

- **`value` is not `resolvedModel`.** Comparing a pick against `system/init.model` is the trap the two separate fields exist to prevent. Among several values sharing one resolution, prefer the one that *names* the model over the generic alias, or a fresh session shows "Default" while the toolbar shows "fable-5".
- **The adapter's context windows are gone, because two of three were measurably wrong** (200k written down for models the harness runs at 1M). `foreignWindow` in `modelCaps.ts` survives on purpose: it is a window lookup for a model some catalogue already named, never a source of models, and it answers for non-Claude ids only.
- **Fast mode comes off the model's own row**, as `supportsFastMode` on the handshake catalogue. It was an annotation in `[[chat.annotations]]`, keyed by `resolvedModel`, and the key never matched: the table said `claude-opus-5` while the catalogue resolves both Opus rows to `claude-opus-5[1m]`. `fastModeFor` is gone with it. See [[lesson_a_restatement_matches_nothing_and_says_nothing]].
- **A percentage above 100 is a contradiction, not a value to clamp.** See [[gotcha_a_figure_re_read_from_a_file_lags_the_event_that_triggered_the_re_read]] for the related lag that produces mismatched pairs.
- **`modelCaps.ts`'s request latch is module state that outlives a test**, so the second test in a file to want caps never calls out. `__resetModelCapsForTests()` exists for that; without it a "makes no network call" assertion is a claim about test ordering.

- **`restoredPicks` has a production caller now**: `ChatDraft` opens each draft on the project's last-used pick, checked against the catalogue rather than trusted. It takes the agent's own `live` modes as a fourth argument for the reason above - without them a remembered ACP mode is checked against an empty adapter table and dropped on every read.

Related: [[component_chat_panel]], [[component_agent_adapter_registry]], [[concept_capability_resolution]], [[component_catalog_probe]], [[lesson_a_declared_catalogue_describes_someone_elses_machine]].
