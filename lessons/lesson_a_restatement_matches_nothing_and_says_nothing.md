---
summary: a hand keyed model annotation matched nothing since the day it was written, since absence looked like a correct answer
status: current
updated: 2026-08-21
source: plan "The composer offers every lever the agent published" (phase 2, branch `unified-chat`); commit 7b9522b; `src-tauri/agents/claude.toml` (the retired `[[chat.annotations]]`); `src-tauri/src/chat/claude.rs` (`config_options`); `dev/fixtures/claude/initialize.jsonl`
---

# A restatement that matches nothing says nothing

Sway kept one hand-maintained fact about claude's models: which one has a fast mode. It was keyed `claude-opus-5`. The catalogue resolves **both** Opus rows to `claude-opus-5[1m]`.

So the lookup matched nothing. It had matched nothing since the day it was written, on every machine, and no test, type or guard said so.

## Why nobody noticed

Because the failure renders as **absence**, and absence was already a legitimate answer.

`config_options` produced a fast-mode row only for an annotated model. An id nothing matched produced no row, which produced no control, which is exactly what a model *without* a fast mode is supposed to look like. There was no state in which the bug was visible: a user looking at a composer bar with no fast-mode toggle was looking at the correct rendering of "this model has no fast mode" and at the broken rendering of "this model has one" at the same time.

The live session did show the toggle, which made it worse rather than better. `system/init` reports the bare `claude-opus-5`, and `model_options` falls back to a synthetic row carrying whatever id init named when the catalogue lookup misses. That synthetic row *did* match the annotation. So the draft showed nothing and the chat it became showed a toggle, and the two disagreeing looked like a draft-versus-session difference rather than a table that was never right.

## The part that was already predicted

[[lesson_a_declared_catalogue_describes_someone_elses_machine]] retired `[[chat.models]]` and ended on the right question: not "is this row correct" but **"how would it announce itself once it stopped being correct"**. That page then treated the surviving `[[chat.annotations]]` as the safe residue, because an annotation only decorates a model a catalogue named and can never invent a picker row.

That reasoning was sound about the danger it was aimed at and silent about this one. Constrained to decorating, the table could not add a wrong model; it could still fail to decorate the right one, and that failure has no symptom at all.

## What the fix was, and what it was not

Not a corrected key. The `initialize` catalogue **already publishes `supportsFastMode` per model** and always did, so the table was restating a fact its own source ships. The fix was to carry the flag onto `ChatModelInfo` and delete the table, the `ChatAnnotation` type, and the `annotations` parameter threaded through four modules. `pickableModels` lost its `chat` argument with it: that lookup was the only reader, so a model row is now entirely the agent's own answer about itself.

Correcting the spelling would have left a second copy of a published fact, keyed by hand, one rename away from silently matching nothing again.

## What to do next time

Before writing down a fact about someone else's program, ask whether that program already publishes it. `--help`, a handshake, a control response: read the source of truth before deciding it is not there. Both tables retired from this adapter turned out to be restating something the CLI says itself.

When a restatement genuinely is necessary, the key has to be **checked against the thing it keys into**, not merely spelled carefully. `[[chat.models]]` announced itself by being wrong in the product (200k beside a reported 1M). This one could not announce itself at all, because it was joined to a catalogue by a string and nothing ever asserted the join produced a row.

Generalises past adapters: this is [[lesson_a_rule_that_matches_nothing_passes_every_guard]] one layer out. There the selector resolved every token perfectly and reached no element; here the key was a valid string and reached no row. Any assertion that is only about spelling needs a companion that is about reachability, and **a lookup whose miss is indistinguishable from its correct empty answer needs a test that the hit happens.**

## Related

- [[lesson_a_declared_catalogue_describes_someone_elses_machine]] — the predecessor table, and the question this is the answer to
- [[lesson_a_rule_that_matches_nothing_passes_every_guard]] — the same shape in CSS, with the general form of the rule
- [[lesson_probe_the_capability_before_building_its_control]] — the fast-mode measurement whose refusal this row was carrying
- [[component_catalog_probe]] — where the published flag is cached now
- [[component_chat_model_resolver]] — which lost `fastModeFor` and a parameter with it
- [[concept_capability_resolution]] — the adapter ∩ live-catalogue rule the flag now feeds
