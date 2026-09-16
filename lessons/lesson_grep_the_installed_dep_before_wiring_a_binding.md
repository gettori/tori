---
summary: a never bound ticket premise was false, the binding sat inside the spread defaultKeymap, so grep the dep before wiring
status: current
updated: 2026-08-01
source: "Editor wave-1 opener: multi-cursor, editing polish, language packs (branch `editor-improvements`); `src/utils/hotkeys.ts:275`; PR #80"
---

# Grep the installed dep before wiring a "missing" binding

## What happened

Issue #8 said `toggleComment` "exists in @codemirror/commands but is never bound; bind Mod-/". A grep of the installed package's dist showed `defaultKeymap` has carried `{ key: "Mod-/", run: toggleComment }` all along, and CodeEditor spreads `defaultKeymap`. The visible symptom that spawned the ticket (pressing Cmd+/ opened the shortcut sheet over the editor) had a different root cause entirely: the window hotkey dispatch ignored `e.defaultPrevented`, so the sheet fired on top of every successful comment toggle and visually swallowed the evidence.

## Why

A "never bound" claim is a statement about a dependency's contents, and grepping the repo cannot test it: `grep "Mod-/" src/` finds nothing because the binding lives inside the spread `defaultKeymap`. Worse, a verify line written from the false premise ("Cmd+/ toggles comments in ts") passes with zero code changed, so it measures nothing. The adversary pass caught it only by fetching the installed version's dist and searching for the literal binding.

## What to do next time

Before implementing a ticket that claims X is missing or never wired, grep the installed package's dist (unpkg or `node_modules`) for X and reproduce the symptom once. If X turns out to exist, the task is not "add X"; it is "find what masks X", usually a collision or a guard, and the fix lands somewhere else entirely. Rewrite the verify so it fails on the unmodified tree first.

## Related

- [[gotcha_an_app_global_hotkey_must_yield_to_a_defaultprevented_key]] - the trap this hardened into
- [[component_cm6_editor]] - where the editor keymap lives
- [[adr_cm6_editor]] - why the editor owns its own keymap at all
