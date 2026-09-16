---
summary: macOS symlinks like /var vs /private/var give one directory two spellings, so string comparisons silently miss matches
status: current
updated: 2026-09-05
source: Four sightings across three plans (personal/sway); `src-tauri/src/fs.rs` (`ensure_inside`), `src-tauri/src/worktree.rs`, `src-tauri/src/accounts.rs`, `src-tauri/src/chat/acp_transport.rs` (`refresh_listing`)
---

# One directory, two spellings

On macOS a directory routinely has two true names. `/var` is a symlink to `/private/var`, so every temp dir has both spellings; a user's project can sit behind a symlink for the same reason. Anything that compares paths **as strings** therefore sees two directories where there is one, and the failure is almost never an error. It is an empty list, a silent miss, or a row filed under a folder nobody opened.

This has now bitten Sway four times in four unrelated subsystems, which is enough to stop treating each one as a surprise.

## The four sightings

| Where | What compared strings | What went wrong |
| --- | --- | --- |
| Editable `.shared` tree | a containment check | see [[gotcha_ensure_inside_returns_the_callers_unresolved_path]] |
| Worktree listing | `git worktree list` output | see [[gotcha_git_worktree_list_reports_canonical_paths]] |
| Claude account isolation | `sha256(CLAUDE_CONFIG_DIR)[:8]` over the **raw** env string | `.../home` and `.../home/` are two Keychain items for one directory, so a profile reports signed-out purely because the path was spelled differently than at login |
| ACP `session/list` | the agent's `cwd` filter | Sway sent `/var/...`, `codex-acp` had recorded `/private/var/...`, and a directory with a live session listed zero rows |

## The same shape, with no path in it

A fifth sighting, from the multi-account work, and the reason this page is worth reading even where no filesystem is involved: **one account has two true names**. The session index tags a row with the id of the root that held its transcript, which is a real profile id and so is the literal `"default"`; a tab spells the same account `null`, because at the spawn boundary the home variable being *unset* is what makes it the default. Storage adds a third demand rather than a third spelling: `ChatPrefs.profile` keeps the backend's, so that absence can go on meaning "never answered" ([[lesson_the_default_account_is_an_answer_not_a_silence]]).

There are exactly two crossings, `asTabProfile` (backend to tab) and `asProfileId` (tab to backend), in `src/utils/agentHealth.ts`. Everything keyed on an account uses one spelling, so `undefined` cannot mean the default account in one map and nothing at all in the next.

The Keychain one is the sharpest, because the *harness* is doing the string comparison and Sway cannot change it. The rule there is not "canonicalize before comparing", it is **canonicalize before storing**, since the stored spelling is what a future login has to reproduce exactly.

## The rule

**Decide which spelling a boundary means, and convert at the boundary.** Not everywhere: converting eagerly is how the opposite bug arrives.

- **Going out to something that compares strings** (an env var you will have to reproduce, a filter another process matches, a path you persist): send the **resolved** form.
- **Coming back from something that resolved on your behalf** (an agent echoing a cwd, a tool printing canonical paths): re-spell it to **your** form when both resolve to the same directory, so downstream prefix matching still works. `norm` in `sessions.rs` strips a trailing separator and nothing else, so a canonical row will not match a non-canonical folder.
- **Answering a yes/no** (containment): resolve only to decide, and hand back what the caller passed. Rewriting a user-visible path as a side effect of checking it is its own bug.

Both legs or neither. In the ACP case, canonicalizing only the outbound filter makes rows arrive and stay invisible, which reads exactly like the feature still being broken.

`std::fs::canonicalize` returning `None` is information, not a nuisance: a path that does not resolve is not quietly equal to another path that does not resolve. Two deleted directories are not the same directory.

## Why it keeps recurring

Each subsystem meets it from a different direction, and none of them looks like a path-comparison problem at the time. It shows up as a permissions question, a git-output question, a login question, and a history-listing question. That is the argument for one page rather than a fifth gotcha: the sightings share nothing except the fact underneath them.

## Related

- [[gotcha_ensure_inside_returns_the_callers_unresolved_path]] - the containment sighting
- [[gotcha_git_worktree_list_reports_canonical_paths]] - the git sighting
- [[gotcha_codex_acp_matches_the_session_list_cwd_filter_as_a_string]] - the ACP sighting
- [[adr_credential_custody]] - the Keychain sighting, and why the raw string is what gets hashed
- [[concept_acp_session_locator]] - where the listing legs are implemented
- [[concept_folder_anchored_sessions]] - the prefix rule that a canonical row silently escapes
