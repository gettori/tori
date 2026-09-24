---
summary: autopilot UI lives in src/components/Autopilot as props-only parts; the cockpit (#205) wires them to the session
status: current
updated: 2026-09-24
source: "plan \"Autopilot design (#201): Tori token pass and Storybook components\" (personal/tori, branch `orchestrator`, issue gettori/tori#201); commits 30a046ea, 821fbf48, 9e964b95; `src/components/Autopilot/`; plan \"Autopilot session and the cockpit (#205)\", commits 4b309f03, 669596a1"
---

# Autopilot parts

`src/components/Autopilot/` holds every piece of the autopilot's window presence from the #201 design, drawn on Tori tokens and built for Storybook first.

## Responsibility

It draws. It owns no state, reads no store and calls no `invoke`: every component takes what it shows as props and reports clicks through callbacks. [[component_autopilot_cockpit]] wires them to the session and its state on disk; enforcing the lock outside the tab itself is #209.

- **`Wheel`**: the mark, one shape per state (strike off, turn working, count needs, "!" error), plus a still dot under reduced motion and a `quiet` tone for a row the autopilot started but no longer drives. Badges ring against `var(--wheel-ring, var(--canvas-card))`, a fallback rather than a declaration on `.wheel`, so a host on another surface can set it.
- **`AutopilotSwitch`**: the title bar pill (Autopilot or Workspace view) and the round Stop/Start button. Clicking the active Workspace segment toggles the popup.
- **`DecisionCard`**, **`ArrivalCard`**: a decision to approve or a worker question to answer, and the short preview when one arrives.
- **`SessionMarks`** (`StartedMark`, `LockMark`, `DrivingTag`, `DrivingHairline`) and **`LockedBar`**: what a worker session wears on the surfaces it appears on. The surfaces themselves only grew slots: `BranchRow.lead`, `Tab.locked` ([[component_tab]]) and `HistoryRow`'s `lead` and `locked` ([[component_history_dropdown]]).
- **`AutopilotPopup`**, **`AutopilotView`**: the two shells, with shared pieces in `ShellParts.tsx`.

## Interface

- **A ref is `Ref = number | string`**, since an issue key need not be numeric. `DecisionCard`, the in flight rows and the queue take `refNumber` and print `#123` themselves, because a literal `"#123"` in source trips the token guard ([[gotcha_check_tokens_mjs_reads_an_issue_ref_as_a_hex_colour]]). A `Decision` may have no ref (a `pr.create` with no item), and the card then hides it; it carries the ask `id` it answers. A worker card with an empty `diff` shows the branch alone, and a queued row with no `after` drops "after".
- **`ArrivalCard` has no timer.** Under reduced motion its countdown bar never animates, so the bar cannot be the clock; the host runs the dismiss.
- **Error copy is data.** Both shells take `error: { title, detail }` rather than baking in a signal or an attempt count.
- **Decision buttons route to one handler**, `onDecision(action, decision)`, via `decisionHandlers` in `ShellParts.tsx`.
- **`ComposerShell` is a picture, now only a fallback.** `AutopilotView` takes a `chat` slot, where the cockpit puts a live `ChatView`, and `AutopilotPopup` a `composer` slot, filled with `ShellParts`' `Composer`. `ErrorBanner` shows View log only when `onViewLog` is set.
- **Not built:** the design's collapse of Decisions and In flight to one line when the chat runs long, and the popup's edge dim, which belongs to the host.

The per state fake data is `shellFixtures.ts`, imported only by the stories. Colours come from the state tint roles (`--progress-*`, `--needs-you-*`, `--danger-*`), which are opaque mixes for the reason in [[gotcha_a_translucent_role_cannot_be_a_contrast_surface]].

## Related

- [[adr_autopilot_is_a_session_not_a_state_machine]]: why the autopilot is a session, and the hard lock these marks draw
- [[component_autopilot_cockpit]]: the host that feeds them
- [[component_autopilot_store]]: the state on disk behind them
- [[component_tab]]: the `locked` prop
- [[component_history_dropdown]]: `HistoryRow` and its slots
- [[gotcha_an_unlayered_css_module_beats_a_layered_one_at_any_specificity]]: why `LockedBar` uses the default Button rather than overriding it
