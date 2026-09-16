---
summary: renders a live session as one accumulated diff per file, crediting a line to the last call whose view still disagreed
status: current
updated: 2026-07-29
source: Chat surface plan, phase 3 (branch `chat`); `src-tauri/src/chat/snapshot.rs`; `src/panels/Editor/DiffRows.tsx`; commits "Accumulate a session's per-file diff from its tool-call before-states", "Read a session as a diff, not only as a transcript"
---

# Diff as transcript

A session read as what it *did to the files* rather than as what was said. The
before-states were already being captured for the approval bridge's inline
diffs, so nothing new had to be recorded; the cache only lacked ordered access.
The view answers for a live session only, and says so, because the cache is in
memory and dies with the child.

## How it works

`chat/snapshot.rs` caches an exact before-state per tool call (`tool_use_id` to
`Vec<Captured>`, a blob sha in the repo's own object store, bounded at
`CACHE_CAP` 500), gathered by the `PreToolUse` capture hook
(see [[concept_pretooluse_capture_hook]]) or, for an agent that sends the prior
text with its tool call, hashed straight into the same object store by
`snapshot::store_text`. `accumulate(repo, path, calls)`
diffs the session's **earliest** before-state for a file against the file as it
is now, so a line rewritten three times appears once at its final value.

**Attribution rule.** A line still differing from what call `i` saw is a line
some call at or after `i` wrote, so the *last* call whose view still differs
names the write that produced the text on screen. Comparison is on **new-side**
line numbers, the only coordinates that mean the same thing across diffs sharing
one right-hand side. The accepted cost, stated in the doc comment rather than
hidden: a line two calls edited is credited only to the later one.

**Reasoning is looked up, not stored twice.** `reasoningFor(items, toolUseId)`
walks the transcript backwards to the nearest preceding text or thinking item,
stopping at a user turn. Nearest-preceding rather than whole-turn, because a turn
with six tool calls has six justifications and crediting all of them to every
hunk is worse than showing none.

**One renderer, called twice.** `rowClass` / `lineContent` / `renderHunkBody`
moved out of `ReviewPanel.tsx` into `DiffRows.tsx`, so the Changes panel and this
view cannot drift. The CSS had to move wholesale: it was written as
`.reviewDiff .diffLine`, and CSS modules hash per file, so an ancestor rule in a
panel's own stylesheet can never match a row rendered from a shared component.

## Why it's this way

**One accumulated diff per file, rather than one segment per tool call.** The
per-call shape is exactly attributable but double-counts a twice-edited line, and
therefore cannot match `git diff` between the first and last checkpoint, which is
the only external check available. The verify compares changed lines rather than
headers, since blob shas cannot match `a/`,`b/` paths.

**Files it cannot diff are listed anyway.** A file the worktree changed that this
session never captured a before-state for gets a row with no diff and an
`unattributed` or other-session marker. Reconstructing a diff for it would be
invention; staying silent would make a shared worktree read as if this session
were its only writer. That is the same discipline as
[[concept_evidence_tiered_attribution]].

## Related

- [[component_turn_checkpoints]] - the per-turn snapshots this joins against
- [[component_chat_panel]] - the transcript toggle this renders inside
- [[concept_pretooluse_capture_hook]] - the hook that captures the before-states
- [[concept_evidence_tiered_attribution]] - why an undiffable file is still listed
- [[gotcha_solidjs_testing_library_unmount_does_not_run_oncleanup]] - trap hit writing its tests
