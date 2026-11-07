---
summary: sidebar groups live in tori.toml, ranks and last lanes in sidebar-order.json, prefs in settings.json sidebar, parking in localStorage
status: current
updated: 2026-11-07
source: plan "Sidebar lanes, custom groups and branch line controls" (branch left-sidebar-customization); src-tauri/src/sidebar_order.rs; src-tauri/src/config/groups.rs:140; src-tauri/src/settings.rs (Sidebar, Lanes)
---

# Where the sidebar's arrangement is stored

## Decision

- **Groups** in `tori.toml`, as `[[project_meta.group]]` (`name`, `colour`, `branches`) under the project's entry, written with `toml_edit` under the config store lock.
- **Ranks and last-seen lanes** in `~/.config/tori/sidebar-order.json` (`sidebar_order.rs`), one `ProjectOrder {entries, lanes}` per project.
- **Preferences** in `settings.json` under `sidebar`: Space tiles, card colours, branch line, and `lanes {default, spaces}`.
- **Collapse and parking** in localStorage (the `tori.expanded.v1` set).

## Why

- Groups are something the user names and would hand-edit or carry across machines, which is what `tori.toml` is for.
- Ranks change on every drag and lane records on every PR state change. In `tori.toml`, which is hand-edited and often linked into a dotfiles repo, every reorder would be a diff.
- A file that will not read or parse is refused rather than read as empty (`read_from` returns an error, the frontend keeps `null` and never saves), because the next write would replace every project's order.
- Discovery never prunes groups, so a project whose folder is unreadable today keeps them. A group is removed only when its last branch is removed.

## Alternatives rejected

- Everything in `tori.toml`: drag churn in a user-owned file.
- Everything in localStorage: groups would be per-window and lost with the webview's storage.

## Related

- [[concept_sidebar_arrangement]]
- [[component_settings_store]] the `sidebar.lanes` shape
- [[gotcha_a_toml_key_after_a_table_header_belongs_to_that_table]] the trap `[[project_meta.group]]` writes walk past
