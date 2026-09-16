---
summary: a Show around a component owning destructible state is a destroy control, mount the whole set, hide the part shown
status: current
updated: 2026-08-02
source: "Editor wave 1: close out the fundamentals (personal/sway, branch `wave-1-4`); Phase 2, issue #14; commit 87fcfe7; `src/panels/Editor/Editor.tsx:817`"
---

# Mount on the union, hide on the subset

## What happened

Phase 2 made editor tabs per workspace and carefully handed `CodeEditor` the **union** of every workspace's open paths, so `evictClosed` could only fire on an explicit tab close and a background workspace's unsaved buffers would survive a switch. Mid-implementation it turned out the protection was worthless: `<Show when={filePaths().length}>` gated the *mount* of `CodeEditor` on the **visible** strip. Selecting a workspace with nothing open unmounted the component, and its `onCleanup` calls `view.destroy()` — taking the view and every buffer behind it, across all workspaces, with none of `closeTab`'s discard confirm.

## Why

The prop and the gate were reasoned about separately. `openPaths` answers "which buffers may live", and it was made careful. `<Show>` answers "does the thing holding the buffers exist at all", and it was left alone because it had been correct when there was only one flat list — back then, an empty strip really did mean there was nothing to hold. Making the strip a *subset* of the state silently changed what that gate meant, and nothing about the change looked like it touched lifecycle.

A `<Show>` around a component that owns destructible state is not a visibility control. It is a destroy control, and Solid gives it exactly the same three characters as one.

## What to do next time

- **When a component owns state for a set, gate its mount on the whole set and its visibility on the part you are showing.** Here: `<Show when={allOpenPaths().length}>` for the mount, and the existing `hidden` prop (a `display:none` style) for what is on screen.
- **When scoping a flat list into per-key buckets, re-read every `<Show>`, `<Match>` and early return that touched the old list.** Each one silently changed meaning from "is there anything" to "is there anything *here*".
- **Ask what a component's `onCleanup` destroys before deciding it may unmount.** If the answer is anything the user has not saved, the gate needs the union.
- **Expect "mounted but hidden" to be a new case.** It was here: geometry measured under `display:none` is stale, so `CodeEditor` had to re-measure on the hidden→visible transition — the same reason `REFIT_PANES` exists.

## Related

- [[concept_editor_tab_workspaces]] — the design this near-miss shaped.
- [[component_cm6_editor]] — the component whose cleanup is the hazard.
- [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]] — the sibling trap, where identity rather than a gate causes the unwanted remount, with the same consequence.
