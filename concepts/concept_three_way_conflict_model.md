---
summary: a conflicted file reads from the index's three stages, never the markers on disk, since the base is missing from them
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/sway, branch `wave-2`); Phases 10 to 13 (commits b8bd8b4, 02f5805, 167ac63, 9cdbe93); `src-tauri/src/conflict.rs`, `src/utils/conflict.ts`, `src/panels/Editor/ConflictView.tsx`, `src/utils/conflictAsk.ts`"
---

# Three-way conflicts: read the index, never the markers

A conflicted file on disk is git's *rendering* of a conflict: `<<<<<<<` markers carrying two of the three versions. Sway never reads it. A conflicted path has no stage 0 and instead holds stages 1, 2 and 3 in the index, readable as `git show :N:<path>`, and those three documents are the model's only input. The resolved file is written back from them.

## How it works

- **The stage set is read first** (`ls-files -u`), and only a path with *no* stages is an error. A missing stage is an ordinary conflict: delete/modify has no stage for the side that deleted, add/add has no base.
- **Regions are computed in base coordinates**, as two diffs against a common origin. Base-vs-ours and base-vs-theirs are both in base coordinates, so they lay side by side and group where they meet.
- **Regions join when they touch, not only when they overlap**, which is git's own rule: with no unchanged line between two changes there is nothing to anchor them apart, and git writes them inside one pair of markers.
- **`both` compares the two sides' text**, not merely their line spans, so two people making the identical edit is not reported as a conflict. git merges that silently, and asking a reader to choose between two identical versions is asking a question with no answer.
- **Region identity is the base line span**, because the base is the only side that cannot move: ours and theirs both shift as regions are accepted.
- **`sideLabels(op)` is rebase-aware.** Mid-rebase git checks out the upstream and replays your commits onto it, so stage 2 is the upstream and stage 3 is yours. Cherry-pick and revert keep the merge orientation, since HEAD does not move. `none` is a real answer rather than a fallback: a conflicted `git stash apply` records no state at all.
- **The operation is read through `rev-parse --git-path`**, never by joining `.git`. See [[gotcha_a_worktrees_git_is_a_file_so_merge_head_must_come_from_rev_parse_git_path]].
- **One write, at the end.** Choices live in the tab until "Mark resolved", so a tab abandoned half way through leaves the merge exactly as git left it. The resolved file is rebuilt in base coordinates: between regions the three documents agree so those lines come from the base, and inside one the chosen side's own span replaces them.
- **`resolvedText` returns null while anything is undecided**, and the button is disabled on the same condition.
- **The backend refuses a path that is no longer unmerged**, which is the staleness guard for the whole surface.
- **Handing the conflict to an agent** ([[concept_safe_send]]) composes from the same three stages, names the sides by stage number before translating them, and points at `git show :1:` for the base.

## Why it's this way

**Parsing the markers would make the file on disk the source of truth again**, and it is the one artefact here that is lossy: it carries stages 2 and 3, and the base (the thing that says what each side actually *changed*) is not in it at all. Writing markers back for the regions still undecided, which per-region writes would require, is exactly the shape this model exists to avoid.

**A one-sided change is carried, not dropped.** Taking theirs at every conflict still keeps an insertion only ours made. Nobody was asked about it, and losing it is how a merge tool silently reverts work that was never in dispute. The property that keeps the rebuild honest is a test: choosing one side at *every* region has to reproduce that side's file byte for byte.

**A missing stage is a question about the file's existence, not about its lines.** Delete/modify gets a keep/delete pair rather than a region walk, because "accept theirs" would stage an *empty* file where git means *no* file, and `git rm -f` is what says the latter (see [[gotcha_git_rm_on_an_unmerged_path_needs_f]]).

**Getting the side labels wrong is the most convincing kind of wrong**, which is why the stage number is what travels and the human name is derived. An agent told "keep ours" mid-rebase would keep the upstream, discard your commit, and sound entirely right doing it.

**The base is not a third column.** Three columns of code do not fit the width this pane gets, and what the base is *for* is the region under discussion, so it is shown one region at a time under the header while the pair being chosen between gets the `MergeView`.

**Decorations live in a `Compartment`, one per pane**, so accepting a side repaints those lines and nothing else. Rebuilding the `MergeView` would throw away the scroll position of the file being worked through.

## Related

- [[concept_porcelain_v2_status]] - where a file is first known to be unmerged, and why `conflicted` excludes `staged`.
- [[concept_safe_send]] - the routed path "Ask agent to resolve" sends through, and the composer that reads these stages.
- [[component_changes_panel]] - the Conflicts section, the row that opens this view, and the second entry point to the ask.
- [[gotcha_a_worktrees_git_is_a_file_so_merge_head_must_come_from_rev_parse_git_path]] - why the operation is read through git rather than off the filesystem.
