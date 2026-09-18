---
summary: ACP session locator writes one json file per session since the id is on no command line, so liveness cannot pgrep it
status: current
updated: 2026-08-15
source: "\"Defer permissions to the harness, and grow to four harnesses\" (phase 5, branch `chat-fix`), then \"Make a harness installable, signed in, and discoverable\" (phase 6, branch `harness-lifecycle`); `src-tauri/src/chat/acp_sessions.rs`, `chat/acp_transport.rs` (`refresh_listing`); measured against `opencode acp` 1.18.3, `@agentclientprotocol/claude-agent-acp`, and `@agentclientprotocol/codex-acp` 1.2.0"
---

# The ACP session locator

Tori's session model assumed sessions are discoverable on disk: `SessionMeta.path` is non-optional, `chat_history` backfills from a transcript, and `session_pattern` substitutes `{id}` into a pgrep regex. An ACP session satisfies none of those - the agent mints the id inside `session/new`, puts it in no command line, and keeps the conversation somewhere only the protocol reaches. The locator is the small JSON file Tori writes to close that gap: one per session under `~/.config/tori/acp-sessions/<tori-id>.json`, recording the agent's id beside the cwd, title and last-active.

That file is a real path, so `SessionMeta.path` stays non-optional **and honest** rather than becoming an `Option` that every caller has to reason about.

## How it works

- `record` / `read` / `all` (`acp_sessions.rs:111`, `:117`, `:126`) own the store; `use_dir_for_tests` (`:62`) redirects it, which is why the live tests must run `--test-threads=1`.
- **History comes over the protocol, not off disk.** `session/list` enumerates (gated on `sessionCapabilities.list`, honouring the cwd filter and `nextCursor`), and `session/load` replays: the agent re-sends the whole conversation as ordinary `session/update` notifications, which already map to `ChatEvent`. So a reopened chat needs no transcript file, no new event variant, and no change to `chat_history`, which correctly returns empty for an ACP session.
- `adopt` (`:176`) merges a listed row into the store.
- **Liveness stops asking the process table about ids.** Every ACP session of one agent shares a command line (`opencode acp`), so a pgrep pattern would report all of them running whenever any one was. `found_by_pattern` reads the adapter's declared *transport* - not its id, so a user-added ACP harness needs no naming - and routes those to `Registry::sessions_with_live_child`, which asks whether the claim's recorded child pid is alive. The pgrep half returns a flat `false`, because "a process outside Tori is resuming this session" is a claim nothing about an ACP agent can support.

## Why it's this way

**A `Discovery` variant would have been the wrong shape, not merely an unwanted one.** `Discovery` answers "where does *this adapter* keep its sessions", and an ACP agent keeps them somewhere no directory-and-regex describes, with nothing for a `ParserKind` to parse. The locator store is Tori's own record of what the protocol said, shared by every ACP adapter rather than owned by one, so it merges into `ensure_index` beside adapter discovery instead. Both enums stayed one-variant.

**The reorder that looked safe found a real bug.** Listing originally ran before the session opened; moving it after (so a chat is never held closed while history is enumerated) made the listing's row win over the one `session/new` had just written - and `opencode acp` **canonicalises the cwd it is handed**, so `/var/...` came back `/private/var/...`. The sidebar files a row by prefix-matching its cwd against the folder the user opened, which silently dropped the row out of its own folder. `adopt` now keeps Tori's recorded cwd for a row Tori already has, and takes the agent's only for a row it has never seen.

**The same fact then bit twice more, on the legs that fix did not cover.** Keeping Tori's cwd for a row Tori *already has* protects a session Tori opened. It does nothing for the two cases the import path actually runs into, both measured against `codex-acp` 1.2.0:

1. **The outbound filter is compared as a string too.** `session/list` was sent Tori's own cwd, so a directory macOS hands out as `/var/folders/...` and Codex records as `/private/var/folders/...` returned **zero rows** while the thread sat in `~/.codex/state_5.sqlite` with the right path. The filter now goes out canonicalized.
2. **A row Tori has never seen had no protection at all**, and that is the whole of the import case. It adopted the agent's spelling, and the sidebar's prefix match then hid it, which looks exactly like the listing still being broken. A returned row is now re-spelled back to Tori's cwd when both resolve to one directory, resolved once per connection rather than once per row.

Both legs or neither: fixing only the filter makes rows arrive and stay invisible. See [[concept_one_directory_two_spellings]].

**A listing is idempotent, and two bugs lived in it not being.** It runs on every connection, and it used to write a locator for **every** row it adopted, unchanged ones included, so opening any chat rewrote N files. Worse, a row whose agent omits `updatedAt` was dated to `now` each time, so every session of such an agent floated to the top of the history list whenever the user opened any chat at all. Now `now` is the fallback only for a row nobody has seen before, a known row keeps the time it was recorded with, and an adopted row equal to what is on disk is not rewritten.

**Listing stays per-connection rather than becoming an explicit import action.** It costs one request in the measured case, runs *after* `SessionStarted` so it never holds a chat closed, and fails non-fatally. A button would trade that for a harness spawned on click and a history that is empty until somebody presses it. The objection was the churn, and the churn is gone rather than the discovery.

**Stale locators are never pruned from a listing**, which looked wrong until the OpenCode measurement. An agent that advertises `list` and returns nothing would wipe every locator for that cwd, and resume would break for the session being opened. A phantom row that opens an empty chat is the lesser failure. Related: an advertised capability is not a promise of data ([[concept_acp_agent_quirks]]).

**`MAX_SESSION_PAGES = 10` bounds the cursor walk.** What a full ten pages drops is the *oldest* history, since listings come back newest-first, and it is deliberately not reported: a message on every chat open would be worse than the limit.

**Deleting an ACP row removes the locator and nothing else.** That is the whole of what Tori owns; the agent's own copy survives and a later listing legitimately brings the row back. ACP has `session/delete` behind `sessionCapabilities.delete`, which is the honest fix and is not yet wired.

**Protocol listing does surface sessions started outside Tori**, which this plan had pessimistically assumed it would not. `session/list` against `claude-agent-acp` in one repo returned 2 cwd-filtered rows matching the 2 transcripts on disk, and 50 unfiltered with a `nextCursor`. So an ACP harness does not lose terminal-started history. What a listed row cannot carry is the sidebar's other columns: it has `sessionId`, `cwd`, `title` and `updatedAt`, no branch, no created-at, no agent id, and the title is the raw first prompt.

**A session Tori's own probe opened is never adopted**, and the filter is inside `adopt` itself as a `probe_cwds: &[String]` parameter, so no future caller can forget it. The slice rather than a path keeps `adopt` pure: the caller resolves the spellings against the filesystem and `adopt` only compares, with **both** `/var` and `/private/var` passed. Rejected alternative: remembering the probe's session ids, which a crashed probe never records. See [[concept_no_turn_probe]].

## Related

- [[concept_no_turn_probe]] — whose sessions this filter exists to hide
- [[component_acp_transport]] — the transport this serves
- [[adr_three_session_stores]] — the stores this became a fourth kind of record beside
- [[concept_folder_anchored_sessions]] — the cwd prefix rule the canonicalisation bug broke
- [[concept_one_directory_two_spellings]] — the pattern behind all three canonicalisation bugs here
- [[lesson_a_test_that_reads_what_its_subject_wrote]] — how the Codex listing measurement passed while proving nothing
- [[concept_session_certainty_tiers]] — where a protocol-backed session sits
- [[concept_acp_agent_quirks]] — the advertise-then-verify rule this store is built around
