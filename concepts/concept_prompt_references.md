---
summary: # and @ put [PR 123], [Session: x], [Project: x], [Space: x] in a prompt, each sent as a ref-* note naming the tool to read it
status: current
updated: 2026-10-08
source: plan "Session, pull request, project and space references in the composer" (gettori/tickets#10, branch phase-1-block-1, commits 916622d3, b3feba30, 8f2f77cf); src-tauri/src/chat/model.rs:833,890,904,918; src-tauri/src/chat/host.rs:594; src-tauri/src/sessions.rs:265; src-tauri/src/agents.rs:1239; src/utils/composerCompletion.ts:38,71; src/utils/mentionNavigator.ts; src/utils/prMention.ts; src/utils/sessionMention.ts; src/panels/Chat/Composer.tsx; src/panels/Chat/MessageList.tsx:65; src/panels/LeftSidebar/LeftSidebar.tsx:1112
---

# Prompt references

A prompt can name a pull request, a session, a project or a space the way it names an attachment: a token in the sentence (`[PR 123]`, `[Session: Fix login]`, `[Project: tori]`, `[Space: Work]`) backed by a chip. Unlike an attachment, nothing is read off disk. The agent gets a snapshot of the target and the name of the `tori` tool that reads the rest, and fetches it itself. The decision behind the wire form is [[adr_prompt_references_are_notes_rendered_in_rust]].

## How it works

**One block type on both sides.** `ContentBlock::Ref { label, target }` (`model.rs`) mirrors the TS `{ type: "ref" }` block (`chatTypes.ts`). `RefTarget` is tagged on `kind`: `pr` (number, title, url, state, draft, head, base), `session` (id, title, agent, project), `project` (name, folder, space) and `space` (name, each project's name and folder). Adding a kind means a variant, a `kind()` arm and a `hint()` arm.

**Sent as a note, ahead of the text.** `ref_note` (`model.rs:890`) writes `from_tori("ref-<kind>", ..)` holding `label: <json>` on one line, then the tool hint ("Read it with the pr_get tool, key <url>", "session_history, id <id>", "projects_list and sessions_list have more"). `<` and `>` in the JSON are escaped as `<` and `>`, so a title cannot close or open a note. `refs_first` puts refs ahead of every other block in both `turn_frame` and `prompt_blocks`, because notes are only lifted from the start of a message ([[concept_tori_notes]]).

**Read back into the bubble, not into Tori rows.** `ref_from_note` is the exact inverse. `split_user_notes` (`host.rs:594`, live and the ACP echo) and `history.rs` (replay) turn a ref note back into a `Ref` block inside the user message, while every other note still becomes its own Tori row. So the live bubble, the echo and a replay all draw one user item with its chips. `clean_title` titles a prompt that is only a ref by its label (plus the title for a PR).

**`#` is pull requests.** `activeToken` (`composerCompletion.ts:38`) triggers `#` at a word boundary with no whitespace in the query and not inside a fence. `prHits` lists the open PR store newest first: digits filter by number, words fuzzy match titles. A number the list lacks gets a resolve row: Tab looks it up (`forge_get_pr`), Enter sends the sentence as typed, so "fixes #42" stays prose.

**`@` is files, sessions and the navigator.** `mentionScope` (`:71`) reads a leading keyword: `file/`, `session/`, `spaces/`, `projects/`; keywords win over a folder of that name. A bare `@` shows up to five sessions above the files. Sessions come from `list_sessions({ folder: project, inclusive: true })` with the project from `project_of_folder`, re-read on each new `@`, the chat's own session left out.

**The navigator walks the sidebar's tree.** `navLevel` (`mentionNavigator.ts`) resolves `@spaces/<space>/<project>/<checkout>/<file query>` or `@projects/<project>/...` (the chat's own space) from `get_config`. Every segment but the last is a key: the basename of the node's path, `-2`, `-3` on a repeat in sidebar order, so a name with spaces is still one token. Under a project come its checkouts (`unitsOf` drops incomplete stubs and a plain repo's other branches, which have no files on disk) and its sessions; under a checkout, its files, attached by absolute path as an ordinary `[File n]`. In the menu `/` on a row opens it, does nothing on a session, and is path text in a file list. Enter references a space, project or session and opens a checkout, which has no ref kind.

**Labels never collide.** `refLabel` (`sessionMention.ts`) adds ` (2)` when the pending refs already hold that label for a different target, and a second pick of the same target reuses its token. Brackets in names are dropped.

**Only where a tool can read it.** Sessions, projects and spaces need the `tori` MCP server. `ChatConfig.tori_mcp` (`agents.rs:1239`, stream-json or ACP with `send_mcp_servers`) tells the webview, and without it the composer offers files and PRs only ([[component_tori_mcp]]).

**Chips open the target.** `openRef` (`MessageList.tsx:65`): a PR opens a stage tab through `openPrTab`, a session emits `SESSION_ACTION` open, a project or space emits `NAVIGATE` with `project` or `space`, which `showInSpaces` (`LeftSidebar.tsx:1112`) answers by switching space and expanding the project without changing the selection.

## Why it is this way

The target is read through a tool rather than pasted in, so the prompt stays short and the agent reads it current. The snapshot is there so the agent knows what was meant even if the target has moved on. A cross-project file is attached by path and accepts Claude's one-time Read prompt, rather than handing the chat another folder with `--add-dir` ([[adr_attachments_are_labelled_paths]]).

## Related

- [[adr_prompt_references_are_notes_rendered_in_rust]]: the wire form and who renders it
- [[concept_labelled_attachments]]: the token-in-the-sentence model refs share, and the chip machinery
- [[concept_tori_notes]]: the note marker and why refs lead the message
- [[component_tori_mcp]]: the tools a ref names
- [[gotcha_check_tokens_mjs_reads_an_issue_ref_as_a_hex_colour]]: why fixtures build PR refs with a helper
- [[gotcha_list_sessions_hides_a_repos_own_tori_worktrees_unless_asked_inclusively]]: why the session list asks inclusively
