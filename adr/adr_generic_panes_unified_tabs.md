---
summary: panes are anonymous and any tab kind can live in any one, so pin chat left is a routing rule not a fixed dock layout
status: needs-verification
updated: 2026-09-03
source: not recorded; imported from grimoire docs/personal/sway
---

# Generic split panes over a dock model for the unified tab bar

The two tab bars (terminal/chat and editor) merge into one heterogeneous tab model rendered into generic split panes: panes are anonymous, any tab kind can live in any pane, and "pin chat left" is a routing rule for where new tabs open (plus an optional per-pane kind lock), never a layout mode. Chosen over a dock model (each kind owns a fixed panel) and over a strict single panel, because every dock arrangement is expressible as a configuration of the generic model while the reverse is false, and the single panel loses the chat-beside-editor loop the app exists for.

## Considered Options

- **Strict single panel** (one strip, one visible tab): simplest, rejected for losing side-by-side chat and code.
- **Dock model** (pinned kind gets a dedicated panel): fewer concepts, rejected because it hard-codes layouts the generic model gets for free and cannot express two chats or chat-plus-file side by side.
- **Generic panes** (chosen): anonymous panes, kind routing rules, depth-2 split tree, drag-and-drop.

## Consequences

- The editor must grow multi-view support (per-pane CM6 views over one authoritative buffer, LSP bridge multiplexing), the hardest single piece; splits ship first behind an interim one-editor-pane guard.
- Editor chrome (file tree, right panel) detaches from the editor pane and becomes fixed workspace chrome.
- Tab ids are preserved verbatim across the merge because terminal tab ids leak into the sidebar's live-tab surface.
- Everything stays mounted; a tab move must never remount a PTY, which constrains the stage architecture (phase 1 spike decides the mechanism).
  - **Narrowed by [[adr_lazy_tab_attachment]] to everything *attached*.** A restored tab starts inert, with no process behind it, so a move remounts nothing; once a tab attaches it stays mounted for its life, which is the property this consequence was protecting.

## Related

- [[adr_lazy_tab_attachment]] - narrows "everything stays mounted" to attached tabs
- [[adr_jobs_leave_the_tab_model]] - amends this: the transient commands leave the model rather than taking the dock it rejected
- [[component_overflow_tab_bar]] - the shared strip this decision merges onto
- [[concept_workspace_tab_grouping]] - terminal tab model being unified
- [[concept_editor_tab_workspaces]] - editor tab model being unified
- [[concept_lsp_workspace_bridge]] - the one-view assumption multi-view must renegotiate
