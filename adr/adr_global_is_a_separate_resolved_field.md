---
summary: Global (labelled Home) is ResolvedConfig.global with no path, read via project_groups/allSpaces, never in spaces
status: current
updated: 2026-11-03
source: Global space ticket (branch global-space), phases global-space-tile and attached-folders; commits 31c7d198, 11a1c775; src-tauri/src/config.rs:221; src/utils/globalSpace.ts:22
---

# Global is a separate resolved field

## Context

The Spaces/Topics toggle became a built-in Global space that lists global Topics, folders attached from anywhere on disk and chats. Spaces are discovered from folders and keyed by name; `Space.path` feeds mkdir, clone, delete and the space dialog. Global owns no folder.

## Decision

Global is its own field, `ResolvedConfig.global: GlobalSpace { icon, color, projects }`, with no `path`. Readers that only walk projects use `ResolvedConfig::project_groups()` (`src-tauri/src/config.rs:221`) on the backend and `allSpaces()` (`src/utils/globalSpace.ts:22`) on the frontend; both return the named spaces then Global. Everything that touches a space's folder stays on `config.spaces`. The UI keys Global as `/global` (`GLOBAL_KEY`), a name no folder basename can hold, and shows it through `spaceLabel`.

The label users see is **Home** with a house icon (`GLOBAL_NAME`, `GLOBAL_ICON`); everything in code, the `[global]` table and the key stay `global`. Home was chosen over the design brief's pick, Global, even though "home" already names a Topic's home folder and `~`.

## Alternatives rejected

- **Global as an entry in `spaces` with an empty path.** Every `Space.path` consumer (mkdir, clone, delete space, edit dialog, the phone's Spaces sheet) would need a guard, and a missed one acts on `""`. Leaving the field out makes a folder op on Global a compile error instead.
- **Key `global:`.** A macOS folder can be named that, so a user space could collide with it.

## Consequences

Every reader of `spaces` had to be swept once to the helper (about 23 frontend files plus `unit_home`, `port_units`, the CLI and MCP project lists). A new reader that walks `config.spaces` directly silently misses Global's projects; reach for `allSpaces()` / `project_groups()` unless the code needs a folder. The phone tree carries Global as its own `global` field, listed by `projectGroups()`.

## Related

- [[concept_attached_folders]] - what Global's projects are
- [[concept_chats]] - the other thing Global lists
- [[component_project_discovery]] - where `resolve` builds both
