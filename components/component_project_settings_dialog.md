---
summary: one dialog per project, in Settings' own panel, owns every per-project setting in four sections and stacks over Settings
status: current
updated: 2026-10-11
source: plan "Project settings tab" (branch phase-1-block-2, gettori/tickets#81); src/utils/projectSettings.ts, src/panels/ProjectSettings/, src/panels/Settings/components/ModalShell.tsx, src/panels/Settings/panes/ProjectsPane/; commits eff8c5be, 09af6480, 1707e908, d155d793, d4eb0d90 and the dialog move after them
---

# Project settings dialog

`src/panels/ProjectSettings/ProjectSettingsDialog.tsx` is the one place a project's own settings are edited: a modal drawn in Settings' panel, with a rail of sections.

## Responsibility

Owns every per-project setting, in four sections: General (icon, layout, and for git kinds the remote: origin, default branch, forge account), Worktrees (bare kinds: setup command and shared files), Agents (allowed agents, remembered chat picks, and the autopilot contract while autopilot is available), and Tooling (trust, verification commands, and for a single checkout the `.tori/settings.json` summary). Name, space and path sit where Settings has its title. Settings holds no per-project control: its Projects pane and the Autopilot pane only list projects and open this dialog.

## Interface

- `openProjectSettings(path, section?)` in `src/utils/projectSettings.ts` is the only way in (menu row, the sidebar's shared-files and shield marks, `ProjectList` in Settings). It emits `OPEN_PROJECT_SETTINGS`; `App.tsx` owns the open state and mounts the dialog **after** Settings, so it draws over it and closing it lands back on Settings' project list. The mount is keyed on the request, so a second request replaces the dialog with a fresh one.
- The shell (`ModalShell` in `src/panels/Settings/components/`) is Settings' own: backdrop, panel, Escape (with an `onEscape` hook Settings uses to clear its query first), the Tab trap, and closing on `OPEN_JOB`, `OPEN_TERMINAL`, `OPEN_IN_EDITOR` and `COMPOSE_DRAFT`. Pulled out of Settings.tsx so the two never differ in how they close. The dialog also closes on `OPEN_SETTINGS`, since its doors out (the trusted list, the hosts) lead into the panel under it.
- The header (`ProjectHeader`) names the project (icon tile, wrapping name, space chip, layout, middle-cut path with a Copy path button). It is not a picker: one was tried and dropped as noise. While the dialog is up `markProjectShown` lets the sidebar outline the project's row (`projectShown`), under the scrim.
- `sectionsFor(kind)` decides the rail, drawn with Settings' rail classes (`railItem`, `railItemActive`) and a roving tabindex like Settings' rail; Tooling carries a warning dot while `projectUntrusted(path)` holds, and any section carries a brand dot while one of its lists has an unsaved draft (`onDirty` from `AgentsSection`, `ChecksSection` and `ProjectContract`). A requested section the project does not have falls back to General once its record loads.
- Every section sits on one scrolling card (`OverlayScroll` with Settings' `pane`/`paneInner`, so the 720px measure applies), Worktrees included: its shared-files list and detail are one split card inside the column, wrapping under each other when narrow. Every section stays mounted and hidden, so a draft survives a look at another section.
- Sections are built from `Section` and `Row` in `ProjectSettings/Section.tsx`, which render Settings' section title and row classes. Its prop is `heading`, not `title`, because the `title=` guard in `interactiveTitle.test.ts` counts the text.
- The dialog reads its record through `createSpaceProject(path)` in `src/utils/topicMembers.ts` (one `get_config` per `config://changed`), with `loaded` so a missing project is told apart from one still loading.
- Sections save on change; list editors (agent rows, commands, issue sources) keep a draft with Save and Discard, and reset their draft only when the stored value changes by content, see [[gotcha_every_settings_save_replaces_every_per_project_map]]. Checks' Reset to defaults only refills the draft (from the `verification_defaults` command); Save with the built-in text stores an empty list.
- `ProjectContractEditor` (`src/panels/Settings/panes/AutopilotPane/`) is used only by the dialog now, and follows `autopilot://changed`, so a contract an agent sets over the socket shows at once.

## History

It shipped first as a synthetic editor tab (`tori://project`) and moved to this dialog the same day: in a tab it was unclear which project was being edited, and a tab beside files read as a document rather than a setting.

## Related

- [[component_settings_store]] how each per-project map is keyed
- [[component_worktree_setup]] what the Worktrees section edits
- [[component_verification]] what the Checks section edits
- [[component_icon_grid]] the glyph grid inside the General section's picker
