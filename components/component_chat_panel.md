---
summary: chat panel folds live and replayed events through one applyEvent reducer, so history and a running turn render alike
status: current
updated: 2026-10-02
source: "plan \"Chat composer Tier 1, spell check, safe sends, draft tooling\" (branch `composer-260907`), commits 39a05ac, face7c4, c3eb12f, 8e8579e; plan \"Multi-account: pick, lock and default an account per session\" (branch `multiaccount`), phases 3 and 4, commits 0bac9e3, 7b33143; `src/panels/Chat/`"
---

# Chat panel (Solid)

**Location:** `src/panels/Chat/` (key files: `ChatView.tsx`, `chatStore.ts`, `MessageList.tsx`, `Composer.tsx`, `composerScratch.ts`, `ToolCallCard.tsx`, `SessionInfo.tsx`, `PermissionPrompt.tsx`, `QuestionCard.tsx`, `ModelPicker.tsx`, `StatusStrip.tsx`, `SessionStats.tsx`, `LaneStrip.tsx`) plus `src/utils/chat*.ts`, `src/utils/composerFence.ts` and `src/utils/sessionSurface.ts`

The frontend half of the chat surface: a tab kind beside `shell`, `agent` and `command` that folds [[concept_transport_neutral_event_model]] events into a transcript, and is the default surface a click on a sidebar session opens.

## Responsibilities

- Fold live and replayed events through **one** reducer (`applyEvent`), so history and a running turn render identically.
- Own the composer, the tool cards and their inline diffs, the permission prompts, and the model/effort/mode pickers.
- Route a session selection to the right surface, and never open a second driver for a live session.
- **Not** its business: it hosts no PTY, so `pty_write` at a chat tab's id would land nowhere while reporting success.

## Key files & entry points

- `chatStore.ts` - `ChatState` plus the pure `applyEvent` reducer. Items are append-only, so `toolIndex` can hold indices for the life of the session. `visibleItems` is the view filter that folds Tori's own hook rows away.
- `ChatView.tsx` - the panel: connection, send, approvals, forking, and the memoized `shownItems`.
- `MessageList.tsx` - windowed (not virtualized) transcript, sticky-to-bottom only while already at the bottom.
- `SessionInfo.tsx` - collapsed disclosure listing MCP servers, skills, agents and plugins, and the add/remove surface for project-scoped MCP servers.
- `sessionSurface.ts` - the routing core, below.
- `chatCapabilities.ts` - narrows the untyped `extra` payloads (`skills`/`agents` are string arrays, `plugins` are objects).

## Surface routing

`routeSelection` takes three inputs: the user's `chatDefaults.defaultSurface`, whether a tab already hosts the session, and whether it runs outside Tori.

- A session already hosted **focuses**, never opens twice: two drivers on one id measurably corrupt the transcript.
- A session **running outside Tori falls back to the PTY route regardless of the preference**. This is not a downgrade of the setting: chat drives a session by *resuming* it, and resuming a live one is the exact operation measured to corrupt it.
- `restoreRoute` is a separate function that takes the stored tab kind and **deliberately has no preference parameter**, so a saved workspace of agent tabs reopens as agent tabs. It exists as a named function rather than as the absence of a call so a test can hold the invariant.

## Notable decisions

- **The mode is never set from a click.** `permissionMode` only ever comes from the child's own re-declaration; a pick lands in `pendingMode` and is cleared when a turn confirms it. A CLI that ignores the switch leaves the control honestly pending rather than lying.
- **A replayed user turn does not set `awaitingTurn`.** Replayed history is finished; marking it in flight leaves a reopened tab reading as busy with nothing running.
- **Tori's own hook rows are folded by default**, never dropped from state, so the toggle works mid-session. See [[lesson_identify_your_own_hook_rather_than_inferring_it]].
- **Chat status is exact, and marked as such.** It reaches Rust as a reported fact (`rpc_session_facts`) and is the first tier the dot composition reads, ahead of the PTY-activity and pgrep tiers; only the exact side is marked, leaving inferred rendering byte-identical (see [[concept_evidence_tiered_attribution]] and [[concept_needs_you_floor]]).
- **Code blocks are not syntax-highlighted.** Chat matches [[component_markdown_preview]]'s treatment exactly; real highlighting needs a new dependency and is an open scope decision.

## The differentiator surfaces (2026-07-29)

Five features landed on this panel in one ticket, each with its own page:

- **Diff view** ([[concept_diff_as_transcript]]): a toggle on the existing
  transcript reading the session as an accumulated per-file diff, rendered
  through the shared `DiffRows` extracted from `ReviewPanel`.
- **Rewind** ([[concept_rewind_by_fork]]): offered on the turn header of turns
  this tab ran, with a persisted banner and a seeded first message. The admission
  that the forked agent still remembers the undone turns is stated in all three
  places and `rewind.test.ts` asserts each one still says it.
- **Budget ceilings** ([[concept_spend_ceilings]]): `chatBudget.ts`, enforced at
  the turn boundary and addressed to the user only.
- **Steer** ([[concept_mid_turn_steer]]): the composer sends into a running turn
  instead of queuing behind it, and a refused steer restores the draft rather
  than eating it. The steer keeps a user row, indented and labelled, and opens no
  turn group, since `turnOpeners` counts assistant-side rows only.

Two panel-wide traps came out of this work:
[[gotcha_a_solid_component_that_early_returns_on_a_prop_freezes_at_mount]] and
[[gotcha_solidjs_testing_library_unmount_does_not_run_oncleanup]].

## The status strip reads live, with one exception

The strip's figures (`SessionStats`) used to come entirely from `chat_session_detail`, a re-scan of the transcript file. Context, prompts, tool calls and compactions now come off the store instead, because the scan lags the event that triggers it - see [[gotcha_a_figure_re_read_from_a_file_lags_the_event_that_triggered_the_re_read]]. **Turns is deliberately still scanned**, since replayed history carries no turn frames and `turnsCompleted` would collapse a resumed session's count.

Two related moves in the same pass:

- `SessionStats` is **handed** a resolved context window rather than working one out, so the strip and the composer cannot show two denominators for one model. Resolution lives in [[component_chat_model_resolver]].
- `ModelPicker` lost its context meter entirely. The readout belongs in one place, and the strip is where the session's figures are read. The strip also dropped its session token total, which duplicated `UsageReadout`'s figure in the overflow menu minus that one's cost, turn count and "counts only the turns this chat watched finish" caveat - the version most likely to be misread, sitting beside a context figure that measures something else.

## The question row, and the transcript's tiers (2026-08-22)

A seventh item kind, `question`, for a form the agent asked and the user answers in place. The mechanism is [[concept_inline_agent_question]]; what belongs to this panel:

- **The tool card is suppressed at `toolCallStarted` and again at `toolCallCompleted`**, because `ensureTool` creates on miss, so the completion alone would resurrect the card the declaration refused to make, carrying the answer string as a denied call.
- **Suppression is keyed on the parse, not on the tool name.** An `AskUserQuestion` whose input cannot be read falls back to an ordinary tool card rather than becoming an empty form. See [[lesson_a_partial_form_answers_a_question_nobody_saw]].
- **`ensureQuestion` adopts an existing tool card for the same id**, in place, since both indexes are positions into `items`. The window is real: the backend reads the setting at spawn and the store reads it at mount, so a tab switch after a settings flip leaves the two disagreeing.
- **A replayed question is read only because its `requestId` is null**, not because of a second flag that could disagree with it. `history.rs` emits no `questionRequest`.
- The form is built from [[component_radio_group]], with an always-visible Other box per question: 17 of 411 measured results carried a value matching no declared option, which a pick-only form could not produce.

**The blocking tier.** The permission prompt and the question card both stop the turn, and both spelled that out as `--brand-default` over `--canvas-card`, which is the colour the chat pane itself paints. Four roles carry it now (`blocking.surface`, `blocking.border`, `blocking.fg`, `blocking.accent`), and check 10 of `scripts/check-tokens.mjs` holds the pair to one declaration set and keeps every other rule in `Chat.module.css` off it. The fill lift is bounded by the recessive text inside the cards, see [[lesson_a_new_surface_leaves_its_text_unmeasured]].

**The ambient rows say what kind they are.** Thinking, hook and notice rows were one undifferentiated grey line on `--fg-subtle`, the tier meant for timestamps and held to 3.0 rather than 4.5. They moved to `--fg-muted` and each took a glyph (Brain, Webhook, Info, TriangleAlert), all `aria-hidden` because the label beside each one already says it. The hook glyph deliberately does not change on failure: it says a hook ran, and the colour and the stderr say how it went.

## The lane strip (2026-09-04)

A row above the composer, `main` plus one chip per live subagent, `Opt+1..9`. The model is [[concept_subagent_lanes]]; what belongs to this panel:

- **`items` finally is append-only, and the lane work needed it to be.** `turnCompleted` used to splice an unsettled compaction row out, despite `toolIndex` documenting the array as append-only. It marks the row `hidden` now and the view drops it, which is how hook rows were already handled. That repair and the next one are one change: `openTextId` became `openText`, an **index** into `items` per lane, and an index is only safe once nothing splices. Per lane because the old check was "is the last item still the open one", and a card arriving from a lane the reader is not even looking at makes the answer no, which split one sentence across two rows.
- **`Opt+N` is bound in `LaneStrip`, not in `commands.ts`.** The global table would have to know which chat is on screen; the strip already does, and arms its listener only when `active`. Matched on `e.code`, since macOS rewrites `e.key` while Option is held.
- **The composer stays bound to main in every lane**, with a placeholder saying which lane is being watched and the steer timing text suppressed outside main.
- **The Diff view is handed `state.items`, not `shownItems()`.** It reads `items` for one thing, `reasoningFor`, and a lane-filtered list is one the card being asked about is not in. `reasoningFor` itself became lane-aware in the same pass, or a subagent's edit would have quoted the main agent's last paragraph as its reason.
- **An agent-initiated turn is kept out of `promptTurns`.** A background subagent finishing makes the CLI open a turn Tori never sent; letting it claim the pending prompt would make "rewind to here" restore the tree as it stood *after* the turn the reader meant. It still reaches the spend ceiling, which is the point (see [[concept_spend_ceilings]]).
- **`toolCallsSeen` is scoped to the main lane; `promptsSent` is deliberately not.** Nothing can talk to a subagent, so a `user` row is the main agent's by construction, and scoping it would be dead code pretending to be a guard.
- **The strip has two groups and one of them is not clickable.** Lanes are buttons; the agent's other background work (a `run_in_background` Bash, measured as `task_type: "local_bash"`) is a labelled group of spans, present only while it runs. Both wrap onto their own lines. A span rather than a disabled button because there is nothing behind it to open, and check 11 covers the new rules so neither group can paint a surface the contrast gate has not measured.
- **The strip paints no new surface.** A chip is transparent unselected and `--neutral-hover` selected, the two surfaces `contrast.ts` already measures `fg.default` and `fg.muted` against, so check 11 of `check-tokens.mjs` pins the *absence* in both directions. Check 12 then holds the strip's four tones to the status strip's, since the two sit at opposite ends of one panel and are read in one glance.

## Attachments in the composer (2026-09-04)

Every attachment is now a labelled token the sentence can name (`[Image 1]`), not a chip standing beside the words. The model is [[concept_labelled_attachments]]; what belongs to this panel:

- **A chip is a container with two controls.** The body inserts the token (click, or drag under the private MIME `application/x-tori-attachment-token`, checked in `onDrop` before files and paths) and the remove button strips the attachment and every occurrence of its token. A chip with no token, a selection or a hunk comment, renders its face as a span rather than a dead button, so the strip keeps one shape without inventing a control.
- **The body shows the thumbnail and the token together.** A bare picture cannot tell the reader what to type. That is what made the stored filename visible on screen, and why the store keeps a directory per attachment rather than prefixing the name.
- **The removal rule lives in the store, not the composer** (`dropPending`), because the draft text lives there and the same rule has to hold for every surface that composes.
- **The prompt bubble draws a token back as a chip only when the turn carries a ref with that label.** A bare `[Image 9]` stays text. An attachment the sentence never named is appended as its token, so attaching a file and pressing Enter still leaves a visible trace.
- **The attach control names what this agent can open** and is disabled outright where nothing can be uploaded. Giving the hidden file input the same accessible name is also what let the chip's axe scan run: it had been failing on that input's missing label, a violation older than this work.
- **A send waits for the label seed.** `ChatView` seeds the counters inside the same `edit` that applies `chat_history`, and an ACP chat raises them from its replayed user turns instead, since that transport has no transcript to read.

## What a tab opens on (2026-09-04)

`system/init` declares the model and the permission mode **per turn**, so a tab that has just mounted has been told nothing and its pills described nobody until the next turn landed. Three seeds in `chatStore.ts` close that window from the tab's `draftPick`, which is the only thing that knows: it is written on every accepted live switch and it rides argv on the spawn.

- **`seedEffort` is ungated; `seedMode` and `seedModel` are gated on `pickRidesArgv`.** An ACP pick is a request sent after the session opens and can be refused, so seeding a mode there would name one nothing has applied. Effort is deliberately the exception: nothing else ever writes `s.effort` on the ACP path, so gating it would blank that pill for the whole session rather than for a moment.
- **`seedMode` writes `s.permissionMode` and self-corrects**, because `noteMode` writes it unconditionally at the next boundary. `seedModel` cannot do the same and gets its own `openingModel` field; see [[gotcha_a_store_field_with_one_writer_cannot_double_as_a_provisional_value]].
- **`shownModel()` ranks four sources**, most-trusted first: a pick this tab sent (resolved against the id the child reported), the reported id alone, `openingModel`, then the transcript scan's `detail()?.model`. A spawn re-declares the model the transcript predates, which is why the seed outranks the scan; the child's own report outranks both.
- **Seeding in the component body is only safe because replay emits no `sessionStarted` and no `turnStarted`.** If `events_from_turns` ever gains them, the backfill will clobber every seed.
- The transcript is **not** the source for any of this: see [[gotcha_a_resume_does_not_restore_the_permission_mode_so_the_transcripts_record_is_history]].

## The composer's Tier 1 (2026-09-07)

Seven changes to the input box, all of them **on the existing textarea**. The surface question (overlay, or CodeMirror) was asked and answered no; see [[lesson_keep_the_composer_a_textarea_until_colour_is_the_ask]].

- **Enter inside an open code fence adds a line rather than sending**, and `Cmd+Enter` sends from anywhere, including over an open completion menu. The keydown reads the textarea's own value and caret; a separate caret signal drives the hint line and the send label, so a restored draft that ends inside a fence shows no hint until the caret first moves while Enter still behaves. `insideFence` (`src/utils/composerFence.ts:9`) is pure and caret-based on purpose, so a future editor surface calls it from a keymap.
- **A paste over 30 lines or 3000 characters becomes a `pasted.txt` chip**, routed through the composer's own `attachFiles` so the attachment cap, the tier check and the rejection toast all apply unchanged. A tier with no `file` uploads, or the "Attach long pastes as files" setting turned off, pastes as text.
- **Spell check is on and autocorrect is off** on the textarea, but the switches that matter are WebKit user defaults written in `src-tauri/src/lib.rs:92`; see [[gotcha_webkits_text_checking_is_a_user_default_and_a_dev_build_writes_under_the_domain_tori]].
- **A mention chip whose file has gone turns red** and puts the reason in both controls' accessible names. The check is a `fileExists` prop (`Composer.tsx:180`) that ChatView binds to the `file_exists` command, re-asked whenever the input regains focus, since coming back from the tree is when a file gets deleted. It never blocks a send: the agent says the rest.
- **A draft past about 500 tokens gets a readout** in the bar, characters over four through the shared `fmtTokens`, and it says "about" because it is an approximation with no tokenizer behind it.
- **A transcript selection offers a Quote button** (`src/components/QuoteSelection/QuoteSelection.tsx`, moved out of this panel once a PDF wanted the same button over its pages) that inserts the lines as a `>` block at the composer caret. One instance per `ChatView`, answering only for its own `MessageList` root, because every attached tab stays mounted and a document-wide listener would draw a button under every hidden chat. It prevents default on mousedown so the selection survives the click, and reads `Selection.toString()` rather than the range, which is what keeps line breaks between blocks. `MessageList` gained an optional `ref` prop (`MessageList.tsx:236`) and the composer hands out a `ComposerHandle` with `insertBlock` (`Composer.tsx:55`).
- **The draft can be lifted into a scratch tab and edited there**, with the editor as the only writer and the send still here: [[concept_scratch_draft_link]].

**Source:** plan "Chat composer Tier 1: spell check, safe sends, draft tooling" (personal/tori, branch `composer-260907`, merged into `logo-update-260907`) . commits `39a05ac`, `face7c4`, `c3eb12f`, `8e8579e`

## Collapsed agent work (2026-10-02)

`chatDefaults.collapseWork` folds everything between two replies into a one line card. The model is [[concept_collapsed_agent_work]]; what belongs to this panel:

- **The transcript's row `Switch` is a `Row` component now**, inside `MessageList`, so the list and the card draw a row through one path. It takes a flag that suppresses its `TurnAnchor`, which the card renders in its place.
- **`blocking` is exported from `chatStore.ts`** and answers two questions with one rule: which rows show in main from another lane, and which rows stay out of a card.
- **`MessageList` takes the switch as a prop.** It has callers in `FirstRun/intro/art` that must not collapse, and importing the settings store into it would drag `localStorage` into its suite.
- **`thoughtLabel` moved to `toolRenderers.ts`**, beside `runLabel`, which needs it for a run of thinking alone.
- The trap this work nearly shipped: [[gotcha_a_run_keyed_by_its_first_member_remounts_as_the_window_slides]].

**Source:** plan "Collapse agent work into one line cards" (personal/tori, branch `performance-20261002`) . `src/panels/Chat/MessageList.tsx`, `src/panels/Chat/toolRenderers.ts`, `src/panels/Chat/ChatView.tsx`

## Related

- [[concept_collapsed_agent_work]] - the cards between replies, and why the cut is at every text
- [[component_pdf_viewer]] - the other surface mounting `components/QuoteSelection/`, which is why it is no longer this panel's file.
- [[concept_scratch_draft_link]] - the draft's one-writer link to a scratch tab
- [[lesson_keep_the_composer_a_textarea_until_colour_is_the_ask]] - why the textarea stayed
- [[component_chat_model_resolver]] - what the model, effort, mode and context controls read
- [[concept_subagent_lanes]] - the lane strip and the filter behind it
- [[concept_labelled_attachments]] - the attachment model the composer strip and the prompt bubble draw

- [[component_chat_host]] - the backend it talks to
- [[component_turn_checkpoints]] - per-turn attribution, now fed by exact tool-call file lists
- [[concept_inline_agent_question]] - the question row, end to end
- [[component_radio_group]] - the controls its form is built from
- [[component_cm6_editor]] · [[component_changes_panel]] - the editor-coupling counterparties
- [[concept_workspace_tab_grouping]] · [[concept_shell_hosted_tabs]] - the tab model this joins

## The palette picks the account with the model (2026-09-05)

A model belongs to an account, so the palette's left pane emits one provider row per **(agent, account)** whenever an agent has two, labelled "Claude / Fonn" with that account's plan beside the count. Splitting the provider row rather than sectioning the models pane is what keeps the filter honest: fuzzy search over one merged list returns the same model name twice with nothing to say which login would run it.

`agentId` therefore stopped identifying a row. `PaletteProvider.key` is the pair, and everything that named a row (the highlight, the DOM id, `aria-selected`, the in-force row, the re-check) moved onto it. Picking a row writes the tab's `program` and `profile` in one update, so no frame claims one account's model under another's login, and the first send locks the pair. The model pill names the account ("Opus / Fonn") on the same two-or-more rule ([[concept_naming_an_account_needs_two]]), and a draft opens on the account this project last used ([[lesson_the_default_account_is_an_answer_not_a_silence]]).

**Source:** plan "Multi-account: pick, lock and default an account per session" (personal/tori, branch `multiaccount`), phases 3 and 4 · commits `0bac9e3`, `7b33143` · `src/panels/Chat/agentPaletteData.ts`, `AgentPalette.tsx`, `ModelPicker.tsx`, `ChatDraft.tsx`
