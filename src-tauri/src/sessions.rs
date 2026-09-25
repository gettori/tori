// Session discovery for every registered agent adapter, merged by folder.
//
// **Tori keeps three session stores, and only the third is derived.** Naming
// them is the point of `adr_three_session_stores`, because folding any two
// together loses something:
//
//   1. **The agent's own transcripts are the truth.** Tori reads them and
//      never writes them. Delete Tori entirely and they are still there.
//   2. **The rename overlay is Tori-authored** (`set_session_name`,
//      `load_overlay`/`save_overlay`, below). It holds what the user typed,
//      which nothing on disk records and no rescan can reproduce, so it is
//      never rebuilt and never rebuildable.
//   3. **The index is derived and discardable** (`SessionIndex`, an in-memory
//      mtime cache). Every field in it, the profile tag included, comes out of
//      a transcript or the root that held it. Throw it away, rescan, and it
//      comes back identical, which is what keeps `concept_filesystem_source_of_truth`
//      true while a cache exists at all.
//
// The invariant that keeps them apart: **the index holds no user-authored
// field.** `SessionMeta.name` and `.profile_label` are stamped onto a *listing*
// by `list_sessions`, out of the overlay and out of `accounts.json`, and are
// never what the cache stored.
//
// Claude sessions live at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
// The encoded dir name is lossy, so we read `cwd` and `gitBranch` from inside
// each file rather than decoding the folder name. That path is
// `agents::registry()` data rather than hardcoded here - see agents.rs, and
// nothing in this file names an agent.
//
// Scanning reads only the head of each file (cwd/branch/first prompt appear
// early) and caches by mtime, so repeat scans are cheap. `list_sessions(folder)`
// returns every adapter's sessions whose recorded cwd is the folder or nested
// under it.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agents;

const HEAD_LINES: usize = 60;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub path: String,
    pub cwd: String,
    pub branch: String,
    pub title: String,
    pub last_active: u64,
    /// File creation time (btime, falling back to mtime), epoch seconds. Lets
    /// the frontend attribute a just-spawned tab to the session that appeared
    /// after it (`created_at >= tab spawn time`), not merely one that shares
    /// its cwd (an older session's mtime would also satisfy a bare freshness
    /// check, since mtime updates on every turn).
    pub created_at: u64,
    pub name: Option<String>,
    /// Which agent produced the session: the adapter id it was discovered under.
    pub agent: String,
    /// Which account produced it: the profile id whose transcript root held the
    /// file. **Derived, never recorded**: Phase 0 measured that a session run
    /// under an isolated home writes its transcript beneath that home, so the
    /// root that produced a row is the whole of the attribution and a discarded
    /// index rebuilds every tag.
    ///
    /// `None` for a session Tori cannot attribute rather than one it guesses at:
    /// an ACP row comes out of Tori's locator store, which records no profile. A
    /// session started in a terminal under a config dir Tori has no profile for
    /// is not misattributed either, it is simply never discovered, because Tori
    /// only scans the roots it has profiles for.
    pub profile: Option<String>,
    /// The user's own label for that profile, stamped onto a *listing* by
    /// `list_sessions` and never held in the index: a label is user-authored,
    /// and the index holds no user-authored field.
    ///
    /// `None` while the agent has only the one account, so a machine that
    /// never added a second sees exactly what it saw before: naming an account
    /// that nothing is being distinguished from is noise.
    pub profile_label: Option<String>,
}

struct CacheEntry {
    mtime: SystemTime,
    meta: Option<SessionMeta>,
}

#[derive(Default)]
pub struct SessionIndex(Mutex<HashMap<PathBuf, CacheEntry>>);

#[derive(Default)]
pub struct SessionWatch(pub Mutex<Option<RecommendedWatcher>>);

fn norm(path: &str) -> String {
    path.trim_end_matches('/').to_string()
}

fn epoch_secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Pull a human title from a user message's content (string or text blocks).
fn extract_text(content: &serde_json::Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

/// True only for a message a human actually typed: it has visible text (so
/// tool-result and tool-use-only turns, whose content carries no text block,
/// are excluded) and isn't a slash-command/tag envelope (`<...>`) or a
/// `[Context]` block. Used to count prompts, not raw transcript turns.
pub(crate) fn is_human_prompt(content: &serde_json::Value) -> bool {
    match extract_text(content) {
        Some(t) => {
            let t = t.trim();
            !t.is_empty() && !t.starts_with('<') && !t.starts_with("[Context]")
        }
        None => false,
    }
}

/// True for the markup a agent files under the user's own role when a slash
/// command runs: the command envelope (`<command-name>/model</command-name>`
/// and its `-message`/`-args` siblings), the command's own output
/// (`<local-command-stdout>`), and the caveat that introduces both.
///
/// **The person typed `/model haiku`, not this.** The agent wrote the markup
/// for its own consumption and never showed it to them, so replaying it puts
/// words in their mouth - and a transcript that does that also counts them,
/// which is how a session with three prompts came to report seven. Excluded
/// from the replay for the same reason `is_human_prompt` excludes it from the
/// counts: it is plumbing, not conversation.
///
/// Matched on the opening tag rather than on a leading `<`, so a prompt that
/// genuinely starts with markup (a pasted snippet, an XML question) is still
/// the user's message.
pub(crate) fn is_command_envelope(text: &str) -> bool {
    let t = text.trim_start();
    [
        "<command-name>",
        "<command-message>",
        "<command-args>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<local-command-caveat>",
    ]
    .iter()
    .any(|tag| t.starts_with(tag))
}

/// The body of the first closed `<tag>…</tag>` pair in `text`.
fn tag_body<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

/// Two different things land under the user's role wearing the same `<command-*>`
/// markup, and only one of them is a prompt:
///
/// - a **client-side command** (`/clear`, `/model`, `/login`) - the agent runs
///   it locally, prefixes it with `<local-command-caveat>` ("DO NOT respond to
///   these messages") and files its result as `<local-command-stdout>`;
/// - a **skill invocation** (`/plan …`, `/gg`) - no caveat, and the text the
///   person typed after the command name sits in `<command-args>`.
///
/// The caveat is what separates them, so it is tracked rather than the tag order
/// (which the agent varies). Without the split, a session opened with
/// `/model haiku` would take that as its title over the `hello` typed next.
fn is_local_command_caveat(text: &str) -> bool {
    text.trim_start().starts_with("<local-command-caveat>")
}

/// A client-side command's own output: the agent talking to itself.
fn is_local_command_output(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<local-command-stdout>") || t.starts_with("<local-command-stderr>")
}

/// The envelope a slash command is filed under. The three tags appear in either
/// order depending on how the command was invoked, so any of them opens one.
fn is_command_invocation(text: &str) -> bool {
    let t = text.trim_start();
    ["<command-name>", "<command-message>", "<command-args>"]
        .iter()
        .any(|tag| t.starts_with(tag))
}

/// What the person typed to invoke a skill, reassembled from the envelope:
/// `/plan tidy the sidebar` out of `<command-name>/plan</command-name>` plus
/// `<command-args>tidy the sidebar</command-args>`. A command with no args is
/// the whole of what they typed (`/gg`), so it stands alone. `None` when the
/// envelope names no command, which leaves the session untitled rather than
/// titled with a fragment of markup.
///
/// Only titles are recovered this way. `is_human_prompt` still excludes the
/// envelope from the prompt *counts*, and deliberately so: a title identifies a
/// session, a count measures a conversation.
fn command_prompt(text: &str) -> Option<String> {
    let name = tag_body(text, "command-name")?.trim();
    if name.is_empty() {
        return None;
    }
    match tag_body(text, "command-args").unwrap_or("").trim() {
        "" => Some(name.to_string()),
        args => Some(format!("{name} {args}")),
    }
}

/// One half of a client-side command, as a turn of its own: the invocation
/// (`/usage`) or what it printed. `None` for anything that is neither.
///
/// Role `"command"` and not `"user"`, which is the whole point. The markup is
/// something the agent wrote for its own consumption, so replaying it as a
/// message puts words in the person's mouth and counts a command as a prompt,
/// which is the damage [`is_command_envelope`] exists to prevent. A third role
/// keeps the output on screen without reopening either.
///
/// The two halves stay separate here because this function sees one line at a
/// time and [`tail_turns`] depends on that staying true. [`events_from_turns`]
/// joins them.
fn local_command_turn(text: &str, ts: u64) -> Option<TranscriptTurn> {
    let block = if is_local_command_output(text) {
        let body = tag_body(text, "local-command-stdout")
            .or_else(|| tag_body(text, "local-command-stderr"))
            .unwrap_or(text);
        if body.trim().is_empty() {
            return None;
        }
        text_block("command_output", body.to_string())
    } else if is_command_invocation(text) {
        text_block("command", command_prompt(text)?)
    } else {
        return None;
    };
    Some(TranscriptTurn { role: "command".into(), ts, blocks: vec![block] })
}

pub(crate) fn clean_title(raw: &str) -> String {
    let raw = tori_body(raw).unwrap_or(raw);
    let one_line: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 90 {
        let truncated: String = one_line.chars().take(90).collect();
        format!("{truncated}…")
    } else {
        one_line
    }
}

// The text inside `rpc::events::from_tori`'s marker.
fn tori_body(raw: &str) -> Option<&str> {
    let (_, body) = raw.trim().strip_prefix("<tori ")?.split_once(">\n")?;
    body.strip_suffix("\n</tori>")
}

/// One directory to scan, and the account whose sessions are in it.
///
/// The pair, not the directory alone, is what discovery walks now. A agent
/// with two accounts has two roots, and the row a root produces carries that
/// root's profile, which is the whole of profile attribution.
struct Root<'a> {
    adapter: &'a agents::AgentAdapter,
    profile: String,
    dir: PathBuf,
    managed: bool,
}

/// A profile's own transcript root: the adapter's declared discovery dir with
/// the agent's default home swapped for this profile's home.
///
/// `None` when the declared dir does not sit under the declared default home,
/// which is a misdeclared adapter rather than a case to guess at: appending the
/// dir's last segment to the profile home, or scanning the shared dir under a
/// profile's name, would both invent an attribution nobody measured. The loader
/// already refuses `supports_isolation` with a `[discovery]` table and no
/// `home_default`, so the reachable way here is a hand-edited TOML.
fn profile_root(dir: &Path, home_default: &Path, home: &str) -> Option<PathBuf> {
    let suffix = dir.strip_prefix(home_default).ok()?;
    Some(Path::new(home).join(suffix))
}

/// Every `(profile, root)` pair for one adapter, default profile first.
///
/// Pure: the profiles are passed in, so the whole rule is testable without an
/// `accounts.json` or a home directory.
fn roots_for<'a>(
    adapter: &'a agents::AgentAdapter,
    profiles: &[crate::accounts::Profile],
) -> Vec<Root<'a>> {
    let Some(agents::Discovery::File { dir, .. }) = &adapter.discovery else { return Vec::new() };
    profiles
        .iter()
        .filter_map(|p| {
            let root = match &p.home {
                // The default profile is the home variable left unset, so its
                // root is the one the adapter declares.
                None => dir.clone(),
                Some(home) => {
                    let default_home = adapter.accounts.as_ref()?.home_default.as_ref()?;
                    profile_root(dir, default_home, home)?
                }
            };
            Some(Root { adapter, profile: p.id.clone(), dir: root, managed: p.managed })
        })
        .collect()
}

/// Every `(profile, root)` pair across every registered adapter.
fn discovery_roots(file: &crate::accounts::AccountsFile) -> Vec<Root<'static>> {
    agents::registry()
        .iter()
        // `None` discovery is a protocol-backed adapter: nothing of its is on
        // disk to walk, and its sessions arrive from the locator store instead.
        .flat_map(|a| roots_for(a, &crate::accounts::profiles_for(file, &a.id)))
        .collect()
}

fn parse_session(path: &PathBuf, mtime: SystemTime, created: SystemTime, agent_id: &str) -> Option<SessionMeta> {
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut cwd: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut title: Option<String> = None;
    // Whether the last message carrying text was a `<local-command-caveat>`, which
    // disclaims the envelope directly after it. Recomputed per message rather than
    // latched, so a caveat can only ever mark the envelope it introduces: a `/clear`
    // is skipped without also silencing the `/plan` further down the same head.
    let mut after_local_caveat = false;

    for line in reader.lines().take(HEAD_LINES).map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = Some(c.to_string());
            }
        }
        if branch.is_none() {
            if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
                if !b.is_empty() {
                    branch = Some(b.to_string());
                }
            }
        }
        // The caveat is filed under the user's role *and* marked `isMeta`, so the
        // meta filter has to sit inside these branches rather than above them.
        if title.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
            if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                if let Some(text) = extract_text(content) {
                    let trimmed = text.trim();
                    let is_meta = v.get("isMeta").and_then(|m| m.as_bool()) == Some(true);
                    let is_caveat = is_local_command_caveat(trimmed);
                    if is_caveat {
                        // Marks only the next message, so nothing to do here.
                    } else if is_local_command_output(trimmed) {
                        // A client-side command's output, never a prompt.
                    } else if is_command_invocation(trimmed) {
                        if !after_local_caveat && !is_meta {
                            title = command_prompt(trimmed).map(|p| clean_title(&p));
                        }
                    } else if !is_meta && !trimmed.is_empty() && !trimmed.starts_with('<') {
                        // Something a person typed. Other markup (a pasted
                        // snippet, a agent `<system_instruction>`) is not a
                        // title, and tool-result turns carry no text at all.
                        title = Some(clean_title(trimmed));
                    }
                    after_local_caveat = is_caveat;
                }
            }
        }

        if cwd.is_some() && branch.is_some() && title.is_some() {
            break;
        }
    }

    let cwd = cwd?;
    Some(SessionMeta {
        id,
        path: path.to_string_lossy().into_owned(),
        cwd,
        branch: branch.unwrap_or_default(),
        title: title.unwrap_or_else(|| "(untitled session)".into()),
        last_active: epoch_secs(mtime),
        created_at: epoch_secs(created),
        name: None,
        agent: agent_id.to_string(),
        // Filled by the caller, which is the only thing that knows which root
        // this file came out of. Nothing in a transcript names its account.
        profile: None,
        profile_label: None,
    })
}

/// Dispatch to the parser this adapter's `parser_kind` implements, stamping
/// the resulting session with the adapter's own id (not a hardcoded literal),
/// so a user-added adapter reusing an existing parser kind still shows under
/// its own agent id.
fn parse_by_adapter(
    adapter: &agents::AgentAdapter,
    profile: &str,
    path: &PathBuf,
    mtime: SystemTime,
    created: SystemTime,
) -> Option<SessionMeta> {
    match adapter.parser_kind {
        Some(agents::ParserKind::ClaudeJsonl) => {
            parse_session(path, mtime, created, &adapter.id).map(|mut s| {
                s.profile = Some(profile.to_string());
                s
            })
        }
        // Unreachable through `ensure_index`, which never walks a directory for
        // an adapter with no discovery, and answered anyway rather than
        // unwrapped: a file reached some other way is still not this adapter's
        // to parse.
        None => None,
    }
}

/// Walk every `(profile, root)` pair, refreshing the (shared, path-keyed) cache
/// for changed/new files. One cache serves every root: no two roots overlap
/// (each profile home is a distinct directory), so paths stay unique, and a
/// path is enough to say which account a row belongs to.
///
/// Takes its roots rather than finding them, so the whole walk is testable over
/// temporary directories without a registry or an `accounts.json`.
fn index_roots(index: &SessionIndex, roots: &[Root]) -> Vec<SessionMeta> {
    // Walk and parse with no lock held: only the mtimes already known are
    // snapshotted up front, and the results are swapped in at the end. Two
    // concurrent walks may both parse one changed file; both write the same
    // answer, which costs a parse and corrupts nothing.
    let known: std::collections::HashMap<PathBuf, SystemTime> = match index.0.lock() {
        Ok(c) => c.iter().map(|(k, e)| (k.clone(), e.mtime)).collect(),
        Err(_) => return vec![],
    };
    let mut parsed: Vec<(PathBuf, CacheEntry)> = Vec::new();

    // A set rather than a list: the retain below asks it once per cached entry,
    // and the number of entries is now the number of transcripts across every
    // account rather than under one root.
    let mut seen: HashSet<PathBuf> = HashSet::new();

    for root in roots {
        let Some(agents::Discovery::File { filename_regex, .. }) = &root.adapter.discovery else {
            continue;
        };
        let Ok(dirs) = std::fs::read_dir(&root.dir) else { continue };
        for dir in dirs.flatten() {
            let p = dir.path();
            if !p.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&p) else { continue };
            for f in files.flatten() {
                let fp = f.path();
                let matches_pattern = fp
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| filename_regex.is_match(n))
                    .unwrap_or(false);
                if !matches_pattern {
                    continue;
                }
                let metadata = f.metadata().ok();
                let mtime = metadata
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                let created = metadata.as_ref().and_then(|m| m.created().ok()).unwrap_or(mtime);
                seen.insert(fp.clone());

                let fresh = known.get(&fp).map(|m| *m == mtime).unwrap_or(false);
                if !fresh {
                    let meta = parse_by_adapter(root.adapter, &root.profile, &fp, mtime, created);
                    parsed.push((fp.clone(), CacheEntry { mtime, meta }));
                }
            }
        }
    }

    // Lock-swap: fold the fresh parses in and drop entries whose files
    // disappeared, all in one short hold.
    let mut cache = match index.0.lock() {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    for (k, v) in parsed {
        cache.insert(k, v);
    }
    cache.retain(|k, _| seen.contains(k));

    cache.values().filter_map(|e| e.meta.clone()).collect()
}

/// Takes the accounts file rather than reading it, so a caller that also needs
/// it for the listing's labels reads it once.
fn ensure_index(
    index: &SessionIndex,
    accounts: &crate::accounts::AccountsFile,
) -> Vec<SessionMeta> {
    let mut all = index_roots(index, &discovery_roots(accounts));
    all.extend(acp_sessions());
    all
}

/// The ACP sessions Tori has locators for, as listing rows.
///
/// Merged in beside adapter discovery rather than expressed as a `Discovery`
/// variant, and the distinction is real rather than a dodge: `Discovery` says
/// where *an adapter* keeps its sessions, and an ACP agent keeps them somewhere
/// only the protocol reaches. No directory-and-regex could describe it, and a
/// parser kind would have nothing to parse. What Tori has instead is its own
/// record of what the protocol told it, which is one store shared by every ACP
/// adapter rather than a per-adapter one. See `chat::acp_sessions`.
///
/// Only four fields come from the wire, so only four are filled. **`branch` is
/// empty on purpose**: a listed row carries none, and the folder Tori happens to
/// be showing is a different session's branch as often as it is this one's.
/// `created_at` repeats `last_active` because ACP records no creation time; the
/// frontend uses it to attribute a just-spawned tab, and an invented earlier
/// date would attribute the wrong one.
fn acp_sessions() -> Vec<SessionMeta> {
    crate::chat::acp_sessions::all().into_iter().map(acp_meta).collect()
}

/// One recorded ACP session as a listing row. Pure, so what a listed row does
/// and does not carry is assertable without a live agent.
fn acp_meta(s: crate::chat::acp_sessions::AcpSession) -> SessionMeta {
    SessionMeta {
        path: crate::chat::acp_sessions::locator_path(&s.id)
            .to_string_lossy()
            .into_owned(),
        id: s.id,
        cwd: s.cwd,
        branch: String::new(),
        title: s.title,
        last_active: s.updated_at,
        created_at: s.updated_at,
        name: None,
        agent: s.agent,
        // A locator records no account, and there is no root that produced it to
        // derive one from. Unattributed rather than defaulted to the account the
        // user happens to have.
        profile: None,
        profile_label: None,
    }
}

/// Does a session's recorded `cwd` belong to `folder` (the folder itself or a
/// nested subdir)? This is the cwd-anchored, prefix-matching rule.
pub(crate) fn cwd_matches(cwd: &str, folder: &str) -> bool {
    let c = norm(cwd);
    let f = norm(folder);
    c == f || c.starts_with(&format!("{f}/"))
}

/// The listing's ownership rule: `cwd_matches`, minus anything under the
/// folder's own `.tori/worktrees/`. Those are Topic worktrees and the member
/// folder claims them by prefix, so the repo would otherwise list them as its
/// own. Teardown (`ids_under`) keeps the plain prefix rule on purpose: removing
/// the repo must still find every session it physically contained.
pub(crate) fn owned_by_listing(cwd: &str, folder: &str) -> bool {
    let f = norm(folder);
    cwd_matches(cwd, folder) && !norm(cwd).starts_with(&format!("{f}/.tori/worktrees/"))
}

/// Filter to sessions under `folder` and sort most-recently-active first.
/// `inclusive` is the teardown rule (plain prefix): a destructive confirm has
/// to count what removing the folder will kill, Topic worktrees included.
fn filter_sort(all: Vec<SessionMeta>, folder: &str, inclusive: bool) -> Vec<SessionMeta> {
    let mut v: Vec<SessionMeta> = all
        .into_iter()
        .filter(|s| if inclusive { cwd_matches(&s.cwd, folder) } else { owned_by_listing(&s.cwd, folder) })
        .collect();
    v.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    v
}

/// Every session across every registered agent, unfiltered by folder.
/// `crate::hooks::prune_stale`'s only caller - not a `#[tauri::command]`,
/// the frontend has no use for an unscoped list.
pub(crate) fn all_sessions(index: &SessionIndex) -> Vec<SessionMeta> {
    ensure_index(index, &crate::accounts::load())
}

/// A listing for the app socket: every agent and account, stamped like
/// `list_sessions`, newest first, narrowed to `folder` and everything under it
/// (Topic worktrees included) when one is given.
pub(crate) fn listed_sessions(index: &SessionIndex, folder: Option<&str>) -> Vec<SessionMeta> {
    let accounts = crate::accounts::load();
    let all = ensure_index(index, &accounts);
    let rows = match folder {
        Some(folder) => filter_sort(all, folder, true),
        None => {
            let mut all = all;
            all.sort_by(|a, b| b.last_active.cmp(&a.last_active));
            all
        }
    };
    stamp_listing(rows, &load_overlay(), &accounts)
}

/// The ids of every session anchored at `folder` or under it.
///
/// For teardown, where the question is "what did this directory own" rather
/// than "what should the tree show", so the overlay's names and archive flags
/// are beside the point. Must be called while the directory still exists: a
/// session is found by its recorded `cwd`, and nothing matches a path that is
/// already gone.
pub(crate) fn ids_under(index: &SessionIndex, folder: &str) -> Vec<String> {
    ensure_index(index, &crate::accounts::load())
        .into_iter()
        .filter(|s| cwd_matches(&s.cwd, folder))
        .map(|s| s.id)
        .collect()
}

/// Sessions (every registered agent) anchored at `folder` or nested under it,
/// newest first.
#[tauri::command(async)]
pub fn list_sessions(
    index: State<SessionIndex>,
    projects: State<crate::config::ProjectIndex>,
    folder: String,
    inclusive: Option<bool>,
) -> Result<Vec<Listed>, String> {
    let accounts = crate::accounts::load();
    let rows = filter_sort(ensure_index(&index, &accounts), &folder, inclusive.unwrap_or(false));
    let spaces = match rows.is_empty() {
        true => Default::default(),
        false => crate::unit_home::spaces(&projects),
    };
    Ok(stamp_listing(rows, &load_overlay(), &accounts)
        .into_iter()
        .map(|meta| {
            let branch = Some(meta.branch.as_str()).filter(|b| !b.is_empty());
            let home = crate::unit_home::home_of(&spaces, &meta.cwd, branch);
            Listed { meta, home }
        })
        .collect())
}

/// A listing row with the unit row it sits under, which the sidebar reads
/// rather than working out the plain repo branch rule a second time.
#[derive(Serialize)]
pub struct Listed {
    #[serde(flatten)]
    meta: SessionMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    home: Option<crate::unit_home::Home>,
}

/// Add the two user-authored fields to a listing.
///
/// Both are applied here rather than in the index, which is the invariant that
/// keeps the three stores apart (see this file's header): a rename and an
/// account's label are things the user typed, and no rescan could reproduce
/// either. Pure, so "discard the index and every row, rename and profile tag
/// comes back" is assertable without touching the running user's stores.
fn stamp_listing(
    rows: Vec<SessionMeta>,
    overlay: &HashMap<String, Overlay>,
    accounts: &crate::accounts::AccountsFile,
) -> Vec<SessionMeta> {
    rows.into_iter()
        .map(|mut s| {
            if let Some(o) = overlay.get(&s.id) {
                s.name = o.name.clone();
            }
            s.profile_label = profile_label(accounts, &s.agent, s.profile.as_deref());
            s
        })
        .collect()
}

/// The user's label for the account a row came from, or `None` when naming it
/// would distinguish nothing.
///
/// Both user-authored halves of a listing are applied here rather than in the
/// index: a rename and an account label are things the user typed, and the
/// index holds no user-authored field (see this file's header).
fn profile_label(
    file: &crate::accounts::AccountsFile,
    agent: &str,
    profile: Option<&str>,
) -> Option<String> {
    let profile = profile?;
    let profiles = crate::accounts::profiles_for(file, agent);
    // One account is every machine that never added a second, and it is the
    // "renders exactly as today" case: there is nothing to tell apart.
    if profiles.len() < 2 {
        return None;
    }
    profiles.into_iter().find(|p| p.id == profile).map(|p| p.label)
}

// --- adopted-paths state (recreated-folder / "Historical" sessions) ---
//
// A folder recreated at a path where old sessions still live would otherwise
// surface those ghosts as if they belonged to it. `adopted_paths` is the set of
// folders whose sessions are "ours". It is stored SEPARATELY from the watched
// tori.toml (writing the toml would loop the config watcher). A folder not in the
// set whose sessions predate its own creation is "historical" until adopted.

#[derive(Serialize, Deserialize, Default)]
struct AdoptedState {
    /// Seeded once, on the first discovery that yields >=1 folder, so a fresh
    /// install does not flag the user's pre-existing folders as historical.
    seeded: bool,
    /// Normalized folder paths whose sessions are adopted (shown normally).
    paths: HashSet<String>,
}

fn adopted_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/tori/adopted.json")
}

fn load_adopted() -> AdoptedState {
    std::fs::read_to_string(adopted_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_adopted(state: &AdoptedState) -> Result<(), String> {
    let path = adopted_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Pure seed step: adopt all `folders` exactly once, and never against an empty
/// discovery. Returns whether the state changed (so the caller persists).
fn do_seed(state: &mut AdoptedState, folders: &[String]) -> bool {
    if state.seeded || folders.is_empty() {
        return false;
    }
    for f in folders {
        state.paths.insert(norm(f));
    }
    state.seeded = true;
    true
}

enum FolderVerdict {
    /// Already adopted, or nothing to hide: show normally.
    Adopted,
    /// Sessions all postdate the folder: they are ours, adopt and show normally.
    AutoAdopt,
    /// Not adopted, with sessions predating the folder: hide under "Historical".
    Historical,
}

/// Decide a folder's status from the adopted set, its sessions' activity times,
/// and the folder's own creation time. Pure, so it is unit-tested directly.
fn folder_verdict(
    adopted: &HashSet<String>,
    folder: &str,
    session_times: &[u64],
    folder_created: u64,
) -> FolderVerdict {
    if adopted.contains(&norm(folder)) {
        return FolderVerdict::Adopted;
    }
    if session_times.is_empty() {
        return FolderVerdict::Adopted; // no ghosts to hide
    }
    if session_times.iter().all(|&t| t >= folder_created) {
        return FolderVerdict::AutoAdopt;
    }
    FolderVerdict::Historical
}

/// Folder creation time (btime, falling back to mtime), in epoch seconds.
fn folder_created(p: &Path) -> u64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.created().ok().or_else(|| m.modified().ok()))
        .map(epoch_secs)
        .unwrap_or(0)
}

/// Adopt a folder's sessions (idempotent). Called by the UI "Adopt" action and
/// whenever Tori itself creates a folder (new folder / worktree / clone / bootstrap).
pub fn adopt(path: &str) -> Result<(), String> {
    let mut state = load_adopted();
    if state.paths.insert(norm(path)) {
        save_adopted(&state)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn adopt_path(path: String) -> Result<(), String> {
    // Load-modify-save on the sessions-store store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("sessions-store");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    adopt(&path)
}

/// Seed the adopted set from the current discovery (idempotent; no-op once seeded
/// or when discovery is empty). The UI calls this after each `get_config`.
#[tauri::command(async)]
pub fn seed_adopted(folders: Vec<String>) -> Result<(), String> {
    // Load-modify-save on the sessions-store store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("sessions-store");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut state = load_adopted();
    if do_seed(&mut state, &folders) {
        save_adopted(&state)?;
    }
    Ok(())
}

/// Is `folder` historical (a recreated folder whose sessions predate it)? Adopts
/// it in passing when its sessions clearly belong to it (all postdate creation).
#[tauri::command(async)]
pub fn folder_historical(
    index: State<SessionIndex>,
    folder: String,
) -> Result<bool, String> {
    let state = load_adopted();
    let times: Vec<u64> = filter_sort(ensure_index(&index, &crate::accounts::load()), &folder, false)
        .iter()
        .map(|s| s.last_active)
        .collect();
    let created = folder_created(Path::new(&folder));
    match folder_verdict(&state.paths, &folder, &times, created) {
        FolderVerdict::Historical => Ok(true),
        FolderVerdict::AutoAdopt => {
            adopt(&folder)?;
            Ok(false)
        }
        FolderVerdict::Adopted => Ok(false),
    }
}

// --- rename overlay (Claude has no native rename) ---

/// Renames, and nothing else. An overlay written before archiving was removed
/// also carries an `archived` key; serde ignores unknown fields, so such a file
/// still parses and every rename in it survives (see
/// gotchas#serde-ignores-unknown-fields-so-a-version-field-alone-cannot-gate-a-format
/// - the same property that makes a version field useless as a gate is what
/// makes this migration free). The residual key is **pruned on the next write**
/// rather than kept: `save_overlay` re-serializes the whole map from this
/// struct, so the first rename anywhere drops it for every session at once.
/// Keeping it would mean carrying a field nothing reads for as long as the file
/// lives.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Overlay {
    #[serde(default)]
    name: Option<String>,
}

fn overlay_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/tori/sessions.json")
}

fn load_overlay() -> HashMap<String, Overlay> {
    std::fs::read_to_string(overlay_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_overlay(map: &HashMap<String, Overlay>) -> Result<(), String> {
    let path = overlay_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn set_session_name(app: AppHandle, id: String, name: Option<String>) -> Result<(), String> {
    // Load-modify-save on the sessions-store store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("sessions-store");
    let _store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut map = load_overlay();
    map.entry(id).or_default().name = name.filter(|n| !n.trim().is_empty());
    save_overlay(&map)?;
    // The overlay file lives outside the watched transcript dirs, so writing it
    // fires no filesystem event. Notify explicitly so every listener refreshes,
    // not just the caller: the sidebar tree AND the terminal tab titles, which
    // otherwise keep the name they were created with (an un-refreshed rename).
    let _ = app.emit("sessions://changed", SessionsChanged::all());
    crate::rpc::sessions_changed();
    Ok(())
}

/// Delete a session's transcript. Destructive (removes the agent's own
/// history); the frontend confirms first.
///
/// A session with **no transcript at all** is a different act wearing the same
/// button. Its conversation lives wherever its agent keeps it, and no protocol
/// verb removes one, so all that can happen is that Tori drops its own record
/// and stops listing it. That branch goes through `acp_sessions::forget`, which
/// also refuses a path outside Tori's store, rather than reaching
/// `remove_file` with an arbitrary path and a protocol-backed agent's name.
#[tauri::command(async)]
pub fn delete_session(path: String, agent: String) -> Result<(), String> {
    // Load-modify-save on the sessions-store store: serialized behind a named
    // lock now that commands no longer queue on one IPC thread.
    let store = crate::exec::named_lock("sessions-store");
    let guard = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    match agents::parser_kind_for(&agent) {
        Some(agents::ParserKind::ClaudeJsonl) => {
            // What this session attached, asked while its transcript is still
            // there to ask. Swept after the delete, so the transcript being
            // removed is not counted as a reference to itself.
            let attached = crate::attachments::holders_named_by(Path::new(&path), &crate::attachments::dir());
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            // The sweep reads every transcript under every root, and the store
            // this lock serialises is already done with: the session is gone.
            drop(guard);
            crate::attachments::drop_unreferenced(&attached, &watch_dirs());
            Ok(())
        }
        None => crate::chat::acp_sessions::forget(Path::new(&path)),
    }
}

/// Extended-regex pattern for `pgrep -f` (BSD pgrep treats the pattern as ERE
/// natively, no `-E` needed) that matches only a live `agent` process actually
/// resuming session `id` - not merely any process whose command line contains
/// the id, which is what a bare `pgrep -f <uuid>` would also catch (a `less`/
/// `tail`/editor with the transcript file open). The template itself is now
/// adapter data (`agents::session_pattern`); this stays as the call site's
/// entry point so callers/tests are unaffected by the registry underneath.
///
/// `None` for an adapter that declares no pattern, which every caller here
/// answers the same way: the process table cannot speak for this agent, so it is
/// not asked.
fn session_pattern(agent: &str, id: &str) -> Option<String> {
    agents::session_pattern(agent, id)
}

/// Can a live session of `agent` be recognised from the process table?
///
/// True for a agent that puts the session id on its command line, which is
/// what `session_pattern` matches against. **False for ACP**, whose agents are
/// launched as a plain `opencode acp` and mint the session id inside the
/// protocol: two sessions of one ACP agent are two identical command lines, so
/// a pattern match would report all of them running whenever any one was.
///
/// Read off the adapter's declared transport rather than its id, so a
/// user-added ACP agent answers correctly without being named here.
fn found_by_pattern(agent: &str) -> bool {
    !matches!(
        agents::find(agent).and_then(|a| a.chat.as_ref()).map(|c| c.transport),
        Some(agents::ChatTransport::Acp)
    )
}

/// Is a live `agent` process currently resuming session `id`?
///
/// One subprocess per call, so it is for the single-session callers only (a tab
/// about to spawn, a guard on one folder). Anything asking about a *set* of
/// sessions must use `sessions_running`, whose cost does not scale with the
/// number of ids.
#[tauri::command(async)]
pub fn session_running(
    state: State<'_, crate::chat::host::ChatState>,
    id: String,
    agent: String,
) -> Result<bool, String> {
    if !found_by_pattern(&agent) {
        return Ok(!state.0.registry.sessions_with_live_child(&[id]).is_empty());
    }
    Ok(running_by_pattern(&agent, &id))
}

/// Is a live `agent` process resuming session `id` that **this Tori is not
/// driving**?
///
/// The question the two routing gates actually ask, and the one
/// [`session_running`] answers wrongly for them. A chat session's child belongs
/// to this process, not to the webview: reload the frontend and every tab is
/// gone while the child is still there, still carrying the session id on its
/// command line. The pgrep then finds Tori's own child and reports the session
/// as somebody else's, which routed a reopen onto the PTY surface and got it
/// refused by the chat claim this same process holds.
///
/// A session the chat host still has is not elsewhere: `chat_spawn` rewires it
/// instead of resuming it, so no second driver is ever created.
///
/// **False for ACP**, through [`running_by_pattern`] and not by omission: an ACP
/// agent's command line names no session, so no process can be attributed to one
/// - and the only ACP children we could name are our own, which is the case this
/// answers `false` for anyway.
#[tauri::command(async)]
pub fn session_running_elsewhere(
    state: State<'_, crate::chat::host::ChatState>,
    id: String,
    agent: String,
) -> Result<bool, String> {
    Ok(running_by_pattern(&agent, &id) && !state.0.is_live(&id))
}

/// The process-table half of [`session_running`], and the whole of the answer
/// the ownership registry can use.
///
/// Split out because the registry asks this question from *inside* a claim, with
/// no Tauri state to reach the registry through - and asking a registry about
/// itself mid-claim would be circular anyway. For an agent whose sessions are
/// not findable by pattern the answer is a flat `false`: "a process outside Tori
/// is resuming this session" is a claim nothing about an ACP agent can support,
/// and guessing it from a command line that names no session would contest every
/// session of that agent at once.
pub(crate) fn running_by_pattern(agent: &str, id: &str) -> bool {
    if !found_by_pattern(agent) {
        return false;
    }
    let Some(pattern) = session_pattern(agent, id) else { return false };
    let out = Command::new("pgrep").args(["-f", &pattern]).output();
    out.map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// One session to probe: an id is only meaningful against the agent that owns it.
#[derive(Deserialize)]
pub struct SessionRef {
    pub id: String,
    pub agent: String,
}

/// The command lines of every live process that looks like a session of `agent`.
///
/// One `pgrep` for the whole agent rather than one per id, driven by the
/// adapter's own running pattern with the id slot generalized to "one argument
/// token". Reusing that pattern is what keeps this from assuming anything new
/// about the agent: it already encodes what a live session of this agent looks
/// like, so a user-added adapter whose program is spelled nothing like its id
/// still works.
///
/// `-lf`, not `-af`. On BSD/macOS `pgrep -a` means "include process ancestors"
/// and prints bare pids; `-l` combined with `-f` is what prints the full
/// argument list this has to match against.
fn agent_command_lines(agent: &str) -> Vec<String> {
    // No pattern, no command lines: an adapter whose sessions are not on any
    // command line has none to collect, and `running_ids` would reject them all
    // anyway.
    let Some(any_session) = session_pattern(agent, "[^ ]+") else { return Vec::new() };
    let out = match Command::new("pgrep").args(["-lf", &any_session]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split_once(' ').map(|(_pid, cmd)| cmd.to_string()))
        .collect()
}

/// Which of `ids` a live `agent` process is driving, given command lines already
/// in hand. Pure, so the matching is tested against captured `pgrep` output
/// instead of whatever happens to be running on the machine.
fn running_ids(agent: &str, ids: &[String], command_lines: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| match session_pattern(agent, id).map(|p| regex::Regex::new(&p)) {
            Some(Ok(re)) => command_lines.iter().any(|l| re.is_match(l)),
            // An id that will not compile into a pattern matches nothing rather
            // than everything: a session wrongly reported dead costs a redundant
            // spawn, one wrongly reported alive loses the user's work. An
            // adapter with no pattern at all is the same answer for a different
            // reason: nothing about its command line names a session.
            Some(Err(_)) | None => false,
        })
        .cloned()
        .collect()
}

/// Which of `sessions` have a live agent process driving them, as the subset of
/// ids that are running.
///
/// Spawns one `pgrep` per *registered agent*, never one per id. The folder sweep
/// this exists for asks about every session in a folder at once, and at one
/// subprocess per id a 47-session folder costs 47 spawns; throttling only
/// spreads that out rather than removing it.
/// Group `sessions` by agent, then resolve each agent's ids against the command
/// lines `lines_for` returns for it. Split from the command so that "one lookup
/// per agent, whatever the number of ids" is a property a test can observe
/// rather than infer from the source.
///
/// The ids are de-duplicated: callers count the returned list
/// (`tabs.length + detached`), so a repeated id would read as two live sessions.
///
/// An agent whose sessions are not findable by pattern is resolved through
/// `live_children` instead, which asks the ownership registry about the whole
/// batch at once rather than probing one session at a time. Injected for the
/// same reason `lines_for` is: the split between the two routes is then a
/// property a test can observe rather than infer.
fn resolve_running(
    sessions: Vec<SessionRef>,
    by_pattern: impl Fn(&str) -> bool,
    lines_for: impl Fn(&str) -> Vec<String>,
    live_children: impl Fn(&[String]) -> Vec<String>,
) -> Vec<String> {
    let mut by_agent: HashMap<String, Vec<String>> = HashMap::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for s in sessions {
        if seen.insert((s.agent.clone(), s.id.clone())) {
            by_agent.entry(s.agent).or_default().push(s.id);
        }
    }
    let mut running = Vec::new();
    for (agent, ids) in by_agent {
        if !by_pattern(&agent) {
            running.extend(live_children(&ids));
            continue;
        }
        let lines = lines_for(&agent);
        running.extend(running_ids(&agent, &ids, &lines));
    }
    running
}

#[tauri::command(async)]
pub fn sessions_running(
    state: State<'_, crate::chat::host::ChatState>,
    sessions: Vec<SessionRef>,
) -> Result<Vec<String>, String> {
    let asked: Vec<(String, String)> = sessions.iter().map(|s| (s.id.clone(), s.agent.clone())).collect();
    let running = running_now(&state.0.registry, sessions);
    crate::rpc::note_running(&asked, &running);
    Ok(running)
}

pub(crate) fn running_now(registry: &crate::chat::ownership::Registry, sessions: Vec<SessionRef>) -> Vec<String> {
    resolve_running(sessions, found_by_pattern, agent_command_lines, |ids| registry.sessions_with_live_child(ids))
}

#[derive(Serialize, Default)]
pub struct SessionDetail {
    /// Messages the human actually typed (see `is_human_prompt`).
    pub prompt_count: u32,
    /// Agent replies (assistant messages).
    pub turn_count: u32,
    /// Tool invocations across the session.
    pub tool_count: u32,
    pub output_tokens: u64,
    pub context_tokens: u64,
    pub model: Option<String>,
    /// Times this session was compacted (Claude `compact_boundary` markers).
    pub compaction_count: u32,
    /// Context tokens reclaimed across those compactions, where the transcript
    /// records both pre and post sizes. 0 means unknown, never "zero
    /// reclaimed".
    pub compaction_reclaimed: u64,
    /// Distinct files this session wrote, created, or deleted (reads excluded).
    pub touched_count: u32,
}

/// Every `SessionDetail` field the transcript scan produces, except
/// `touched_count` (which needs the touched-files cache and a Tauri `State`).
/// Returned by the pure `scan_counts` helper so those counts are unit-testable.
pub(crate) struct RawCounts {
    pub prompt_count: u32,
    pub turn_count: u32,
    pub tool_count: u32,
    pub output_tokens: u64,
    pub context_tokens: u64,
    pub model: Option<String>,
    pub compaction_count: u32,
    pub compaction_reclaimed: u64,
}

/// Single linear pass over a transcript, producing every non-touched count.
/// Claude tags user/assistant at the top level with a
/// `{output,input,cache_*}_tokens` usage. Dispatch is by each record's `type`,
/// so no agent hint is needed. Pure - takes a reader, touches no Tauri state -
/// so the counts are unit-testable directly.
pub(crate) fn scan_counts(reader: impl BufRead) -> RawCounts {
    let mut prompt_count = 0u32;
    let mut turn_count = 0u32;
    let mut tool_count = 0u32;
    let mut output_tokens = 0u64;
    let mut context_tokens = 0u64;
    let mut model: Option<String> = None;
    let mut compaction_count = 0u32;
    let mut compaction_reclaimed = 0u64;

    for line in reader.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // Claude: the turn is the top-level record.
            Some(kind @ ("user" | "assistant")) => {
                if kind == "user" && v.get("isMeta").and_then(|m| m.as_bool()) != Some(true) {
                    if let Some(c) = v.get("message").and_then(|m| m.get("content")) {
                        if is_human_prompt(c) {
                            prompt_count += 1;
                        }
                    }
                }
                if kind == "assistant" {
                    turn_count += 1;
                    if let Some(msg) = v.get("message") {
                        // Each tool_use block in the reply is one tool call.
                        if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
                            tool_count += arr
                                .iter()
                                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                                .count() as u32;
                        }
                        if let Some(m) = msg.get("model").and_then(|m| m.as_str()) {
                            model = Some(m.to_string());
                        }
                        if let Some(u) = msg.get("usage") {
                            let get = |k: &str| u.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                            output_tokens += get("output_tokens");
                            // The newest API response's input is the context, as
                            // Anthropic's own status line defines it: input plus
                            // both cache figures, output excluded because it
                            // becomes input on the next request and would be
                            // counted twice. Assigned, never summed: each
                            // response already carries the whole conversation,
                            // so adding them counts the same history once per
                            // request and crosses the window long before the
                            // session does.
                            //
                            // Sidechains are skipped, the way compactions below
                            // already skip them. A subagent runs in a context of
                            // its own, so a Task finishing last would otherwise
                            // leave the strip reporting the subagent's occupancy
                            // as the conversation's.
                            if v.get("isSidechain").and_then(|b| b.as_bool()) != Some(true) {
                                context_tokens = get("input_tokens")
                                    + get("cache_read_input_tokens")
                                    + get("cache_creation_input_tokens");
                            }
                        }
                    }
                }
            }
            // Claude: a compaction boundary. Skip sidechain (subagent) records so
            // only top-level compactions count, matching ccstatusline. Reclaimed
            // is summed only when both pre and post token sizes are present.
            Some("system") => {
                if v.get("subtype").and_then(|s| s.as_str()) == Some("compact_boundary")
                    && v.get("isSidechain").and_then(|b| b.as_bool()) != Some(true)
                {
                    compaction_count += 1;
                    if let Some(m) = v.get("compactMetadata") {
                        let get = |k: &str| m.get(k).and_then(|n| n.as_u64());
                        if let (Some(pre), Some(post)) = (get("preTokens"), get("postTokens")) {
                            compaction_reclaimed += pre.saturating_sub(post);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    RawCounts {
        prompt_count,
        turn_count,
        tool_count,
        output_tokens,
        context_tokens,
        model,
        compaction_count,
        compaction_reclaimed,
    }
}

/// Read the full transcript once (only on selection) for counts and tokens,
/// then attach the touched-file count (which rides its own cache). The
/// per-line scan lives in `scan_counts`.
#[tauri::command(async)]
pub fn session_detail(
    touched: State<TouchedIndex>,
    path: String,
    agent: String,
) -> Result<SessionDetail, String> {
    detail_of(&touched, &path, &agent)
}

/// The counts for one session. Split from the command so the store-less branch
/// is testable without a Tauri `State`.
fn detail_of(
    touched: &TouchedIndex,
    path: &str,
    agent: &str,
) -> Result<SessionDetail, String> {
    // See `extract_touched_files` on why the kind is matched exhaustively. A
    // session with no transcript has no counts, and zeroes are the honest
    // answer: the panel renders empty rather than reporting a conversation that
    // ran as one that never happened. Guarded before the open, because the path
    // of such a session is Tori's locator, which parses as no lines at all and
    // would produce the same zeroes by accident.
    match agents::parser_kind_for(agent) {
        Some(agents::ParserKind::ClaudeJsonl) => {}
        None => return Ok(SessionDetail::default()),
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let raw = scan_counts(BufReader::new(file));

    let touched_count = touched_files_cached(touched, path, agent)
        .iter()
        .filter(|f| f.op != TouchOp::Read)
        .count() as u32;

    Ok(SessionDetail {
        prompt_count: raw.prompt_count,
        turn_count: raw.turn_count,
        tool_count: raw.tool_count,
        output_tokens: raw.output_tokens,
        context_tokens: raw.context_tokens,
        model: raw.model,
        compaction_count: raw.compaction_count,
        compaction_reclaimed: raw.compaction_reclaimed,
        touched_count,
    })
}

// --- Touched-files extraction ---
//
// Every tool call in a transcript that reads/writes/deletes a file is
// classified into an op, path-normalized against the session's own recorded
// cwd, and deduped by final absolute path: `op` is the latest *write-class*
// touch (Read never downgrades a prior Create/Edit/Delete, so a file that was
// created then merely re-read still shows as created); `first_ts`/`last_ts`
// span every touch including reads; `count` is the total touch count.
// Bash/bash commands only cover three common shapes (`sed -i`, a trailing
// `>`/`>>` redirect, `rm`) - anything else is invisible here, with git's diff
// as the backstop (findings.md Finding B caveats).

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TouchOp {
    Read,
    Create,
    Edit,
    Delete,
}

#[derive(Serialize, Clone)]
pub struct TouchedFile {
    pub path: String,
    pub op: TouchOp,
    pub first_ts: u64,
    pub last_ts: u64,
    pub count: u32,
}

pub(crate) struct TouchAcc {
    pub(crate) op: TouchOp,
    pub(crate) has_write: bool,
    pub(crate) first_ts: u64,
    pub(crate) last_ts: u64,
    pub(crate) count: u32,
}

/// Resolve a tool-reported path against the session's cwd: an absolute path
/// passes through, a relative one (always true of a Bash-inferred touch) is
/// joined onto cwd after stripping a leading `./`. No `..`/canonicalization is
/// attempted beyond that (best-effort, matching the Bash inference it mostly
/// serves).
pub(crate) fn normalize_touch_path(path: &str, cwd: &str) -> String {
    let p = path.trim();
    if p.starts_with('/') {
        p.to_string()
    } else {
        let p = p.strip_prefix("./").unwrap_or(p);
        format!("{}/{}", cwd.trim_end_matches('/'), p)
    }
}

pub(crate) fn record_touch(acc: &mut HashMap<String, TouchAcc>, path: String, op: TouchOp, ts: u64) {
    acc.entry(path)
        .and_modify(|e| {
            // A later write-class touch replaces the shown op; a later Read
            // never downgrades an already-recorded write.
            if op != TouchOp::Read || !e.has_write {
                e.op = op;
            }
            e.has_write |= op != TouchOp::Read;
            e.first_ts = e.first_ts.min(ts);
            e.last_ts = e.last_ts.max(ts);
            e.count += 1;
        })
        .or_insert(TouchAcc {
            op,
            has_write: op != TouchOp::Read,
            first_ts: ts,
            last_ts: ts,
            count: 1,
        });
}

fn strip_quotes(s: &str) -> &str {
    s.trim_matches(|c| c == '\'' || c == '"')
}

/// Best-effort file touch inference from a raw shell command string: `sed -i`
/// (edit, the last token), a trailing `>`/`>>` redirect (create/edit, the
/// token right after it), `rm` (delete, the last non-flag token). Only covers
/// the common spaced-token forms; anything else yields None.
pub(crate) fn infer_bash_touch(cmd: &str) -> Option<(String, TouchOp)> {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    let first = *tokens.first()?;

    if first == "sed" && tokens.iter().any(|t| *t == "-i" || t.starts_with("-i")) {
        let last = strip_quotes(tokens.last()?);
        if !last.is_empty() {
            return Some((last.to_string(), TouchOp::Edit));
        }
    }
    if let Some(pos) = tokens.iter().rposition(|t| *t == ">>") {
        if let Some(target) = tokens.get(pos + 1) {
            return Some((strip_quotes(target).to_string(), TouchOp::Edit));
        }
    }
    if let Some(pos) = tokens.iter().rposition(|t| *t == ">") {
        if let Some(target) = tokens.get(pos + 1) {
            return Some((strip_quotes(target).to_string(), TouchOp::Create));
        }
    }
    if first == "rm" {
        if let Some(target) = tokens.iter().skip(1).rev().find(|t| !t.starts_with('-')) {
            return Some((strip_quotes(target).to_string(), TouchOp::Delete));
        }
    }
    None
}

fn claude_tool_path(input: &serde_json::Value) -> Option<String> {
    input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Claude `tool_use` -> (path, op). Grounded in real local transcripts: Write/
/// Edit/Read all carry `input.file_path`. MultiEdit/NotebookEdit have no local
/// sample to confirm against; assumed to match per findings.md Finding B.
fn classify_claude_tool(name: &str, input: Option<&serde_json::Value>) -> Option<(String, TouchOp)> {
    match name {
        "Write" => claude_tool_path(input?).map(|p| (p, TouchOp::Create)),
        "Edit" | "MultiEdit" | "NotebookEdit" => claude_tool_path(input?).map(|p| (p, TouchOp::Edit)),
        "Read" => claude_tool_path(input?).map(|p| (p, TouchOp::Read)),
        "Bash" => infer_bash_touch(input?.get("command")?.as_str()?),
        _ => None,
    }
}

/// Parse a `timestamp` field (RFC3339) into epoch seconds. No chrono/time
/// dependency: a minimal fixed-format parser using the standard
/// civil-to-days-since-epoch algorithm (Howard Hinnant's `days_from_civil`).
///
/// Everything after the seconds is ignored, so an offset that is not UTC would
/// be read as if it were. Both callers only ever see UTC: transcripts are
/// `Z`-suffixed, and Claude's usage endpoint sends `+00:00`.
pub(crate) fn parse_rfc3339_secs(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;

    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (month + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + day - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    let days = era * 146097 + doe - 719468; // days since 1970-01-01

    let secs = days * 86400 + hour * 3600 + min * 60 + sec;
    if secs < 0 {
        None
    } else {
        Some(secs as u64)
    }
}

/// Read a full transcript and extract every touched file. Returns an empty
/// list (not an error) when the file can't be opened - touched data is
/// supplementary, so a session that vanished mid-read just shows nothing.
fn extract_touched_files(path: &str, agent: &str) -> Vec<TouchedFile> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    // One parser kind ships. An exhaustive match rather than an ignored value:
    // adding a kind makes this arm non-exhaustive, so every reader of a
    // transcript has to answer for the new shape before it compiles. This is
    // what "a reintroduced locator would not compile" rests on. `None` is an
    // adapter with no transcript format at all, whose sessions this build reads
    // over its protocol; there is nothing here to parse and nothing to report.
    match agents::parser_kind_for(agent) {
        Some(agents::ParserKind::ClaudeJsonl) => {}
        None => return Vec::new(),
    }

    let mut cwd: Option<String> = None;
    let mut acc: HashMap<String, TouchAcc> = HashMap::new();

    for line in reader.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = Some(c.to_string());
            }
        }
        let Some(cwd_str) = cwd.as_deref() else { continue }; // no touches before cwd is known
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_rfc3339_secs)
            .unwrap_or(0);

        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if let Some((raw_path, op)) = classify_claude_tool(name, block.get("input")) {
                record_touch(&mut acc, normalize_touch_path(&raw_path, cwd_str), op, ts);
            }
        }
    }

    let mut files: Vec<TouchedFile> = acc
        .into_iter()
        .map(|(path, a)| TouchedFile {
            path,
            op: a.op,
            first_ts: a.first_ts,
            last_ts: a.last_ts,
            count: a.count,
        })
        .collect();
    files.sort_by(|a, b| b.last_ts.cmp(&a.last_ts));
    files
}

struct TouchedCacheEntry {
    mtime: SystemTime,
    files: Vec<TouchedFile>,
}

#[derive(Default)]
pub struct TouchedIndex(Mutex<HashMap<PathBuf, TouchedCacheEntry>>);

/// Mtime-cached wrapper around `extract_touched_files`, shared by the
/// `session_touched_files` command and `session_detail`'s `touched_count` -
/// so selecting a session doesn't force a second full transcript read if the
/// touched panel (phase 3) already warmed the cache, or vice versa.
fn touched_files_cached(index: &TouchedIndex, path: &str, agent: &str) -> Vec<TouchedFile> {
    let p = PathBuf::from(path);
    let mtime =
        std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);

    let mut cache = match index.0.lock() {
        Ok(c) => c,
        Err(_) => return extract_touched_files(path, agent),
    };
    if let Some(entry) = cache.get(&p) {
        if entry.mtime == mtime {
            return entry.files.clone();
        }
    }
    let files = extract_touched_files(path, agent);
    cache.insert(
        p,
        TouchedCacheEntry {
            mtime,
            files: files.clone(),
        },
    );
    files
}

#[tauri::command(async)]
pub fn session_touched_files(
    index: State<TouchedIndex>,
    path: String,
    agent: String,
) -> Result<Vec<TouchedFile>, String> {
    Ok(touched_files_cached(&index, &path, &agent))
}

/// The most recently *written* file in a touched set, ignoring reads. Reads are
/// excluded for the same reason the tree markers exclude them: an agent reads
/// far more than it writes, so the newest read says nothing about what it is
/// changing. Does not assume `extract_touched_files`' sort order - it picks the
/// max explicitly, so a caller that filtered or reordered still gets the right
/// answer.
fn latest_written(files: &[TouchedFile]) -> Option<&TouchedFile> {
    files
        .iter()
        .filter(|f| f.op != TouchOp::Read)
        .max_by_key(|f| f.last_ts)
}

/// The file this session wrote most recently, for the live "editing now"
/// indicator. Attribution only: this answers "which file did the transcript
/// last name", never "is the session busy" - liveness is composed in the
/// frontend (PTY activity + tail state), which the backend cannot see.
///
/// Rides the same mtime cache as `session_touched_files`, so polling it while a
/// turn runs costs a full parse only when the transcript actually grew. An
/// adapter whose transcript shape `extract_touched_files` cannot parse yields
/// `None`, so the indicator no-ops rather than misreporting.
#[tauri::command(async)]
pub fn session_editing_now(
    index: State<TouchedIndex>,
    path: String,
    agent: String,
) -> Result<Option<TouchedFile>, String> {
    let files = touched_files_cached(&index, &path, &agent);
    Ok(latest_written(&files).cloned())
}

/// Directories the session watcher covers - every `(profile, root)` pair, so a
/// newly added agent's transcripts, and a second account's, both fire
/// `sessions://changed` with no watcher-side wiring of their own.
///
/// An adapter with no discovery contributes no directory: its sessions change
/// when its protocol says so, which no filesystem watcher sees.
fn watch_dirs() -> Vec<PathBuf> {
    let accounts = crate::accounts::load();
    discovery_roots(&accounts).into_iter().map(|r| r.dir).collect()
}

/// A missing root is created only under a home Tori manages. Any other is the
/// agent's to create: making `projects/` there would make `~/.claude` with it.
fn watchable_dirs(roots: Vec<Root<'_>>) -> Result<Vec<PathBuf>, String> {
    let mut dirs = Vec::new();
    for root in roots {
        if root.managed {
            std::fs::create_dir_all(&root.dir).map_err(|e| e.to_string())?;
        } else if !root.dir.is_dir() {
            continue;
        }
        dirs.push(root.dir);
    }
    Ok(dirs)
}

/// When the last filesystem event landed, shared by whichever watcher is
/// current and the one thread that emits.
///
/// Static rather than an `Arc` minted per call, which is what makes
/// `sessions_watch_start` safe to run again: adding an account creates a new
/// root, and the only way to watch it is a new watcher over the new set. A
/// per-call `Arc` would have meant a second emitter thread for every restart,
/// each looping forever.
static WATCH_PENDING: Mutex<Option<Instant>> = Mutex::new(None);

/// The transcript files the burst touched, so the emit can name the folders
/// that actually moved instead of making every tracked folder re-list. A burst
/// merges into a set, since the debounce is what joins the writes.
static WATCH_TOUCHED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Past this many distinct files in one burst, naming them stops being cheaper
/// than the full refresh it saves, so the payload gives up and says "all".
const TOUCHED_CAP: usize = 64;

/// Whether the emitter thread is already running.
static EMITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What `sessions://changed` carries.
///
/// `folders: None` means "something changed that could not be attributed", and
/// every listener refreshes the way it always did. That is the honest answer
/// for a brand-new transcript, whose path is not in the index yet and whose
/// whole point is to surface a folder nobody is listing.
#[derive(Clone, Serialize)]
pub struct SessionsChanged {
    pub folders: Option<Vec<String>>,
}

impl SessionsChanged {
    /// Everything: the payload every non-watcher emit sends, and the fallback
    /// whenever attribution fails.
    fn all() -> Self {
        Self { folders: None }
    }
}

/// Resolve the burst's touched files to the folders their sessions are anchored
/// on, or `None` when any of them cannot be resolved.
///
/// The index is the only thing that knows a transcript's cwd: the encoding of a
/// cwd into a directory name belongs to the agent (see `transcript_path`), so
/// the path alone cannot be decoded. A miss means a file Tori has not parsed
/// yet, which is exactly the new-session case, so one miss makes the whole
/// answer "all" rather than a set that quietly omits it.
fn folders_for(index: &SessionIndex, touched: &HashSet<PathBuf>) -> Option<Vec<String>> {
    if touched.is_empty() || touched.len() > TOUCHED_CAP {
        return None;
    }
    let cache = index.0.lock().ok()?;
    let mut folders = HashSet::new();
    for path in touched {
        let cwd = cache.get(path).and_then(|e| e.meta.as_ref()).map(|m| m.cwd.clone())?;
        folders.insert(cwd);
    }
    Some(folders.into_iter().collect())
}

/// Start (or restart) the session watcher over the current set of roots.
///
/// Safe to call again, and it has to be: the set of roots is not fixed for the
/// life of the app. Adding an account adds a transcript root, and a root nobody
/// watches means that account's sessions do not appear until something else
/// asks for a listing.
#[tauri::command(async)]
pub fn sessions_watch_start(
    app: AppHandle,
    state: State<SessionWatch>,
) -> Result<(), String> {
    let dirs = watchable_dirs(discovery_roots(&crate::accounts::load()))?;

    // Trailing-edge debounce. The watcher callback only records WHEN the last
    // filesystem event landed; a background thread emits `sessions://changed`
    // once the burst has settled. A brand-new session is written as a burst of
    // lines, and the `cwd` that anchors it to its folder usually lands after the
    // first line - so the old leading-edge throttle emitted against the pre-cwd
    // state (folder unmatched, nothing shown) and then swallowed the settling
    // write, so the session never surfaced until some later, unrelated change.
    // Trailing debounce fires on the complete file; a max-wait heartbeat keeps a
    // long, continuously-streaming session updating rather than starving.
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if let Ok(mut t) = WATCH_TOUCHED.lock() {
            let set = t.get_or_insert_with(HashSet::new);
            // Stop accumulating once past the cap: the emit will say "all"
            // anyway, and a pathological burst should not also grow a set.
            if set.len() <= TOUCHED_CAP {
                set.extend(event.paths.iter().cloned());
            }
        }
        if let Ok(mut p) = WATCH_PENDING.lock() {
            *p = Some(Instant::now());
        }
    })
    .map_err(|e| e.to_string())?;

    for dir in &dirs {
        watcher
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
    }

    // Replaces whatever was watching before, and dropping it is what stops it.
    // Done before the early return below so a restart really does swap the set.
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);

    if EMITTING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }

    let app_handle = app.clone();
    std::thread::spawn(move || {
        const SETTLE: std::time::Duration = std::time::Duration::from_millis(350);
        const MAX_WAIT: std::time::Duration = std::time::Duration::from_millis(1000);
        let mut last_emit = Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let should_emit = match WATCH_PENDING.lock() {
                Ok(mut p) => match *p {
                    // Burst settled: emit the final, complete state.
                    Some(t) if t.elapsed() >= SETTLE => {
                        *p = None;
                        true
                    }
                    // Still active but nothing emitted in a while: heartbeat, so a
                    // long stream keeps the listing fresh instead of starving.
                    Some(_) if last_emit.elapsed() >= MAX_WAIT => true,
                    _ => false,
                },
                Err(_) => false,
            };
            if should_emit {
                last_emit = Instant::now();
                // Drain rather than read: whatever this emit names, the next
                // burst starts from empty, or a folder would keep re-listing
                // long after its transcript stopped moving.
                let touched = WATCH_TOUCHED.lock().ok().and_then(|mut t| t.take()).unwrap_or_default();
                let folders = folders_for(&app_handle.state::<SessionIndex>(), &touched);
                let _ = app_handle.emit("sessions://changed", SessionsChanged { folders });
                crate::rpc::sessions_changed();
            }
        }
    });

    Ok(())
}

// --- Transcript viewer ---
//
// A per-agent-agnostic turn list. Reuses `extract_text` (title/prompt
// extraction) and `parse_rfc3339_secs` (touched-files timestamps) rather than
// re-deriving either, and mirrors the same per-line, per-agent dispatch shape
// as `session_detail`/`extract_touched_files`. Grounded in real local
// transcripts (see block-shape doc comments below), the same practice phase 2
// used for the touched-files tool mapping.
//
// The read-only transcript viewer this was first written for is gone; the chat
// panel's replay (`chat_session_detail`) and the needs-you tail state are what
// read these turns now, and both take the whole list rather than a page of it.

#[derive(Serialize, Clone)]
pub struct TranscriptBlock {
    /// "text" | "thinking" | "tool_call" | "tool_result" | "image"
    pub kind: String,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    pub is_error: Option<bool>,
    /// The agent's own id for the call, when the transcript records one.
    ///
    /// Claude writes it on both halves (`tool_use.id` and
    /// `tool_result.tool_use_id`), which is what lets a replayed transcript pair
    /// a result with its call exactly rather than by position. A format that
    /// carries no id leaves this `None` and the replay falls back to order.
    pub tool_use_id: Option<String>,
    /// What the call did, read off the structured result the transcript
    /// records beside the text.
    ///
    /// **The summary and not the payload it came from.** Live and replayed
    /// sessions have to agree, so both go through the one
    /// [`crate::chat::claude::summarise_result`]; what differs is only where it
    /// is called. Calling it here rather than in `chat/history.rs` keeps the
    /// bulk out of memory: a result quotes whole files back
    /// (`file.content`, `originalFile`, `oldString`), none of which a summary
    /// reads, and on the largest local transcript those payloads come to 29 MB
    /// against a 70 MB file that replay already holds whole.
    ///
    /// `None` for a block whose payload the transcript recorded none of, which
    /// is a call made inside a subagent, and for one whose shape no summariser
    /// claims.
    pub tool_summary: Option<crate::chat::model::ToolSummary>,
    /// The diff the call measured, read off the same payload as the summary and
    /// for the same reason: a replayed edit has to draw what the live one drew.
    /// Empty for every block that is not a write, and it is the *only* source
    /// that survives a reload, since nothing captures a before-state for a
    /// session this process never watched run.
    #[serde(default)]
    pub tool_patch: Vec<crate::chat::model::PatchHunk>,
    /// Set only on a `compaction` block: how much context the compaction
    /// reclaimed, and whether the user asked for it. `None` for every other
    /// kind, and `None` individually when the transcript did not record that
    /// half - a missing figure is not a zero.
    pub compact_trigger: Option<String>,
    pub pre_tokens: Option<u64>,
    pub post_tokens: Option<u64>,
    /// Set only on a `subagent` block: how a subagent ended. `None` for every
    /// other kind.
    pub subagent: Option<SubagentOutcome>,
}

/// How a subagent ended. Two records carry one and a backgrounded subagent
/// writes both: the `Agent` call's `toolUseResult`, then a `<task-notification>`
/// message. Read here for the same reason [`TranscriptBlock::tool_summary`] is.
#[derive(Serialize, Clone)]
pub struct SubagentOutcome {
    pub agent_id: String,
    /// The agent's own word (`completed`, `async_launched`, ...), never an enum,
    /// matching how the live `SubagentUpdate` carries it.
    pub status: String,
    pub summary: Option<String>,
    pub usage: crate::chat::model::SubagentUsage,
}

#[derive(Serialize, Clone)]
pub struct TranscriptTurn {
    /// "user" | "assistant" | "tool" (a standalone tool-result message)
    pub role: String,
    pub ts: u64,
    pub blocks: Vec<TranscriptBlock>,
}

pub(crate) fn text_block(kind: &str, text: String) -> TranscriptBlock {
    TranscriptBlock { kind: kind.into(), text: Some(text), tool_name: None, tool_input: None, is_error: None, tool_use_id: None, tool_summary: None, tool_patch: Vec::new(), compact_trigger: None, pre_tokens: None, post_tokens: None, subagent: None }
}

/// Where the conversation's middle was replaced by a summary. The summary text
/// itself is the *next* user message, not part of this block.
/// An image a user turn carried, recorded without its bytes: replay redraws no
/// screenshot, so reading them back would cost a session's worth of memory for
/// nothing. Still a block, so an image-only prompt is still a turn.
pub(crate) fn image_block() -> TranscriptBlock {
    TranscriptBlock { kind: "image".into(), text: None, tool_name: None, tool_input: None, is_error: None, tool_use_id: None, tool_summary: None, tool_patch: Vec::new(), compact_trigger: None, pre_tokens: None, post_tokens: None, subagent: None }
}

pub(crate) fn compaction_block(trigger: Option<String>, pre_tokens: Option<u64>, post_tokens: Option<u64>) -> TranscriptBlock {
    TranscriptBlock { kind: "compaction".into(), text: None, tool_name: None, tool_input: None, is_error: None, tool_use_id: None, tool_summary: None, tool_patch: Vec::new(), compact_trigger: trigger, pre_tokens, post_tokens, subagent: None }
}

pub(crate) fn tool_call_block(name: String, input: serde_json::Value, tool_use_id: Option<String>) -> TranscriptBlock {
    TranscriptBlock { kind: "tool_call".into(), text: None, tool_name: Some(name), tool_input: Some(input), is_error: None, tool_use_id, tool_summary: None, tool_patch: Vec::new(), compact_trigger: None, pre_tokens: None, post_tokens: None, subagent: None }
}

pub(crate) fn tool_result_block(
    name: Option<String>,
    text: String,
    is_error: bool,
    tool_use_id: Option<String>,
    tool_summary: Option<crate::chat::model::ToolSummary>,
    tool_patch: Vec<crate::chat::model::PatchHunk>,
) -> TranscriptBlock {
    TranscriptBlock { kind: "tool_result".into(), text: Some(text), tool_name: name, tool_input: None, is_error: Some(is_error), tool_use_id, tool_summary, tool_patch, compact_trigger: None, pre_tokens: None, post_tokens: None, subagent: None }
}

pub(crate) fn subagent_block(outcome: SubagentOutcome) -> TranscriptBlock {
    TranscriptBlock { kind: "subagent".into(), text: None, tool_name: None, tool_input: None, is_error: None, tool_use_id: None, tool_summary: None, tool_patch: Vec::new(), compact_trigger: None, pre_tokens: None, post_tokens: None, subagent: Some(outcome) }
}

/// The outcome an `Agent` call's `toolUseResult` records, `None` for every other
/// tool's payload. A foreground run reports its ending here; a backgrounded one
/// reports only `async_launched`, the call having returned before the work did.
fn subagent_outcome(payload: &serde_json::Value) -> Option<SubagentOutcome> {
    let agent_id = payload.get("agentId").and_then(|v| v.as_str())?.to_string();
    let get = |k: &str| payload.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
    Some(SubagentOutcome {
        agent_id,
        status: payload.get("status").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        // The same sentence the live `task_notification` puts on the lane, so a
        // reopened lane carries what a watched one did.
        summary: payload.get("content").map(stringify_content).filter(|s| !s.is_empty()),
        usage: crate::chat::model::SubagentUsage {
            total_tokens: get("totalTokens"),
            tool_uses: get("totalToolUseCount"),
            duration_ms: get("totalDurationMs"),
        },
    })
}

/// A backgrounded subagent's ending, filed under the user's own role as an XML
/// envelope the CLI wrote for the model. The person did not type it: replay used
/// to render it as their message while `is_human_prompt` refused to count it.
fn task_notification(text: &str) -> Option<SubagentOutcome> {
    if !text.trim_start().starts_with("<task-notification>") {
        return None;
    }
    let num = |tag: &str| tag_body(text, tag).and_then(|b| b.trim().parse::<u64>().ok()).unwrap_or(0);
    Some(SubagentOutcome {
        agent_id: tag_body(text, "task-id")?.trim().to_string(),
        status: tag_body(text, "status").unwrap_or_default().trim().to_string(),
        summary: tag_body(text, "summary").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        usage: crate::chat::model::SubagentUsage {
            total_tokens: num("subagent_tokens"),
            tool_uses: num("tool_uses"),
            duration_ms: num("duration_ms"),
        },
    })
}

/// A tool_result's `content` is either a bare string or an array of text
/// blocks (`[{"type":"text","text":...}]`), same shape `extract_text` handles
/// for prompts; this joins every text block instead of stopping at the first.
fn stringify_content(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

/// Parse a full transcript into a chronological (oldest-first) turn list.
/// Claude: `type:"user"/"assistant"` at the top level, `message.content` an
/// array of `text`/`thinking`/`tool_use` blocks (a `tool_result` block rides
/// inside the *next* user turn's content). Grounded in this session's own live
/// transcript: also confirmed `tool_use` keys (`name`,`input`) and `tool_result`
/// keys (`content`,`is_error`). An adapter with a different transcript shape
/// needs a new `ParserKind` and a branch here - see ADAPTERS.md.
pub(crate) fn transcript_turns(path: &str, agent: &str) -> Vec<TranscriptTurn> {
    parse_transcript_turns(path, agent)
}

/// A session's transcript, and the account whose home held it.
pub(crate) struct Transcript {
    pub path: String,
    /// The profile id of the root the file was found under.
    ///
    /// Authoritative, and that is the point of returning it: the home a
    /// transcript sits in **is** the account the session belongs to, so a
    /// resume can be bound to what is on disk rather than to whatever the
    /// caller remembered about a tab.
    pub profile: String,
}

/// Where an agent wrote this session's transcript, or `None` before it has
/// written one.
///
/// Found by scanning the adapter's own discovery dirs rather than by rebuilding
/// the path from the cwd. The encoding of a cwd into a directory name is the
/// agent's business and has changed before; the file that is *there* is not a
/// guess. It also means a session moved between projects still resolves.
///
/// Every `(profile, root)` pair is searched, in `profiles_for` order, so the
/// default account is asked first and an added profile's session resolves at
/// all. Searching only the declared dir - which is what this did before
/// multi-account - made every reader of a profile session behave as though it
/// had no transcript: no history, no prompt count, no usage, no rewind.
///
/// Two filename shapes are accepted because two agents write two: claude's
/// `<id>.jsonl`.
pub(crate) fn transcript_of(session_id: &str, agent: &str) -> Option<Transcript> {
    let adapter = agents::find(agent)?;
    // The case this comment used to predict has arrived. It read: "when a
    // SQLite-backed agent is added (no per-session file, read through its own
    // locator instead of a path on disk), this line stops compiling and says
    // so". An ACP agent is that case in a different disguise - the store is
    // the agent's own and the locator is Tori's - and the answer is that such a
    // session has no transcript path at all. `chat_history` already returns
    // empty for one, so `None` here is the same fact reaching a second caller.
    if !matches!(adapter.discovery, Some(agents::Discovery::File { .. })) {
        return None;
    }
    let profiles = crate::accounts::profiles_for(&crate::accounts::load(), agent);
    find_transcript(&roots_for(adapter, &profiles), session_id)
}

/// Where an agent wrote this session's transcript, for a caller that does not
/// need to know which account it belongs to.
pub(crate) fn transcript_path(session_id: &str, agent: &str) -> Option<String> {
    transcript_of(session_id, agent).map(|t| t.path)
}

/// The search itself, over roots that are passed in.
///
/// Split out so the two-root case is a unit test rather than something only a
/// second signed-in account can exercise.
fn find_transcript(roots: &[Root<'_>], session_id: &str) -> Option<Transcript> {
    let matches = |name: &str| {
        let stem = name.strip_suffix(".jsonl").unwrap_or(name);
        stem == session_id || stem.ends_with(&format!("_{session_id}"))
    };
    for root in roots {
        // Per root, never `?`: a profile whose home has not been written to yet
        // is an unreadable directory, and giving up there would hide a session
        // sitting in the next root along.
        let Ok(projects) = std::fs::read_dir(&root.dir) else { continue };
        for project in projects.flatten() {
            if !project.path().is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for f in files.flatten() {
                if f.file_name().to_str().is_some_and(matches) {
                    return Some(Transcript {
                        path: f.path().to_string_lossy().into_owned(),
                        profile: root.profile.clone(),
                    });
                }
            }
        }
    }
    None
}

/// Where a session's subagent sidecars live, or `None` before it has launched
/// one. Derived from the transcript's path, not rebuilt from the session id:
/// both stem shapes [`transcript_path`] accepts name the directory beside them.
pub(crate) fn subagents_dir(transcript_path: &str) -> Option<PathBuf> {
    let stem = transcript_path.strip_suffix(".jsonl")?;
    let dir = Path::new(stem).join("subagents");
    dir.is_dir().then_some(dir)
}

/// One subagent's whole run, as the two files beside the session transcript
/// record it.
pub struct SubagentTranscript {
    pub agent_id: String,
    pub agent_type: String,
    pub description: String,
    /// The `Agent` call that launched it, and the only join back to the card.
    pub tool_use_id: String,
    /// What it was asked to do, read off its own first message: `meta.json`
    /// records the one-line description but not the prompt.
    pub prompt: String,
    /// Its conversation, with that first message removed: nothing can talk to a
    /// subagent, so a user row in its lane could only be the prompt above.
    pub turns: Vec<TranscriptTurn>,
}

/// Every subagent this session launched, in no particular order: the replay
/// places each one at its own `Agent` call rather than by arrival.
pub(crate) fn subagent_transcripts(transcript_path: &str, agent: &str) -> Vec<SubagentTranscript> {
    let Some(dir) = subagents_dir(transcript_path) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(agent_id) = name.strip_prefix("agent-").and_then(|n| n.strip_suffix(".meta.json")) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let str_of = |k: &str| meta.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        // No `toolUseId` means no call to hang the lane on, so the run cannot be
        // placed in the conversation at all.
        let tool_use_id = meta.get("toolUseId").and_then(|v| v.as_str());
        let Some(tool_use_id) = tool_use_id.filter(|id| !id.is_empty()) else { continue };
        let mut turns = parse_transcript_turns(&dir.join(format!("agent-{agent_id}.jsonl")).to_string_lossy(), agent);
        out.push(SubagentTranscript {
            agent_id: agent_id.to_string(),
            agent_type: str_of("agentType"),
            description: str_of("description"),
            tool_use_id: tool_use_id.to_string(),
            prompt: take_prompt(&mut turns),
            turns,
        });
    }
    out
}

/// Strip a subagent's own prompt out of its turns, returning it.
fn take_prompt(turns: &mut Vec<TranscriptTurn>) -> String {
    let mut prompt = None;
    for turn in turns.iter_mut().filter(|t| t.role == "user") {
        if prompt.is_none() {
            prompt = turn.blocks.iter().find(|b| b.kind == "text").and_then(|b| b.text.clone());
        }
        turn.blocks.retain(|b| b.kind != "text");
    }
    turns.retain(|t| !t.blocks.is_empty());
    prompt.unwrap_or_default()
}

fn parse_transcript_turns(path: &str, agent: &str) -> Vec<TranscriptTurn> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    // See `extract_touched_files` on why the kind is matched exhaustively.
    match agents::parser_kind_for(agent) {
        Some(agents::ParserKind::ClaudeJsonl) => {}
        None => return Vec::new(),
    }
    reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| turn_from_line(&line))
        .collect()
}

/// How much of a transcript's end to read when only its last turn matters.
/// Widened by doubling when the window holds no turn at all (a tail of nothing
/// but meta lines, or one enormous line), so the answer never depends on the
/// guess being generous enough.
const TAIL_WINDOW_BYTES: u64 = 64 * 1024;

/// The transcript's last turn, read from its end rather than from its start.
///
/// Sound because [`turn_from_line`] carries no state between lines: the turns
/// the last complete lines produce are the same turns a full parse would put at
/// the end of its list. Reading from a line boundary is what makes them
/// *complete*; the partial first line of the window is dropped.
fn tail_turns(path: &str, agent: &str) -> Vec<TranscriptTurn> {
    match agents::parser_kind_for(agent) {
        Some(agents::ParserKind::ClaudeJsonl) => {}
        None => return Vec::new(),
    }
    let Ok(mut file) = std::fs::File::open(path) else { return Vec::new() };
    let Ok(len) = file.metadata().map(|m| m.len()) else { return Vec::new() };

    let mut window = TAIL_WINDOW_BYTES;
    loop {
        let from_start = window >= len;
        let Ok(text) = read_tail(&mut file, len, window) else { return Vec::new() };
        let mut lines = text.split('\n');
        // Unless the window covers the file, its first line starts mid-line.
        if !from_start {
            lines.next();
        }
        let turns: Vec<TranscriptTurn> = lines.filter_map(turn_from_line).collect();
        if !turns.is_empty() || from_start {
            return turns;
        }
        window *= 2;
    }
}

/// The last `window` bytes of an open file, or the whole file when it is
/// smaller. Lossy rather than strict: a window boundary can land inside a
/// multi-byte character, and the line that character belongs to is one this
/// caller drops anyway.
fn read_tail(file: &mut std::fs::File, len: u64, window: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let start = len.saturating_sub(window);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.take(len - start).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// What a cached answer is keyed by. A transcript is appended to, so mtime and
/// size together move on every write that could change an answer.
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    mtime: SystemTime,
    size: u64,
}

fn stamp_of(path: &str) -> Option<FileStamp> {
    let m = std::fs::metadata(path).ok()?;
    Some(FileStamp { mtime: m.modified().ok()?, size: m.len() })
}

/// A transcript and the adapter reading it: the pair any cached answer here is
/// keyed by, since two adapters can parse the same file to different turns.
type TranscriptKey = (String, String);

/// Tail classification per (path, agent), so a 1Hz heartbeat over an unchanged
/// transcript costs a `stat` rather than a parse.
static TAIL_STATE_CACHE: Mutex<Option<HashMap<TranscriptKey, (FileStamp, TailState)>>> =
    Mutex::new(None);

/// How many times the tail actually had to be read. Test-only, because the
/// difference between a hit and a miss is a 64KB read either way: fast enough
/// that timing cannot tell them apart, and the cache still has to be shown to
/// work.
#[cfg(test)]
static TAIL_READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// `classify_tail(tail_turns(..))`, memoised on the file's stamp.
fn cached_tail_state(path: &str, agent: &str) -> TailState {
    let Some(stamp) = stamp_of(path) else { return classify_tail(&tail_turns(path, agent)) };
    let key = (path.to_string(), agent.to_string());
    if let Ok(guard) = TAIL_STATE_CACHE.lock() {
        if let Some((cached, state)) = guard.as_ref().and_then(|m| m.get(&key)) {
            if *cached == stamp {
                return *state;
            }
        }
    }
    #[cfg(test)]
    TAIL_READS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let state = classify_tail(&tail_turns(path, agent));
    if let Ok(mut guard) = TAIL_STATE_CACHE.lock() {
        guard.get_or_insert_with(HashMap::new).insert(key, (stamp, state));
    }
    state
}

/// One transcript line as at most one turn.
///
/// Pulled out of the full walk so [`tail_turns`] can reuse it verbatim:
/// a line yields its turn from its own contents alone, with no state carried
/// from the lines before it, which is exactly what makes reading only the end
/// of a 19MB transcript give the same last turn a full parse would.
fn turn_from_line(line: &str) -> Option<TranscriptTurn> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let ts = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(parse_rfc3339_secs)
        .unwrap_or(0);

    match v.get("type").and_then(|t| t.as_str()) {
        Some("user") => {
            if v.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
                return None;
            }
            let mut blocks = Vec::new();
            if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                if let Some(s) = content.as_str() {
                    // Its own role, so the rewind boundary and the replay both
                    // stop treating a backgrounded subagent's ending as a prompt.
                    if let Some(outcome) = task_notification(s) {
                        return Some(TranscriptTurn { role: "subagent".into(), ts, blocks: vec![subagent_block(outcome)] });
                    }
                    // Both halves of a client-side command, each on its own
                    // role so neither can be mistaken for a prompt again. They
                    // are paired back together one layer up, which is also
                    // where an invocation with no output (a skill, `/clear`)
                    // goes back to being dropped.
                    if let Some(turn) = local_command_turn(s, ts) {
                        return Some(turn);
                    }
                    if !s.trim().is_empty() && !is_command_envelope(s) {
                        blocks.push(text_block("text", s.to_string()));
                    }
                } else if let Some(arr) = content.as_array() {
                    for b in arr {
                        match b.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                    if !is_command_envelope(t) {
                                        blocks.push(text_block("text", t.to_string()));
                                    }
                                }
                            }
                            // Dropping it left a prompt asking about a
                            // screenshot with no screenshot in it, and lost an
                            // image-only prompt outright.
                            Some("image") => blocks.push(image_block()),
                            Some("tool_result") => {
                                let text = b.get("content").map(stringify_content).unwrap_or_default();
                                let is_error = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                                let id = b.get("tool_use_id").and_then(|i| i.as_str()).map(str::to_string);
                                // Spelled `toolUseResult` on the record, not
                                // `tool_use_result` as on the stream: same
                                // payload, camelCased by the transcript writer.
                                // It sits on the record rather than inside the
                                // block, and a record carries at most one tool
                                // result (measured: none of 47539 locally had
                                // two), so it belongs to this block without
                                // having to be matched to it.
                                //
                                // Summarised on the spot, so the payload it was
                                // read from is dropped with the line instead of
                                // being carried through the whole replay.
                                let payload = v.get("toolUseResult");
                                let summary = payload.and_then(crate::chat::claude::summarise_result);
                                let patch = payload
                                    .map(crate::chat::claude::structured_patch)
                                    .unwrap_or_default();
                                blocks.push(tool_result_block(None, text, is_error, id, summary, patch));
                                // Beside the card rather than on it: an `Agent`
                                // result settles a call and ends a lane, and the
                                // lane outlives the card when it was backgrounded.
                                if let Some(outcome) = payload.and_then(subagent_outcome) {
                                    blocks.push(subagent_block(outcome));
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            (!blocks.is_empty()).then(|| TranscriptTurn { role: "user".into(), ts, blocks })
        }
        // Where the current CLI files a client-side command's output: under
        // `system`, because neither speaker produced it. Older transcripts put
        // the same text under the user's role wearing the same
        // `<local-command-stdout>` wrapper, which the branch above catches.
        Some("system") if v.get("subtype").and_then(|s| s.as_str()) == Some("local_command") => {
            local_command_turn(v.get("content").and_then(|c| c.as_str())?, ts)
        }
        // A compaction boundary, kept as its own turn so a replayed
        // transcript shows where its middle went rather than silently
        // jumping. Sidechain boundaries belong to a subagent's context,
        // not this conversation's, so they are skipped the same way the
        // counts in `scan_counts` skip them.
        Some("system")
            if v.get("subtype").and_then(|s| s.as_str()) == Some("compact_boundary")
                && v.get("isSidechain").and_then(|b| b.as_bool()) != Some(true) =>
        {
            let m = v.get("compactMetadata");
            let get = |k: &str| m.and_then(|m| m.get(k)).and_then(|n| n.as_u64());
            Some(TranscriptTurn {
                role: "compaction".into(),
                ts,
                blocks: vec![compaction_block(
                    m.and_then(|m| m.get("trigger")).and_then(|t| t.as_str()).map(str::to_string),
                    get("preTokens"),
                    get("postTokens"),
                )],
            })
        }
        Some("assistant") => {
            let mut blocks = Vec::new();
            if let Some(arr) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for b in arr {
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                blocks.push(text_block("text", t.to_string()));
                            }
                        }
                        Some("thinking") => {
                            if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                                blocks.push(text_block("thinking", t.to_string()));
                            }
                        }
                        Some("tool_use") => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                            let input = b.get("input").cloned().unwrap_or(serde_json::Value::Null);
                            let id = b.get("id").and_then(|i| i.as_str()).map(str::to_string);
                            blocks.push(tool_call_block(name, input, id));
                        }
                        _ => {}
                    }
                }
            }
            (!blocks.is_empty()).then(|| TranscriptTurn { role: "assistant".into(), ts, blocks })
        }
        _ => None,
    }
}

// --- Needs-you floor: transcript-tail state (Finding A, Tier 3 floor) ---
//
// Joined with PTY quiet (pty.rs's Activity) in the frontend (phase 2 task 4):
// quiet + BlockedCandidate -> needs-you; quiet + Done -> idle; an active PTY
// reads as Working regardless of tail state. This command answers only "what
// does the transcript's tail look like", agent-agnostic (reuses
// `parse_transcript_turns`, so it inherits both agents' parsers for free).

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TailState {
    #[serde(rename = "working")]
    Working,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "blocked-candidate")]
    BlockedCandidate,
}

/// Classify the last turn's shape: a trailing pending tool call (no result
/// turn after it) is a blocked-candidate; a trailing final assistant text is
/// done; anything else (no turns yet, a fresh human prompt, thinking cut
/// short, or a tool result awaiting the agent's next reply) is working - the
/// agent hasn't reached a resting state either way.
fn classify_tail(turns: &[TranscriptTurn]) -> TailState {
    // A client-side command ran in the client, so it says nothing about what
    // the agent is doing. Skipped rather than classified: before these were
    // turns at all they were invisible here, and letting a trailing `/usage`
    // count would report a finished session as working.
    let Some(last) = turns.iter().rev().find(|t| t.role != "command") else {
        return TailState::Working;
    };
    if last.role != "assistant" {
        return TailState::Working;
    }
    match last.blocks.last().map(|b| b.kind.as_str()) {
        Some("tool_call") => TailState::BlockedCandidate,
        Some("text") => TailState::Done,
        _ => TailState::Working,
    }
}

/// `working` | `done` | `blocked-candidate`, capability-gated per adapter.
/// An agent whose `hooks` capability is on (claude - see `crate::hooks`)
/// gets its status from the injected hook's status file when one exists,
/// overriding the transcript-tail guess with claude's own ground-truth
/// signal; falls back to the tail join when no hook file exists yet (a
/// session just launched) or names an event with no mapped status.
/// Otherwise, an agent whose `needs_you` capability is off (its blocked-quiet
/// join was never verified - see ADAPTERS.md) never reports
/// `blocked-candidate` from the tail join, collapsing to `working` instead, so
/// its dot caps at working rather than risking a false amber. No bundled
/// adapter turns it off today; a user adapter that cannot claim the join is
/// what `gate_tail` is still here for.
#[tauri::command]
pub async fn session_tail_state(id: String, path: String, agent: String) -> Result<TailState, String> {
    crate::exec::blocking("session_tail_state", move || session_tail_state_body(id, path, agent)).await
}

pub(crate) fn session_tail_state_body(id: String, path: String, agent: String) -> Result<TailState, String> {
    let tail = cached_tail_state(&path, &agent);
    let hooks_capable = agents::find(&agent).map(|a| a.hooks).unwrap_or(false);
    if hooks_capable {
        if let Some(state) = crate::hooks::status_for(&id) {
            // A hook-reported block is authoritative only while it still matches
            // reality. The status file advances only on wired events (and is
            // absent entirely on a resume that dropped `--settings`), so a
            // `Notification` can freeze after the user answers and pin the dot
            // amber forever. Cross-check a block against the transcript: once the
            // tail no longer shows a pending tool call (the turn finished, or a
            // tool result arrived), the block was resolved, so trust the
            // transcript instead of the stale file. Only ever downgrades a
            // block; Working/Done from the hook still win (they clear the dot).
            if state == TailState::BlockedCandidate && tail != TailState::BlockedCandidate {
                return Ok(tail);
            }
            return Ok(state);
        }
    }
    let needs_you_capable = agents::find(&agent).map(|a| a.needs_you).unwrap_or(true);
    Ok(gate_tail(tail, needs_you_capable))
}

/// The needs-you capability gate, pulled out so it stays testable. It reads
/// the registry nowhere, which is the point: with one bundled adapter, and that
/// one capable, there is no adapter a test could pass in to exercise the off
/// case through `session_tail_state`.
fn gate_tail(tail: TailState, needs_you_capable: bool) -> TailState {
    if tail == TailState::BlockedCandidate && !needs_you_capable {
        TailState::Working
    } else {
        tail
    }
}

// --- Checkpoint prompt-boundary detection (Finding E) ---
//
// Genuine human prompts only (reuses `is_human_prompt`, the same filter
// `session_detail`'s prompt_count uses). The count lets a caller
// detect a rising edge (a *new* prompt arrived) without re-deriving it from
// raw turns; `last_ts` is the transcript timestamp a checkpoint snapshot is
// keyed by.

#[derive(Serialize)]
pub struct PromptTail {
    pub count: u32,
    pub last_ts: u64,
}

/// Count of genuine human prompts and the transcript timestamp of the most
/// recent one, agent-agnostic. Checkpoint boundaries are keyed by `last_ts`
/// (see checkpoint.rs); `count` lets a caller detect a new prompt without
/// tracking timestamps itself.
#[tauri::command]
pub async fn session_prompt_tail(path: String, agent: String) -> Result<PromptTail, String> {
    crate::exec::blocking("session_prompt_tail", move || session_prompt_tail_body(path, agent)).await
}

/// How much of the file's head identifies it, so an appended transcript can be
/// told from a different one written to the same path. A rewrite that kept the
/// first line byte-for-byte AND only ever grew would still fool this, which is
/// a transcript no agent writes.
const TAIL_HEAD_SAMPLE: usize = 256;

/// Everything the incremental prompt count needs to resume: where the last
/// complete line ended, what the file looked like there, and the answer so far.
struct PromptTailEntry {
    stamp: FileStamp,
    /// Byte offset just past the last complete line already counted.
    consumed: u64,
    head: Vec<u8>,
    count: u32,
    last_ts: u64,
}

static PROMPT_TAIL_CACHE: Mutex<Option<HashMap<TranscriptKey, PromptTailEntry>>> =
    Mutex::new(None);

/// What the cache had to say about this file.
enum Resume {
    /// Unchanged since the last call: the total already known is the answer.
    Settled(u32, u64),
    /// Grown: count on from this offset with this running total.
    From(u64, u32, u64),
}

/// Count the human prompts in `text`, and say how far the last complete line
/// reached. A transcript being written to ends mid-line often enough that
/// stopping at the last newline is the difference between resuming correctly
/// and counting one line twice.
fn scan_prompts(text: &str) -> (u32, u64, u64) {
    let mut count = 0u32;
    let mut last_ts = 0u64;
    let complete = match text.rfind('\n') {
        Some(i) => i as u64 + 1,
        None => 0,
    };
    for line in text[..complete as usize].split('\n') {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let content = (v.get("type").and_then(|t| t.as_str()) == Some("user")
            && v.get("isMeta").and_then(|m| m.as_bool()) != Some(true))
        .then(|| v.get("message").and_then(|m| m.get("content")).cloned())
        .flatten();

        if content.map(|c| is_human_prompt(&c)).unwrap_or(false) {
            count += 1;
            last_ts = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(parse_rfc3339_secs)
                .unwrap_or(0);
        }
    }
    (count, last_ts, complete)
}

/// The figures for a session whose `path` is an ACP locator rather than a
/// transcript: read out of the sidecar the mirror wrote, not counted.
///
/// Resolved from the path the listing row already carries, so the sidecar, the
/// log and the locator cannot be resolved onto three different sessions the way
/// a second lookup by id could. A session with no sidecar yet reads as zero,
/// which is what every other "no transcript" answer here is.
fn acp_prompt_tail(path: &str) -> PromptTail {
    let meta = crate::chat::mirror::meta_of(Path::new(path));
    let meta = crate::chat::mirror::read_meta(&meta).unwrap_or_default();
    PromptTail { count: meta.prompt_count, last_ts: meta.last_prompt_ts }
}

pub(crate) fn session_prompt_tail_body(path: String, agent: String) -> Result<PromptTail, String> {
    use std::io::{Read, Seek, SeekFrom};
    // An agent that keeps no transcript Tori can read keeps no file to count,
    // so the count comes off the mirror's sidecar instead. Gated on the adapter
    // through `keeps_a_transcript` rather than on `parser_kind_for`, which
    // answers `ClaudeJsonl` for an agent it has never heard of.
    if !crate::chat::commands::keeps_a_transcript(&agent) {
        return Ok(acp_prompt_tail(&path));
    }
    // See `extract_touched_files` on why the kind is matched exhaustively.
    match agents::parser_kind_for(&agent) {
        Some(agents::ParserKind::ClaudeJsonl) => {}
        None => return Ok(PromptTail { count: 0, last_ts: 0 }),
    }
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    let stamp = FileStamp { mtime: meta.modified().map_err(|e| e.to_string())?, size: meta.len() };

    let mut head = vec![0u8; TAIL_HEAD_SAMPLE.min(stamp.size as usize)];
    file.read_exact(&mut head).map_err(|e| e.to_string())?;

    let key = (path.clone(), agent.clone());
    // Three answers, in order: nothing moved, so the cached total stands; the
    // same file grew, so resume from where the last call stopped; anything else
    // (shrunk, or a different transcript at this path) starts from the top.
    let resume = match PROMPT_TAIL_CACHE.lock() {
        Ok(guard) => guard.as_ref().and_then(|m| m.get(&key)).and_then(|e| {
            if e.stamp == stamp {
                return Some(Resume::Settled(e.count, e.last_ts));
            }
            (e.head == head && stamp.size >= e.consumed)
                .then_some(Resume::From(e.consumed, e.count, e.last_ts))
        }),
        Err(_) => None,
    };
    let (from, mut count, mut last_ts) = match resume {
        Some(Resume::Settled(count, last_ts)) => return Ok(PromptTail { count, last_ts }),
        Some(Resume::From(from, count, last_ts)) => (from, count, last_ts),
        None => (0, 0, 0),
    };

    file.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let (added, added_ts, complete) = scan_prompts(&text);
    count += added;
    // A window with no prompt in it leaves the last one where it was.
    if added > 0 {
        last_ts = added_ts;
    }

    if let Ok(mut guard) = PROMPT_TAIL_CACHE.lock() {
        guard.get_or_insert_with(HashMap::new).insert(
            key,
            PromptTailEntry { stamp, consumed: from + complete, head, count, last_ts },
        );
    }
    Ok(PromptTail { count, last_ts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn tmp_file(name: &str, contents: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_pi_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, contents).unwrap();
        p
    }

    fn meta(id: &str, cwd: &str, agent: &str, last_active: u64) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            path: format!("/sessions/{id}.jsonl"),
            cwd: cwd.into(),
            branch: String::new(),
            title: "t".into(),
            last_active,
            created_at: last_active,
            name: None,
            agent: agent.into(),
            profile: None,
            profile_label: None,
        }
    }

    // --- three stores, and the (profile, root) pairs the derived one walks ---

    /// A whole machine's worth of layout under one temp dir:
    ///
    ///     <tmp>/default/projects     the adapter's declared discovery dir
    ///     <tmp>/work                 a profile home Tori created
    ///
    /// so a profile's root is `<tmp>/work/projects`, which is the swap Phase 0
    /// measured rather than a shape invented for the test.
    fn tmp_machine(tag: &str) -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tori_profile_{tag}_{n}"));
        std::fs::create_dir_all(dir.join("default/projects")).unwrap();
        dir
    }

    /// One transcript where a agent would write it: a per-cwd directory under
    /// the root, holding `<id>.jsonl`.
    fn write_transcript(root: &Path, cwd: &str, id: &str) -> PathBuf {
        let dir = root.join(cwd.replace('/', "-"));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{id}.jsonl"));
        let line = format!(
            r#"{{"type":"user","cwd":"{cwd}","message":{{"content":[{{"type":"text","text":"hello"}}]}}}}"#
        );
        std::fs::write(&p, format!("{line}\n")).unwrap();
        p
    }

    fn adapter_at(machine: &Path, home_default: Option<&Path>) -> agents::AgentAdapter {
        let mut a = agents::test_adapter("x");
        a.discovery = Some(agents::Discovery::File {
            dir: machine.join("default/projects"),
            filename_regex: regex::Regex::new(r"^(?P<id>.+)\.jsonl$").unwrap(),
        });
        a.accounts = home_default.map(|home| crate::agents::AccountsConfig {
            home_env: Some("X_CONFIG_DIR".into()),
            home_default: Some(home.to_path_buf()),
            home_markers: vec![],
            login_args: vec![],
            logout_args: vec![],
            whoami_args: vec![],
            whoami_kind: None,
            supports_isolation: true,
            onboarded: None,
            plugins_kind: None,
        });
        a
    }

    fn added(id: &str, label: &str, home: &Path) -> crate::accounts::Profile {
        crate::accounts::Profile {
            id: id.into(),
            label: label.into(),
            email: None,
            home: Some(home.to_string_lossy().into_owned()),
            managed: true,
        }
    }

    /// The default profile is the home variable left unset, so its root is the
    /// one the adapter declares, and a second profile's is the same layout under
    /// its own home.
    #[test]
    fn each_profile_contributes_its_own_root() {
        let m = tmp_machine("roots");
        let a = adapter_at(&m, Some(&m.join("default")));
        let profiles =
            vec![crate::accounts::default_profile(), added("work", "Work", &m.join("work"))];

        let roots = roots_for(&a, &profiles);
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].dir, m.join("default/projects"));
        assert_eq!(roots[0].profile, "default");
        assert_eq!(roots[1].dir, m.join("work/projects"), "the layout under a profile home is the same one");
        assert_eq!(roots[1].profile, "work");

        std::fs::remove_dir_all(&m).ok();
    }

    /// A session in an added profile's home resolves, and says whose home it
    /// was in. Before this, resolution stopped at the declared dir, so every
    /// reader of a profile session behaved as though it had no transcript.
    #[test]
    fn a_transcript_resolves_under_a_second_profiles_root() {
        let m = tmp_machine("find");
        let a = adapter_at(&m, Some(&m.join("default")));
        let profiles =
            vec![crate::accounts::default_profile(), added("work", "Work", &m.join("work"))];
        let roots = roots_for(&a, &profiles);
        std::fs::create_dir_all(m.join("work/projects")).unwrap();
        let want = write_transcript(&m.join("work/projects"), "/repo", "sess-1");

        let found = find_transcript(&roots, "sess-1").expect("the second root holds it");
        assert_eq!(found.path, want.to_string_lossy());
        assert_eq!(found.profile, "work", "the root that held it is the account it belongs to");

        std::fs::remove_dir_all(&m).ok();
    }

    /// A profile home nothing has written to yet is an unreadable directory.
    /// Giving up on it would hide every session in the roots after it.
    #[test]
    fn an_unreadable_root_does_not_end_the_search() {
        let m = tmp_machine("skiproot");
        let a = adapter_at(&m, Some(&m.join("default")));
        // `work` comes first and has no `projects` dir at all; `late` holds the file.
        let profiles = vec![
            added("work", "Work", &m.join("work")),
            added("late", "Late", &m.join("late")),
        ];
        let roots = roots_for(&a, &profiles);
        std::fs::create_dir_all(m.join("late/projects")).unwrap();
        write_transcript(&m.join("late/projects"), "/repo", "sess-2");

        let found = find_transcript(&roots, "sess-2").expect("a missing root is skipped, not fatal");
        assert_eq!(found.profile, "late");

        std::fs::remove_dir_all(&m).ok();
    }

    /// A agent Tori does not sign in still has the one root it always had, so
    /// widening discovery to a set did not make an accounts table load-bearing
    /// for finding anything.
    #[test]
    fn an_adapter_with_no_accounts_table_keeps_its_single_root() {
        let m = tmp_machine("noaccounts");
        let a = adapter_at(&m, None);

        let roots = roots_for(&a, &[crate::accounts::default_profile()]);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].dir, m.join("default/projects"));

        std::fs::remove_dir_all(&m).ok();
    }

    /// A profile whose adapter names no default home has no root rather than a
    /// guessed one. Appending the dir's last segment to the profile home, or
    /// scanning the shared dir under that profile's name, would both claim an
    /// attribution nobody measured.
    #[test]
    fn a_profile_whose_adapter_names_no_default_home_is_not_scanned() {
        let m = tmp_machine("nodefault");
        let a = adapter_at(&m, None);
        let profiles =
            vec![crate::accounts::default_profile(), added("work", "Work", &m.join("work"))];

        let roots = roots_for(&a, &profiles);
        assert_eq!(roots.len(), 1, "only the default profile, which needs no swap");
        assert_eq!(roots[0].profile, "default");

        std::fs::remove_dir_all(&m).ok();
    }

    /// Same refusal from the other side: a declared dir that does not sit under
    /// the declared default home has no prefix to swap.
    #[test]
    fn a_discovery_dir_outside_the_default_home_yields_no_profile_root() {
        assert_eq!(
            profile_root(Path::new("/elsewhere/projects"), Path::new("/home/.x"), "/homes/work"),
            None
        );
        assert_eq!(
            profile_root(Path::new("/home/.x/projects"), Path::new("/home/.x"), "/homes/work"),
            Some(PathBuf::from("/homes/work/projects"))
        );
    }

    /// Two accounts, two roots, and every row says which one produced it.
    #[test]
    fn sessions_from_two_profiles_are_listed_with_their_own_tags() {
        let m = tmp_machine("twoprofiles");
        let a = adapter_at(&m, Some(&m.join("default")));
        write_transcript(&m.join("default/projects"), "/repo", "aaa");
        write_transcript(&m.join("work/projects"), "/repo", "bbb");

        let profiles =
            vec![crate::accounts::default_profile(), added("work", "Work", &m.join("work"))];
        let index = SessionIndex::default();
        let mut rows = index_roots(&index, &roots_for(&a, &profiles));
        rows.sort_by(|x, y| x.id.cmp(&y.id));

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].profile.as_deref(), Some("default"));
        assert_eq!(rows[1].profile.as_deref(), Some("work"));

        std::fs::remove_dir_all(&m).ok();
    }

    /// Two profiles that somehow hold the same session id stay two rows. The
    /// cache is keyed by path and a path belongs to exactly one root, so the
    /// second one cannot overwrite the first and take its attribution with it.
    #[test]
    fn one_session_id_under_two_profiles_stays_two_rows() {
        let m = tmp_machine("collision");
        let a = adapter_at(&m, Some(&m.join("default")));
        write_transcript(&m.join("default/projects"), "/repo", "same");
        write_transcript(&m.join("work/projects"), "/repo", "same");

        let profiles =
            vec![crate::accounts::default_profile(), added("work", "Work", &m.join("work"))];
        let index = SessionIndex::default();
        let rows = index_roots(&index, &roots_for(&a, &profiles));

        assert_eq!(rows.len(), 2, "one row would silently hide an account's session");
        assert_ne!(rows[0].path, rows[1].path);
        let mut tags: Vec<_> = rows.iter().filter_map(|r| r.profile.clone()).collect();
        tags.sort();
        assert_eq!(tags, ["default", "work"]);

        std::fs::remove_dir_all(&m).ok();
    }

    /// The index is derived, so throwing it away costs nothing: rescanning
    /// reproduces every row and every profile tag. This is what scopes
    /// `concept_filesystem_source_of_truth` to the third store.
    #[test]
    fn discarding_the_index_reproduces_every_row_and_every_tag() {
        let m = tmp_machine("discard");
        let a = adapter_at(&m, Some(&m.join("default")));
        write_transcript(&m.join("default/projects"), "/repo", "aaa");
        write_transcript(&m.join("work/projects"), "/repo", "bbb");
        let profiles =
            vec![crate::accounts::default_profile(), added("work", "Work", &m.join("work"))];
        let roots = roots_for(&a, &profiles);

        // A rename the user typed, which lives in the overlay and which no
        // rescan could reproduce, plus a second account to tag rows with.
        let mut overlay = HashMap::new();
        overlay.insert("aaa".to_string(), Overlay { name: Some("the good one".into()) });
        let mut accounts = crate::accounts::AccountsFile::default();
        crate::accounts::add_profile(&mut accounts, "x", added("work", "Work", &m.join("work")))
            .unwrap();

        let listing = |index: &SessionIndex| {
            let mut v: Vec<_> = stamp_listing(index_roots(index, &roots), &overlay, &accounts)
                .into_iter()
                .map(|s| (s.id, s.path, s.profile, s.profile_label, s.name, s.title, s.cwd))
                .collect();
            v.sort();
            v
        };

        let warm = SessionIndex::default();
        let first = listing(&warm);
        let _ = index_roots(&warm, &roots); // a second pass hits the mtime cache
        // A brand-new index is exactly the "somebody deleted it" case.
        let rebuilt = listing(&SessionIndex::default());

        assert_eq!(first, rebuilt);
        assert_eq!(first.len(), 2);
        assert!(
            first.iter().any(|r| r.4.as_deref() == Some("the good one")),
            "the rename came back, because it was never in the index to lose"
        );
        assert!(first.iter().any(|r| r.3.as_deref() == Some("Work")));

        std::fs::remove_dir_all(&m).ok();
    }

    /// First run rebuilds rather than migrating. The sources stay the truth, so
    /// history that predates Tori appears on the first scan and nothing is
    /// written into the agent's own directories to make it appear.
    #[test]
    fn existing_history_appears_with_no_migration_step() {
        let m = tmp_machine("firstrun");
        let a = adapter_at(&m, Some(&m.join("default")));
        let root = m.join("default/projects");
        write_transcript(&root, "/repo", "old-one");
        write_transcript(&root, "/other", "old-two");
        let before = std::fs::read_dir(&root).unwrap().count();

        let rows = index_roots(&SessionIndex::default(), &roots_for(&a, &[crate::accounts::default_profile()]));

        assert_eq!(rows.len(), 2, "pre-existing transcripts are listed by the first scan");
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            before,
            "scanning wrote nothing into the agent's own directory"
        );

        std::fs::remove_dir_all(&m).ok();
    }

    /// The invariant that keeps the three stores apart. Both user-authored
    /// fields are stamped onto a listing by `list_sessions`; nothing before it
    /// may assign one, or a rebuild would erase what the user typed.
    #[test]
    fn the_index_holds_no_user_authored_field() {
        let m = tmp_machine("authored");
        let a = adapter_at(&m, Some(&m.join("default")));
        write_transcript(&m.join("default/projects"), "/repo", "aaa");

        let rows = index_roots(&SessionIndex::default(), &roots_for(&a, &[crate::accounts::default_profile()]));
        assert!(rows.iter().all(|s| s.name.is_none() && s.profile_label.is_none()));

        let source = include_str!("sessions.rs");
        let (before_listing, _) = source.split_once("pub fn list_sessions(").unwrap();
        for field in ["s.name = ", "s.profile_label = "] {
            assert!(
                !before_listing.contains(field),
                "a user-authored field is assigned before `list_sessions`: {field}"
            );
        }

        std::fs::remove_dir_all(&m).ok();
    }

    // --- a session with no backing file, at each of the six path readers ---
    //
    // `concept_locator_scheme_for_db_backed_sessions` names six functions that
    // take `SessionMeta.path` and read or stat it directly. Tori has such a
    // session again, in a different disguise: an ACP row's path is Tori's own
    // locator, which is a real file and not a transcript. Each of the six is
    // answered here rather than left to produce a plausible zero by accident.
    //
    // `gemini` is the bundled adapter with no parser kind, which is what makes
    // a session store-less. Its own registry entry is the fixture.

    #[test]
    fn a_store_less_session_reports_no_counts_rather_than_failing() {
        let locator = tmp_file("ses_a.json", "{\n  \"id\": \"ses_a\"\n}\n");
        let path = locator.to_string_lossy().into_owned();
        let touched = TouchedIndex::default();

        let d = detail_of(&touched, &path, "gemini").expect("a store-less session still answers");
        assert_eq!(d.prompt_count, 0);
        assert_eq!(d.turn_count, 0);
        assert_eq!(d.touched_count, 0);
        assert_eq!(d.model, None);

        // The other three readers of the same path say the same thing.
        assert!(extract_touched_files(&path, "gemini").is_empty());
        assert!(parse_transcript_turns(&path, "gemini").is_empty());
        let tail = session_prompt_tail_body(path.clone(), "gemini".into()).expect("prompt tail answers");
        assert_eq!((tail.count, tail.last_ts), (0, 0));

        std::fs::remove_file(&locator).ok();
    }

    /// The trap the concept page records: a path that cannot be stat-ed freezes
    /// the touched cache at the epoch, so it matches forever and never
    /// re-reads. A locator is a real file, so the stat succeeds - pinned here,
    /// because "it happens to be a real file" is exactly the kind of property
    /// that a later change quietly removes.
    #[test]
    fn the_touched_cache_does_not_freeze_at_the_epoch() {
        let locator = tmp_file("ses_b.json", "{\n  \"id\": \"ses_b\"\n}\n");
        let path = locator.to_string_lossy().into_owned();
        let index = TouchedIndex::default();

        assert!(touched_files_cached(&index, &path, "gemini").is_empty());
        let cache = index.0.lock().unwrap();
        let entry = cache.get(&locator).expect("the answer was cached");
        assert_ne!(
            entry.mtime,
            SystemTime::UNIX_EPOCH,
            "a cache stamped at the epoch matches every later read and never refreshes"
        );
        drop(cache);

        std::fs::remove_file(&locator).ok();
    }

    /// Deleting a store-less session cannot mean deleting its history: the
    /// agent has that, and no protocol verb removes it. All Tori can drop is
    /// its own record, and it refuses a path that is not one, so naming a
    /// protocol-backed agent is not a way to delete an arbitrary file.
    #[test]
    fn deleting_a_store_less_session_refuses_a_path_outside_toriss_own_store() {
        let stranger = tmp_file("not-a-locator.json", "{}\n");
        let path = stranger.to_string_lossy().into_owned();

        let err = delete_session(path.clone(), "gemini".into()).unwrap_err();
        assert!(err.contains("not one of Tori's session records"), "{err}");
        assert!(stranger.exists(), "the file it refused is still there");

        // The transcript branch is unchanged, and is what actually deletes.
        delete_session(path, "claude".into()).expect("a transcript is removed");
        assert!(!stranger.exists());
    }

    /// The two shapes are hand-synced, so something has to compare them. A
    /// TypeScript type is erased at runtime and can only be checked by reading
    /// it, which is what this does: every field the backend serializes must be
    /// declared in the frontend's mirror, or a listing carries something no
    /// screen can see. The same recurrence `component_agent_adapter_registry`
    /// records, caught the same way.
    #[test]
    fn the_typescript_mirror_lists_every_serialized_field() {
        let home = crate::unit_home::Home { project: "/repo".into(), folder: "/repo".into(), branch: None };
        let row = Listed { meta: meta("a", "/repo", "claude", 1), home: Some(home) };
        let json = serde_json::to_value(&row).unwrap();
        let fields: Vec<String> =
            json.as_object().unwrap().keys().cloned().collect();

        let ts = include_str!("../../src/utils/sessionStore.ts");
        let (_, after) = ts.split_once("export type SessionMeta = {").unwrap();
        let (block, _) = after.split_once("};").unwrap();

        for field in &fields {
            assert!(
                block.contains(&format!("{field}:")) || block.contains(&format!("{field}?:")),
                "`{field}` is serialized but missing from the TypeScript mirror"
            );
        }
        // And the other direction, so a field deleted in Rust does not linger
        // in the mirror as a promise nothing keeps.
        for line in block.lines().map(str::trim).filter(|l| l.ends_with(';')) {
            let name = line.split(['?', ':']).next().unwrap_or_default();
            assert!(
                fields.iter().any(|f| f == name),
                "`{name}` is declared in the TypeScript mirror but nothing serializes it"
            );
        }
    }

    /// A label is worth showing only when it tells two accounts apart, so a
    /// machine that never added one renders exactly as it did before.
    #[test]
    fn an_account_is_named_only_when_there_is_another_to_confuse_it_with() {
        let mut file = crate::accounts::AccountsFile::default();
        assert_eq!(profile_label(&file, "x", Some("default")), None);

        crate::accounts::add_profile(
            &mut file,
            "x",
            added("work", "Work", Path::new("/homes/work")),
        )
        .unwrap();
        assert_eq!(profile_label(&file, "x", Some("work")).as_deref(), Some("Work"));
        assert_eq!(profile_label(&file, "x", Some("default")).as_deref(), Some("Default"));
        // A row Tori cannot attribute names no account rather than the first one.
        assert_eq!(profile_label(&file, "x", None), None);
        // And a tag for a profile that has since been removed names nothing.
        assert_eq!(profile_label(&file, "x", Some("gone")), None);
    }

    #[test]
    fn scan_counts_claude_counts_compactions_excluding_sidechain() {
        let body = r#"{"type":"user","message":{"content":[{"type":"text","text":"Fix the bug"}]}}
{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","name":"Edit"}],"usage":{"output_tokens":10,"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"manual","preTokens":1000,"postTokens":200}}
{"type":"system","subtype":"compact_boundary","isSidechain":true,"compactMetadata":{"trigger":"auto","preTokens":500,"postTokens":100}}
"#;
        let r = scan_counts(std::io::Cursor::new(body));
        // One sidechain marker is ignored: count 1, reclaimed 1000-200.
        assert_eq!(r.compaction_count, 1);
        assert_eq!(r.compaction_reclaimed, 800);
        // Existing counts unchanged by the refactor.
        assert_eq!(r.prompt_count, 1);
        assert_eq!(r.turn_count, 1);
        assert_eq!(r.tool_count, 1);
        assert_eq!(r.model.as_deref(), Some("claude-opus-4-8"));
    }

    /// The context is the newest *main-chain* response, and only ever one of
    /// them. Assigning rather than summing is what keeps a long session under
    /// its own window; skipping sidechains is what stops a Task, which runs in
    /// a context of its own, reporting its occupancy as the conversation's.
    #[test]
    fn scan_counts_reads_context_off_the_last_main_chain_response() {
        let body = r#"{"type":"assistant","message":{"content":[],"usage":{"output_tokens":1,"input_tokens":2,"cache_read_input_tokens":17440,"cache_creation_input_tokens":0}}}
{"type":"assistant","message":{"content":[],"usage":{"output_tokens":1,"input_tokens":2,"cache_read_input_tokens":23532,"cache_creation_input_tokens":234}}}
{"type":"assistant","isSidechain":true,"message":{"content":[],"usage":{"output_tokens":1,"input_tokens":9,"cache_read_input_tokens":999999,"cache_creation_input_tokens":0}}}
"#;
        let r = scan_counts(std::io::Cursor::new(body));
        // The second response, whole: 2 + 23532 + 234. Not the sum of the two
        // (which would be 41210, a conversation that never existed), and not
        // the subagent's, which arrived last.
        assert_eq!(r.context_tokens, 23_768);
        // Output still totals, because a session's output really is the sum of
        // what it wrote.
        assert_eq!(r.output_tokens, 3);
    }

    /// Parse a committed transcript head from `dev/fixtures/sessions/`. Resolved
    /// from `CARGO_MANIFEST_DIR`, never from `$HOME`: a scanner test that read the
    /// developer's own `~/.claude/projects` would pass or fail per machine.
    fn session_fixture(name: &str) -> SessionMeta {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/sessions")
            .join(format!("{name}.jsonl"));
        let t = UNIX_EPOCH + Duration::from_secs(1_775_000_000);
        parse_session(&path, t, t, "claude")
            .unwrap_or_else(|| panic!("fixture {name} parses"))
    }

    /// Titles for the real head shapes in `dev/fixtures/sessions/`. This began as
    /// a characterization of the old extractor, which returned `(untitled session)`
    /// for the two slash-command openers below even though both transcripts carry
    /// the prompt; it is inverted here onto the recovered titles.
    ///
    /// The two `local-command-*` fixtures are the pair that carries the rule: an
    /// envelope introduced by `<local-command-caveat>` is a client-side command and
    /// never a title, even when it has args (`/model haiku`), while an envelope with
    /// no caveat is a skill the person invoked, which *is* what they typed.
    #[test]
    fn claude_titles_recover_a_slash_command_opener_and_skip_local_commands() {
        // The ordinary path, unchanged.
        assert_eq!(
            session_fixture("plain-prompt").title,
            "Reply with exactly the word: one. Do not use any tools."
        );
        // The prompt sits in `<command-args>`, not in the envelope's own text.
        assert_eq!(
            session_fixture("slash-opener-with-args").title,
            "/plan we can add new group but tere is no way to delete a group."
        );
        // `/clear` is skipped as local; the `/gg` after it carries no args, so the
        // command itself is the whole of what the person typed.
        assert_eq!(session_fixture("clear-then-slash-opener").title, "/gg");
        // A local command with args still yields to the message typed after it.
        assert_eq!(session_fixture("local-command-then-prompt").title, "hello");
    }

    /// A session that only ever ran a client-side command has nothing a person
    /// said in it. It must stay untitled rather than surface a fragment of the
    /// envelope (`/model`, or worse `<command-name>`), which would read as if the
    /// user had typed it.
    #[test]
    fn claude_title_stays_empty_for_a_contentless_session() {
        assert_eq!(session_fixture("local-command-only").title, "(untitled session)");
    }

    /// The degradation paths behind that promise. A malformed envelope must yield
    /// nothing, because the alternative is a title made of raw markup: whatever
    /// `command_prompt` returns is shown to the user as their own words.
    #[test]
    fn command_prompt_needs_a_named_command_and_a_closed_args_tag() {
        assert_eq!(
            command_prompt("<command-name>/plan</command-name><command-args>tidy up</command-args>")
                .as_deref(),
            Some("/plan tidy up")
        );
        // No args tag, and an empty one, are both just the command.
        assert_eq!(command_prompt("<command-name>/gg</command-name>").as_deref(), Some("/gg"));
        assert_eq!(
            command_prompt("<command-name>/gg</command-name><command-args></command-args>").as_deref(),
            Some("/gg")
        );
        // Unclosed args: the body cannot be read, so the command stands alone
        // rather than swallowing the rest of the message.
        assert_eq!(
            command_prompt("<command-name>/plan</command-name><command-args>tidy up").as_deref(),
            Some("/plan")
        );
        // Nothing nameable: untitled beats a fragment of markup.
        assert_eq!(command_prompt("<command-message>plan</command-message>"), None);
        assert_eq!(command_prompt("<command-name></command-name>"), None);
        assert_eq!(command_prompt("<command-name>/plan"), None);
    }

    #[test]
    fn cwd_matches_exact_and_nested_only() {
        assert!(cwd_matches("/a/b", "/a/b")); // exact
        assert!(cwd_matches("/a/b/", "/a/b")); // trailing slash normalized
        assert!(cwd_matches("/a/b/c/d", "/a/b")); // nested
        assert!(!cwd_matches("/a/bc", "/a/b")); // sibling sharing a prefix
        assert!(!cwd_matches("/a", "/a/b")); // parent is not under child
    }

    #[test]
    fn listing_never_claims_a_repos_own_topic_worktrees() {
        let repo = "/p/repo";
        let member = "/p/repo/.tori/worktrees/auth";
        let cwd = "/p/repo/.tori/worktrees/auth/sub";
        // The repo lists its own tree but not the Topic worktrees inside it.
        assert!(owned_by_listing("/p/repo/src", repo));
        assert!(!owned_by_listing(cwd, repo));
        assert!(!owned_by_listing(member, repo));
        // The member folder claims them by plain prefix.
        assert!(owned_by_listing(cwd, member));
        assert!(owned_by_listing(member, member));
        // Teardown keeps the inclusive rule: `ids_under` is `cwd_matches`.
        assert!(cwd_matches(cwd, repo));

        let all = vec![meta("in-repo", "/p/repo/src", "claude", 1), meta("in-member", cwd, "claude", 2)];
        let ids = |folder: &str, inclusive: bool| -> Vec<String> {
            filter_sort(all.clone(), folder, inclusive).into_iter().map(|s| s.id).collect()
        };
        assert_eq!(ids(repo, false), vec!["in-repo"]);
        assert_eq!(ids(member, false), vec!["in-member"]);
        // A destructive confirm counts everything the removal will reach.
        assert_eq!(ids(repo, true), vec!["in-member", "in-repo"]);
    }

    #[test]
    fn filter_sort_merges_agents_under_folder_newest_first() {
        let all = vec![
            meta("claude-root", "/p/wt", "claude", 100),
            meta("other-agent-nested", "/p/wt/src", "gemini", 300),
            meta("claude-old", "/p/wt", "claude", 50),
            meta("other", "/p/elsewhere", "claude", 999), // excluded
        ];
        let got = filter_sort(all, "/p/wt", false);
        let ids: Vec<&str> = got.iter().map(|s| s.id.as_str()).collect();
        // Excludes the non-matching folder; sorted newest-first.
        assert_eq!(ids, vec!["other-agent-nested", "claude-root", "claude-old"]);
        // A user adapter's sessions merge under the same folder as the built-in's.
        assert!(got.iter().any(|s| s.agent == "gemini"));
        assert!(got.iter().any(|s| s.agent == "claude"));
    }

    #[test]
    fn seed_is_once_and_skips_empty() {
        let mut st = AdoptedState::default();
        // Empty discovery never seeds (so a forced empty resolve cannot lock in).
        assert!(!do_seed(&mut st, &[]));
        assert!(!st.seeded);
        // First real discovery seeds every folder.
        let folders = vec!["/p/a".to_string(), "/p/b/".to_string()];
        assert!(do_seed(&mut st, &folders));
        assert!(st.seeded);
        assert!(st.paths.contains("/p/a"));
        assert!(st.paths.contains("/p/b")); // trailing slash normalized
        // Idempotent: a later discovery does not re-seed (a new folder added then
        // is judged on its own, not blanket-adopted).
        assert!(!do_seed(&mut st, &["/p/c".to_string()]));
        assert!(!st.paths.contains("/p/c"));
    }

    /// Listing a folder must not adopt it. `folder_verdict` returns `AutoAdopt`
    /// for a folder whose sessions all postdate it, and `folder_historical` then
    /// persists that to adopted.json - so a listing that reached the verdict
    /// would pre-adopt folders the user never opened, permanently disabling the
    /// ghost protection for every one of them.
    ///
    /// Asserted against the source because the write is two calls down
    /// (`folder_historical` -> `adopt` -> `save_adopted`) and `list_sessions`
    /// takes a Tauri `State`, which a unit test cannot hand it.
    #[test]
    fn listing_a_folder_never_reaches_the_adopting_verdict() {
        let source = include_str!("sessions.rs");
        let body = source
            .split_once("pub fn list_sessions(")
            .expect("list_sessions exists")
            .1;
        // Up to the next top-level item, which is the adopted-paths section.
        let body = body.split_once("\n// ---").expect("section follows").0;
        for forbidden in ["folder_verdict", "folder_historical", "adopt(", "save_adopted"] {
            assert!(
                !body.contains(forbidden),
                "list_sessions reaches {forbidden}; listing a folder must not persist an adoption"
            );
        }
    }

    #[test]
    fn verdict_adopted_when_in_set_or_no_sessions() {
        let mut set = HashSet::new();
        set.insert("/p/a".to_string());
        assert!(matches!(folder_verdict(&set, "/p/a", &[50], 100), FolderVerdict::Adopted));
        // Not in the set but no sessions: nothing to hide.
        assert!(matches!(folder_verdict(&set, "/p/b", &[], 100), FolderVerdict::Adopted));
    }

    #[test]
    fn verdict_autoadopt_when_all_postdate_else_historical() {
        let set = HashSet::new();
        // All sessions postdate the folder's creation: they are ours.
        assert!(matches!(folder_verdict(&set, "/p/a", &[150, 200], 100), FolderVerdict::AutoAdopt));
        // A session predating creation: a recreated folder with ghosts.
        assert!(matches!(folder_verdict(&set, "/p/a", &[50, 200], 100), FolderVerdict::Historical));
    }

    /// Does `pattern` (an extended regex passed to `pgrep -f`) match `cmdline`?
    /// Verified via the system's own ERE engine (`grep -E`), the same dialect
    /// BSD `pgrep -f` uses natively, so the test exercises real matching
    /// behavior without a Rust regex dependency.
    fn ere_matches(pattern: &str, cmdline: &str) -> bool {
        Command::new("sh")
            .arg("-c")
            .arg(format!("printf '%s' '{cmdline}' | grep -Eq -- '{pattern}'"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[test]
    fn session_pattern_claude_matches_resume_and_alias_not_transcript_view() {
        let id = "abc-123-def";
        let pat = session_pattern("claude", id).expect("claude declares a running pattern");
        assert!(ere_matches(&pat, "claude --resume abc-123-def"));
        assert!(ere_matches(&pat, "claude -r abc-123-def")); // -r alias
        // Trailing flags after the id still match (no end anchor).
        assert!(ere_matches(&pat, "claude --resume abc-123-def --dangerously-skip-permissions"));
        // A transcript merely opened in `less` must NOT match - the bare-uuid
        // pgrep collision this pattern replaces.
        assert!(!ere_matches(&pat, "less /Users/x/.claude/projects/-Users-x-proj/abc-123-def.jsonl"));
    }

    /// The batch probe's matching half, against real `pgrep -lf` output captured
    /// on macOS (pids stripped, home path redacted). One chat session is live;
    /// the two PTY-style ids are not, and the decoys are processes that merely
    /// mention an id.
    ///
    /// The live line carries its id **twice** (once after `--resume`, once inside
    /// the `--settings` path), which is why the pattern has to anchor on an
    /// argument token rather than just containing the id.
    #[test]
    fn running_ids_resolves_a_batch_against_captured_pgrep_output() {
        let live = "ff243892-6e71-469f-913c-7e9c39d4916f";
        let pty = "0c7aeea2-b79a-4ce7-8819-c10b3a1b0dd5";
        let dead = "22748218-3a63-4c8c-9012-11338279bf8e";
        let lines: Vec<String> = [
            format!(
                "claude -p --input-format stream-json --output-format stream-json --verbose \
                 --include-partial-messages --include-hook-events --resume {live} \
                 --settings /Users/dev/.config/tori/chat-settings/{live}.json"
            ),
            format!("claude --resume {pty}"),
            // Decoys: neither is an agent driving the session.
            format!("tail -f /Users/dev/.claude/projects/-Users-dev-proj/{dead}.jsonl"),
            "node /Users/dev/.claude/plugins/cache/context-mode/start.mjs".to_string(),
        ]
        .to_vec();

        let ids = vec![live.to_string(), pty.to_string(), dead.to_string()];
        let running = running_ids("claude", &ids, &lines);
        assert_eq!(running, vec![live.to_string(), pty.to_string()]);

        // A chat started with --session-id rather than --resume is equally live.
        let fresh = "9b09f95f-b189-401b-9f1a-278933f19bb9";
        let chat = vec![format!("claude -p --input-format stream-json --session-id {fresh}")];
        assert_eq!(
            running_ids("claude", &[fresh.to_string()], &chat),
            vec![fresh.to_string()]
        );

        // Nothing running resolves every id to not-running, without erroring.
        assert!(running_ids("claude", &ids, &[]).is_empty());
    }

    /// The property the batch call exists for, observed rather than inferred:
    /// one process lookup per *agent*, however many ids are asked about, and a
    /// repeated id answered once.
    #[test]
    fn resolve_running_looks_up_once_per_agent_and_dedupes_ids() {
        let a = "ff243892-6e71-469f-913c-7e9c39d4916f";
        let b = "0c7aeea2-b79a-4ce7-8819-c10b3a1b0dd5";
        let dead = "22748218-3a63-4c8c-9012-11338279bf8e";
        let asked = std::cell::RefCell::new(Vec::<String>::new());

        let sessions: Vec<SessionRef> = [(a, "claude"), (b, "claude"), (dead, "claude"), (a, "claude")]
            .iter()
            .map(|(id, agent)| SessionRef { id: id.to_string(), agent: agent.to_string() })
            .collect();

        let mut running = resolve_running(
            sessions,
            |_| true,
            |agent| {
                asked.borrow_mut().push(agent.to_string());
                vec![format!("claude --resume {a}"), format!("claude -p --session-id {b}")]
            },
            |_| unreachable!("a pattern-findable agent never asks the claims"),
        );
        running.sort();

        // Four ids over one agent cost exactly one lookup, and `a` asked twice
        // is answered once, so a caller counting the list cannot double-count.
        assert_eq!(asked.borrow().as_slice(), ["claude"]);
        let mut expected = vec![a.to_string(), b.to_string()];
        expected.sort();
        assert_eq!(running, expected);
    }

    /// The failure this prevents: an ACP agent is launched as a plain
    /// `opencode acp` and mints its session id inside the protocol, so every one
    /// of its sessions has the same command line. Matching a pattern against
    /// them would report all of them running whenever any one was; the claims,
    /// which record a child pid per session, are the only thing that can tell
    /// them apart.
    #[test]
    fn an_agent_not_findable_by_pattern_is_resolved_from_the_claims_instead() {
        let live = "acp-live";
        let dead = "acp-dead";
        let sessions: Vec<SessionRef> = [live, dead]
            .iter()
            .map(|id| SessionRef { id: id.to_string(), agent: "opencode".to_string() })
            .collect();

        let running = resolve_running(
            sessions,
            |_| false,
            |_| unreachable!("an agent with no usable pattern must never reach pgrep"),
            |ids| ids.iter().filter(|id| *id == live).cloned().collect(),
        );

        assert_eq!(running, vec![live.to_string()]);
    }

    /// A listed ACP row carries four fields, and the two it does not carry are
    /// the ones worth pinning: an empty branch renders as no branch, where a
    /// borrowed one would file the session under a branch unit it was never in.
    #[test]
    fn an_acp_row_carries_no_branch_rather_than_a_borrowed_one() {
        let meta = acp_meta(crate::chat::acp_sessions::AcpSession {
            id: "ses_a".into(),
            agent: "opencode".into(),
            acp_session_id: "ses_a".into(),
            cwd: "/repo".into(),
            title: "fix the sidebar".into(),
            updated_at: 1_786_708_800,
        });

        assert_eq!(meta.branch, "");
        assert_eq!(meta.agent, "opencode");
        assert_eq!(meta.title, "fix the sidebar");
        assert_eq!(meta.last_active, 1_786_708_800);
        // ACP records no creation time, so the one field that would have to be
        // invented repeats what is known rather than guessing an earlier date.
        assert_eq!(meta.created_at, meta.last_active);
        // The locator is a real file at a real path, which is what keeps
        // `SessionMeta.path` honest without becoming an `Option`.
        assert!(meta.path.ends_with("ses_a.json"), "{}", meta.path);
    }

    /// The signature is the other half of that guarantee: a caller cannot fall
    /// back to per-id probing without changing it.
    #[test]
    fn sessions_running_takes_a_list_so_spawns_do_not_scale_with_ids() {
        let source = include_str!("sessions.rs");
        assert!(
            source.contains("    sessions: Vec<SessionRef>,\n) -> Result<Vec<String>, String>"),
            "the batch probe must take a list of sessions, not one id"
        );
        // The single-id `pgrep` belongs to `session_running` alone. A third call
        // site would mean some path went back to probing per session.
        //
        // Assembled rather than written out, so this line is not itself a match.
        let call_site = format!("Command::new(\"{}\")", "pgrep");
        assert_eq!(
            source.matches(&call_site).count(),
            2,
            "expected exactly two pgrep call sites: the single probe and the batch one"
        );
    }

    /// **Opening a folder must not start a single agent.** Every ACP row in the
    /// sidebar comes out of a locator Tori wrote during a session the user
    /// opened by hand, so listing is a directory read. The alternative anyone
    /// would reach for, asking each installed agent what it has, would spawn
    /// every ACP agent on the machine to render a list, on every folder open.
    ///
    /// Structural, because the failure is a call that should not be there rather
    /// than a wrong answer: `acp_sessions()` returning good rows proves nothing
    /// about what it started to get them. The call site is assembled so this
    /// line is not itself a match, the same way the `pgrep` count above is.
    #[test]
    fn opening_a_folder_reads_locators_rather_than_starting_an_agent() {
        let source = include_str!("chat/acp_sessions.rs");
        let spawn = format!("Command::new{}", "(");
        assert_eq!(
            source.matches(&spawn).count(),
            0,
            "the locator store must never spawn a process: it is a directory read"
        );

        // And the reading half really is a read: a locator written to a redirected
        // store comes back with no agent alive anywhere.
        let dir = std::env::temp_dir().join(format!("tori-locator-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::chat::acp_sessions::use_dir_for_tests(dir.clone());
        crate::chat::acp_sessions::record(&crate::chat::acp_sessions::AcpSession {
            id: "ses_read".into(),
            agent: "codex".into(),
            acp_session_id: "codex-123".into(),
            cwd: "/repo".into(),
            title: "from a listing".into(),
            updated_at: 1_786_708_800,
        })
        .expect("the locator should write");

        let rows = acp_sessions();
        let _ = std::fs::remove_dir_all(&dir);
        let row = rows.iter().find(|r| r.id == "ses_read").unwrap_or_else(|| {
            let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
            panic!("the recorded session should list, got {ids:?}")
        });
        assert_eq!(row.agent, "codex", "a listed row names the agent that produced it");
    }

    #[test]
    /// One adapter ships, so one directory is watched. The count is the claim:
    /// a stale root left behind would make the watcher create and watch a
    /// directory for an agent that no longer exists. Read with no added accounts,
    /// since those belong to the machine running the test, not to the adapter.
    fn watch_dirs_covers_every_agent_root() {
        let dirs: Vec<PathBuf> =
            discovery_roots(&crate::accounts::AccountsFile::default()).into_iter().map(|r| r.dir).collect();
        assert_eq!(dirs.len(), 1, "one bundled adapter, one watched root: {dirs:?}");
        assert!(dirs[0].ends_with(".claude/projects"));
    }

    #[test]
    fn the_watcher_creates_a_root_only_under_a_managed_home() {
        let m = tmp_machine("watch");
        std::fs::remove_dir_all(m.join("default")).unwrap();
        let a = adapter_at(&m, Some(&m.join("default")));
        let profiles =
            vec![crate::accounts::default_profile(), added("work", "Work", &m.join("work"))];

        let dirs = watchable_dirs(roots_for(&a, &profiles)).unwrap();
        assert_eq!(dirs, [m.join("work/projects")], "the missing default root is skipped");
        assert!(m.join("work/projects").is_dir(), "a managed home gets its root created");
        assert!(!m.join("default").exists(), "nothing is made where the default home would be");

        std::fs::remove_dir_all(&m).ok();
    }

    #[test]
    fn parse_rfc3339_secs_matches_known_values() {
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_secs("2026-07-12T21:30:57.357Z"), Some(1783891857));
        assert_eq!(parse_rfc3339_secs("2000-02-29T00:00:00Z"), Some(951782400)); // leap day
        assert_eq!(parse_rfc3339_secs("2026-01-01T00:00:00Z"), Some(1767225600));
        assert_eq!(parse_rfc3339_secs("not-a-timestamp"), None);
        assert_eq!(parse_rfc3339_secs("2026-07-12"), None); // too short
    }

    #[test]
    fn infer_bash_touch_covers_sed_redirect_and_rm_only() {
        assert_eq!(
            infer_bash_touch("sed -i '' 's/a/b/' src/app.rs"),
            Some(("src/app.rs".to_string(), TouchOp::Edit))
        );
        // GNU form (no backup-extension arg after -i).
        assert_eq!(
            infer_bash_touch("sed -i 's/a/b/' file.txt"),
            Some(("file.txt".to_string(), TouchOp::Edit))
        );
        assert_eq!(
            infer_bash_touch("echo hi > out.txt"),
            Some(("out.txt".to_string(), TouchOp::Create))
        );
        assert_eq!(
            infer_bash_touch("echo hi >> out.txt"),
            Some(("out.txt".to_string(), TouchOp::Edit))
        );
        assert_eq!(
            infer_bash_touch("rm -f stale.log"),
            Some(("stale.log".to_string(), TouchOp::Delete))
        );
        // Not one of the three covered shapes: no touch inferred.
        assert_eq!(infer_bash_touch("npm install"), None);
        assert_eq!(infer_bash_touch("mv a.txt b.txt"), None);
    }

    #[test]
    fn normalize_touch_path_resolves_relative_against_cwd_leaves_absolute() {
        assert_eq!(normalize_touch_path("src/app.rs", "/Users/x/proj"), "/Users/x/proj/src/app.rs");
        assert_eq!(normalize_touch_path("./src/app.rs", "/Users/x/proj"), "/Users/x/proj/src/app.rs");
        assert_eq!(
            normalize_touch_path("/Users/x/proj/src/app.rs", "/Users/x/proj"),
            "/Users/x/proj/src/app.rs"
        );
        // Trailing slash on cwd doesn't double up.
        assert_eq!(normalize_touch_path("src/app.rs", "/Users/x/proj/"), "/Users/x/proj/src/app.rs");
    }

    #[test]
    fn extract_touched_files_claude_dedupes_bash_sed_against_absolute_edit() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:00.000Z","message":{"content":[{"type":"text","text":"go"}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/Users/x/proj/new.txt","content":"hi"}}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:10.000Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"sed -i '' 's/a/b/' src/app.rs"}}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:15.000Z","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/Users/x/proj/src/app.rs","old_string":"a","new_string":"b"}}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:20.000Z","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/x/proj/README.md"}}]}}
"#;
        let p = tmp_file("claude_touch.jsonl", body);
        let files = extract_touched_files(p.to_str().unwrap(), "claude");

        // The Bash sed (relative `src/app.rs`) and the absolute Edit dedupe onto
        // the same normalized path, not two entries.
        let app_rs = files
            .iter()
            .find(|f| f.path == "/Users/x/proj/src/app.rs")
            .expect("bash sed + absolute edit dedupe onto one path");
        assert_eq!(app_rs.op, TouchOp::Edit);
        assert_eq!(app_rs.count, 2);

        let new_txt = files.iter().find(|f| f.path == "/Users/x/proj/new.txt").expect("write recorded");
        assert_eq!(new_txt.op, TouchOp::Create);

        let readme = files.iter().find(|f| f.path == "/Users/x/proj/README.md").expect("read recorded");
        assert_eq!(readme.op, TouchOp::Read);

        // touched_count's own filter: reads excluded.
        assert_eq!(files.iter().filter(|f| f.op != TouchOp::Read).count(), 2);

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    fn touched(path: &str, op: TouchOp, last_ts: u64) -> TouchedFile {
        TouchedFile {
            path: path.into(),
            op,
            first_ts: last_ts,
            last_ts,
            count: 1,
        }
    }

    #[test]
    fn latest_written_picks_the_newest_write_and_ignores_a_newer_read() {
        // The read is the newest touch overall, but the indicator must name the
        // file being *changed*, not the one being looked at.
        let files = vec![
            touched("/p/old.rs", TouchOp::Edit, 100),
            touched("/p/new.rs", TouchOp::Create, 200),
            touched("/p/looked-at.rs", TouchOp::Read, 300),
        ];
        assert_eq!(latest_written(&files).unwrap().path, "/p/new.rs");
    }

    #[test]
    fn latest_written_is_none_when_the_session_only_read() {
        let files = vec![
            touched("/p/a.rs", TouchOp::Read, 100),
            touched("/p/b.rs", TouchOp::Read, 200),
        ];
        assert!(latest_written(&files).is_none());
        assert!(latest_written(&[]).is_none());
    }

    #[test]
    fn latest_written_does_not_depend_on_input_order() {
        // extract_touched_files sorts newest-first, but the helper must not rely
        // on that - a caller that filtered or reordered still gets the max.
        let files = vec![
            touched("/p/newest.rs", TouchOp::Edit, 300),
            touched("/p/mid.rs", TouchOp::Delete, 200),
        ];
        let reversed: Vec<TouchedFile> = files.iter().rev().cloned().collect();
        assert_eq!(latest_written(&files).unwrap().path, "/p/newest.rs");
        assert_eq!(latest_written(&reversed).unwrap().path, "/p/newest.rs");
    }

    #[test]
    fn touched_files_cached_returns_cached_entry_when_mtime_matches() {
        let body = "{\"type\":\"session\",\"id\":\"real\",\"cwd\":\"/x\"}\n";
        let p = tmp_file("cache_hit.jsonl", body);
        let mtime = std::fs::metadata(&p).unwrap().modified().unwrap();

        let index = TouchedIndex::default();
        // Prime the cache with a fake entry at the file's real (current) mtime.
        {
            let mut cache = index.0.lock().unwrap();
            cache.insert(
                p.clone(),
                TouchedCacheEntry {
                    mtime,
                    files: vec![TouchedFile {
                        path: "/fake/cached.txt".to_string(),
                        op: TouchOp::Edit,
                        first_ts: 1,
                        last_ts: 1,
                        count: 9,
                    }],
                },
            );
        }

        let files = touched_files_cached(&index, p.to_str().unwrap(), "claude");
        // The fake cached entry came back untouched - a re-parse would have
        // returned nothing (the fixture has no tool calls at all).
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "/fake/cached.txt");
        assert_eq!(files[0].count, 9);

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn touched_files_cached_reparses_when_mtime_is_stale() {
        let body = r#"{"type":"user","cwd":"/y","timestamp":"2026-07-12T10:00:00.000Z","message":{"content":"write it"}}
{"type":"assistant","cwd":"/y","timestamp":"2026-07-12T10:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/y/real.txt"}}]}}
"#;
        let p = tmp_file("cache_stale.jsonl", body);

        let index = TouchedIndex::default();
        {
            let mut cache = index.0.lock().unwrap();
            cache.insert(
                p.clone(),
                TouchedCacheEntry {
                    mtime: SystemTime::UNIX_EPOCH, // deliberately stale
                    files: vec![TouchedFile {
                        path: "/fake/cached.txt".to_string(),
                        op: TouchOp::Edit,
                        first_ts: 1,
                        last_ts: 1,
                        count: 9,
                    }],
                },
            );
        }

        let files = touched_files_cached(&index, p.to_str().unwrap(), "claude");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "/y/real.txt"); // re-parsed the real fixture, not the stale cache

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    // Shape taken from a real transcript: a pasted image is a top-level `image`
    // block on the user record, beside the text, with its bytes inline.
    #[test]
    fn parse_transcript_turns_keeps_an_images_place_without_its_bytes() {
        let body = r#"{"type":"user","cwd":"/p","timestamp":"2026-09-04T10:00:00.000Z","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}},{"type":"text","text":"what colour is this?"}]}}
{"type":"user","cwd":"/p","timestamp":"2026-09-04T10:00:05.000Z","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}}
"#;
        let p = tmp_file("image_turn.jsonl", body);
        let turns = parse_transcript_turns(p.to_str().unwrap(), "claude");

        let kinds: Vec<&str> = turns[0].blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["image", "text"]);
        // The bytes stay on disk: replay redraws no screenshot, so holding a
        // session's worth of them would buy nothing.
        assert!(turns[0].blocks[0].text.is_none());

        // An image-only prompt is still a prompt. It used to parse to an empty
        // block list and be dropped, which lost the turn outright.
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].blocks.len(), 1);
        assert_eq!(turns[1].blocks[0].kind, "image");

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn parse_transcript_turns_claude_orders_text_thinking_tool_use_and_result() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:00.000Z","message":{"content":"fix the bug"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:05.000Z","message":{"content":[{"type":"thinking","thinking":"let me look"},{"type":"text","text":"looking now"},{"type":"tool_use","name":"Read","input":{"file_path":"/Users/x/proj/a.rs"}}]}}
{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:10.000Z","isMeta":false,"message":{"content":[{"type":"tool_result","content":"file contents","is_error":false}]}}
{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-12T10:00:12.000Z","isMeta":true,"message":{"content":"skipped: meta noise"}}
"#;
        let p = tmp_file("claude_transcript.jsonl", body);
        let turns = parse_transcript_turns(p.to_str().unwrap(), "claude");

        // isMeta is dropped; the other 3 lines parse, chronological (oldest-first).
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[0].blocks[0].kind, "text");
        assert_eq!(turns[0].blocks[0].text.as_deref(), Some("fix the bug"));

        assert_eq!(turns[1].role, "assistant");
        let kinds: Vec<&str> = turns[1].blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["thinking", "text", "tool_call"]);
        assert_eq!(turns[1].blocks[2].tool_name.as_deref(), Some("Read"));

        assert_eq!(turns[2].role, "user");
        assert_eq!(turns[2].blocks[0].kind, "tool_result");
        assert_eq!(turns[2].blocks[0].text.as_deref(), Some("file contents"));
        assert_eq!(turns[2].blocks[0].is_error, Some(false));

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_claude_pending_tool_use_is_blocked_candidate() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"run the tests"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":[{"type":"text","text":"On it."},{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}
"#;
        let p = tmp_file("claude_tail_pending.jsonl", body);
        // claude's needs_you capability is on, so the join surfaces directly.
        // No hook status file exists for this id, so the hooks capability
        // falls through to the tail join too.
        assert_eq!(session_tail_state_body("no-hook-file-1".into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(), TailState::BlockedCandidate);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_claude_final_text_is_done() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"what does main.rs do?"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/x/proj/main.rs"}}]}}
{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:06.000Z","isMeta":false,"message":{"content":[{"type":"tool_result","content":"fn main() {}","is_error":false}]}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:08.000Z","message":{"content":[{"type":"text","text":"It's an empty entry point."}]}}
"#;
        let p = tmp_file("claude_tail_done.jsonl", body);
        assert_eq!(session_tail_state_body("no-hook-file-2".into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(), TailState::Done);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

#[test]
    fn the_needs_you_gate_caps_an_unverified_adapter_at_working() {
        // A user adapter whose blocked-quiet join was never verified must never
        // reach amber off the tail alone; everything else passes through.
        assert_eq!(gate_tail(TailState::BlockedCandidate, false), TailState::Working);
        assert_eq!(gate_tail(TailState::BlockedCandidate, true), TailState::BlockedCandidate);
        assert_eq!(gate_tail(TailState::Done, false), TailState::Done);
        assert_eq!(gate_tail(TailState::Working, false), TailState::Working);
    }

    #[test]
    fn session_tail_state_fresh_prompt_with_no_reply_yet_is_working() {
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"hello"}}
"#;
        let p = tmp_file("claude_tail_fresh.jsonl", body);
        assert_eq!(session_tail_state_body("no-hook-file-5".into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(), TailState::Working);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_stale_block_yields_to_a_finished_transcript() {
        // A `Notification` hook file that was never overwritten (the user
        // answered, but no later wired event fired) sits over a transcript
        // whose tail has moved on to a final assistant text (Done). The stale
        // block must NOT pin the dot amber: the transcript is the tiebreaker.
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"go"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":[{"type":"text","text":"Done."}]}}
"#;
        let p = tmp_file("claude_stale_block_done.jsonl", body);
        let id = "sess-stale-block-done";
        std::fs::create_dir_all(dirs::home_dir().unwrap().join(".config/tori/hooks-status")).unwrap();
        std::fs::write(
            dirs::home_dir().unwrap().join(format!(".config/tori/hooks-status/{id}.json")),
            r#"{"event":"Notification","at":1}"#,
        )
        .unwrap();

        assert_eq!(
            session_tail_state_body(id.into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(),
            TailState::Done
        );

        std::fs::remove_file(dirs::home_dir().unwrap().join(format!(".config/tori/hooks-status/{id}.json"))).ok();
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn session_tail_state_hook_block_holds_while_transcript_still_pending() {
        // A genuine block: the `Notification` hook agrees with a transcript
        // whose tail is a pending tool call (no result turn after it). The dot
        // must stay BlockedCandidate - the override only downgrades a block the
        // transcript shows is already resolved, never a live one.
        let body = r#"{"type":"user","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"go"}}
{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}
"#;
        let p = tmp_file("claude_live_block_pending.jsonl", body);
        let id = "sess-live-block-pending";
        std::fs::create_dir_all(dirs::home_dir().unwrap().join(".config/tori/hooks-status")).unwrap();
        std::fs::write(
            dirs::home_dir().unwrap().join(format!(".config/tori/hooks-status/{id}.json")),
            r#"{"event":"Notification","at":1}"#,
        )
        .unwrap();

        assert_eq!(
            session_tail_state_body(id.into(), p.to_str().unwrap().to_string(), "claude".into()).unwrap(),
            TailState::BlockedCandidate
        );

        std::fs::remove_file(dirs::home_dir().unwrap().join(format!(".config/tori/hooks-status/{id}.json"))).ok();
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn transcript_turns_are_chronological() {
        // The viewer that paged this list tail-first is gone; every reader left
        // (chat replay, the needs-you tail) takes the whole list and depends on
        // it arriving oldest-first.
        let body = (0..3)
            .map(|i| {
                format!(
                    r#"{{"type":"user","cwd":"/p","timestamp":"2026-07-12T10:00:0{i}.000Z","message":{{"content":"turn {i}"}}}}"#
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let p = tmp_file("cursor.jsonl", &body);

        let turns = transcript_turns(p.to_str().unwrap(), "claude");
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].blocks[0].text.as_deref(), Some("turn 0"));
        assert_eq!(turns[2].blocks[0].text.as_deref(), Some("turn 2"));

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    /// The structured result reaches the summariser, so a replayed call reports
    /// what it did with the same code the live adapter uses.
    ///
    /// Spelled `toolUseResult` on the record and sitting beside the content
    /// rather than inside it, which is the pair of details a reader written
    /// against the stream format would get wrong.
    #[test]
    fn a_tool_result_block_summarises_the_structured_payload() {
        let body = r#"{"type":"assistant","cwd":"/p","timestamp":"2026-08-24T10:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/p/a.txt"}}]}}
{"type":"user","cwd":"/p","timestamp":"2026-08-24T10:00:01.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a\nb"}]},"toolUseResult":{"type":"text","file":{"filePath":"/p/a.txt","content":"a\nb","numLines":2,"startLine":1,"totalLines":9}}}
{"type":"user","cwd":"/p","timestamp":"2026-08-24T10:00:02.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"nested"}]}}
"#;
        let p = tmp_file("tool_result_payload.jsonl", body);
        let turns = transcript_turns(p.to_str().unwrap(), "claude");

        let carried = &turns[1].blocks[0];
        assert_eq!(carried.kind, "tool_result");
        assert_eq!(
            carried.tool_summary,
            Some(crate::chat::model::ToolSummary::Read { lines: 2, from: 1, total: Some(9) }),
            "the payload reached the summariser, `totalLines` included"
        );

        // A call made inside a subagent records no payload at all, and an
        // absent one summarises to nothing rather than to zeroes.
        assert!(turns[2].blocks[0].tool_summary.is_none());

        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    #[test]
    fn prompt_tail_counts_only_genuine_human_text_claude() {
        let body = r#"{"type":"user","cwd":"/p","timestamp":"2026-07-18T10:00:00.000Z","message":{"content":"first prompt"}}
{"type":"assistant","cwd":"/p","timestamp":"2026-07-18T10:00:02.000Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","cwd":"/p","timestamp":"2026-07-18T10:00:03.000Z","isMeta":false,"message":{"content":[{"type":"tool_result","content":"a.txt","is_error":false}]}}
{"type":"user","cwd":"/p","timestamp":"2026-07-18T10:00:04.000Z","message":{"content":"[Context] file:///p/a.txt"}}
{"type":"user","cwd":"/p","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":"second prompt"}}
"#;
        let p = tmp_file("prompt_tail_claude.jsonl", body);
        let tail = session_prompt_tail_body(p.to_str().unwrap().to_string(), "claude".into()).unwrap();
        // A tool_result envelope and a [Context] block are not human prompts.
        assert_eq!(tail.count, 2);
        assert_eq!(tail.last_ts, parse_rfc3339_secs("2026-07-18T10:00:05.000Z").unwrap());
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    /// Archiving is gone, but every overlay file already on disk still carries
    /// its `archived` keys. Serde ignores unknown fields, so the renames beside
    /// them survive untouched; the key itself is pruned by the next write,
    /// because `save_overlay` re-serializes the map from the current struct.
    #[test]
    fn an_overlay_written_before_archiving_was_removed_keeps_its_renames() {
        let on_disk = r#"{
          "sess-a": { "name": "the good one", "archived": true },
          "sess-b": { "name": null, "archived": false },
          "sess-c": { "archived": true }
        }"#;
        let map: HashMap<String, Overlay> = serde_json::from_str(on_disk).unwrap();

        assert_eq!(map["sess-a"].name.as_deref(), Some("the good one"));
        assert_eq!(map["sess-b"].name, None);
        assert_eq!(map["sess-c"].name, None);

        // What the next `set_session_name` would write back: the renames, and
        // no residue of a flag nothing reads any more.
        let round_tripped = serde_json::to_string(&map).unwrap();
        assert!(round_tripped.contains("the good one"));
        assert!(!round_tripped.contains("archived"));
    }

    // --- Incremental transcript tails (phase 6) ---

    /// A transcript long enough that a full parse is the thing worth avoiding,
    /// ending in `tail` so the caller can say what the answer should be.
    fn big_transcript(name: &str, bytes: usize, tail: &str) -> PathBuf {
        let filler = r#"{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:05.000Z","message":{"content":[{"type":"text","text":"PADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPADPAD"}]}}"#;
        let mut body = String::with_capacity(bytes + tail.len());
        while body.len() < bytes {
            body.push_str(filler);
            body.push('\n');
        }
        body.push_str(tail);
        tmp_file(name, &body)
    }

    /// The point of the whole task: reading the end of a big transcript gives
    /// the same answer as parsing all of it, and the warm read is a stat.
    #[test]
    fn a_tail_read_matches_the_full_parse_and_a_warm_one_is_instant() {
        let tail = r#"{"type":"assistant","cwd":"/Users/x/proj","timestamp":"2026-07-18T10:00:08.000Z","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x"}}]}}
"#;
        let p = big_transcript("tail_big.jsonl", 19 * 1024 * 1024, tail);
        let path = p.to_str().unwrap().to_string();

        let full = classify_tail(&parse_transcript_turns(&path, "claude"));
        assert_eq!(cached_tail_state(&path, "claude"), full, "the tail must answer what the whole file does");
        assert_eq!(full, TailState::BlockedCandidate);

        let reads = TAIL_READS.load(std::sync::atomic::Ordering::SeqCst);
        let t = Instant::now();
        for _ in 0..20 {
            assert_eq!(cached_tail_state(&path, "claude"), full);
        }
        let warm = t.elapsed() / 20;
        assert!(warm < Duration::from_millis(5), "warm tail state took {warm:?}, budget is 5ms");
        assert_eq!(
            TAIL_READS.load(std::sync::atomic::Ordering::SeqCst),
            reads,
            "an unchanged transcript must cost a stat, not a read"
        );
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    /// The window is a starting guess, not a limit: a tail made entirely of
    /// lines that yield no turn has to keep widening until it finds one.
    #[test]
    fn the_window_widens_past_a_tail_with_no_turn_in_it() {
        let mut body = String::from(
            r#"{"type":"assistant","cwd":"/x","timestamp":"2026-07-18T10:00:08.000Z","message":{"content":[{"type":"text","text":"the only turn"}]}}
"#,
        );
        // Meta user lines are skipped outright, so none of these is a turn.
        let noise = r#"{"type":"user","isMeta":true,"cwd":"/x","timestamp":"2026-07-18T10:00:09.000Z","message":{"content":"noise"}}"#;
        while body.len() < (TAIL_WINDOW_BYTES as usize) * 3 {
            body.push_str(noise);
            body.push('\n');
        }
        let p = tmp_file("tail_widen.jsonl", &body);
        let path = p.to_str().unwrap().to_string();
        assert_eq!(classify_tail(&tail_turns(&path, "claude")), TailState::Done);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    /// **An ACP session's prompts are read, not counted**, out of the sidecar
    /// the mirror wrote beside its locator. And the gate is the adapter: the
    /// same path handed to a claude-shaped agent reads the file it names as a
    /// transcript and finds no prompts in it, rather than answering one agent's
    /// history out of another agent's store.
    #[test]
    fn an_acp_session_reads_its_prompt_count_out_of_the_sidecar() {
        let locator = tmp_file("acp_tail.json", "{\"id\":\"acp_tail\"}\n");
        std::fs::write(
            locator.with_extension("meta"),
            "{\"prompt_count\":3,\"last_prompt_ts\":1700000000,\"model\":\"gpt-5.6-terra\"}",
        )
        .unwrap();
        let path = locator.to_str().unwrap().to_string();

        let acp = session_prompt_tail_body(path.clone(), "codex".into()).unwrap();
        assert_eq!(acp.count, 3);
        assert_eq!(acp.last_ts, 1_700_000_000);

        let claude = session_prompt_tail_body(path, "claude".into()).unwrap();
        assert_eq!(claude.count, 0, "a claude agent must never read the ACP store's sidecar");
        std::fs::remove_dir_all(locator.parent().unwrap()).ok();
    }

    /// A file that grew since the last call is counted from where the last one
    /// stopped, and the total is the one a full scan would give.
    #[test]
    fn a_prompt_count_resumes_where_the_last_one_stopped() {
        let one = "{\"type\":\"user\",\"cwd\":\"/x\",\"timestamp\":\"2026-07-18T10:00:00.000Z\",\"message\":{\"content\":\"first question\"}}\n";
        let two = "{\"type\":\"user\",\"cwd\":\"/x\",\"timestamp\":\"2026-07-18T10:05:00.000Z\",\"message\":{\"content\":\"second question\"}}\n";
        let p = tmp_file("prompt_grow.jsonl", one);
        let path = p.to_str().unwrap().to_string();

        let first = session_prompt_tail_body(path.clone(), "claude".into()).unwrap();
        assert_eq!(first.count, 1);

        // A distinct mtime, or the stamp would say nothing changed.
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&p, format!("{one}{two}")).unwrap();
        let grown = session_prompt_tail_body(path.clone(), "claude".into()).unwrap();
        assert_eq!(grown.count, 2, "the appended prompt has to be added, not re-counted from zero");
        assert!(grown.last_ts > first.last_ts);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    /// A half-written last line is not counted until its newline arrives, or
    /// the next call would count it a second time.
    #[test]
    fn a_partial_last_line_is_left_for_the_next_call() {
        let whole = "{\"type\":\"user\",\"cwd\":\"/x\",\"timestamp\":\"2026-07-18T10:00:00.000Z\",\"message\":{\"content\":\"first question\"}}\n";
        let partial = "{\"type\":\"user\",\"cwd\":\"/x\",\"timestamp\":\"2026-07-18T10:05:00.000Z\",\"message\":{\"conte";
        let p = tmp_file("prompt_partial.jsonl", &format!("{whole}{partial}"));
        let path = p.to_str().unwrap().to_string();
        assert_eq!(session_prompt_tail_body(path.clone(), "claude".into()).unwrap().count, 1);

        std::thread::sleep(Duration::from_millis(20));
        let rest = "nt\":\"second question\"}}\n";
        std::fs::write(&p, format!("{whole}{partial}{rest}")).unwrap();
        assert_eq!(
            session_prompt_tail_body(path.clone(), "claude".into()).unwrap().count,
            2,
            "the line that completed must be counted exactly once"
        );
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    /// A different transcript written to the same path is not an append. The
    /// head sample is what catches it: the replacement below is *longer* than
    /// what it replaced, so resuming from the old offset would look perfectly
    /// legitimate and would report the old file's count forever.
    #[test]
    fn a_replaced_transcript_is_recounted_rather_than_extended() {
        let prompt = |n: &str, ts: &str| {
            format!("{{\"type\":\"user\",\"cwd\":\"/x\",\"timestamp\":\"{ts}\",\"message\":{{\"content\":\"{n}\"}}}}\n")
        };
        let a = format!(
            "{}{}",
            prompt("aaa question one", "2026-07-18T10:00:00.000Z"),
            prompt("aaa question two", "2026-07-18T10:01:00.000Z")
        );
        let p = tmp_file("prompt_replaced.jsonl", &a);
        let path = p.to_str().unwrap().to_string();
        assert_eq!(session_prompt_tail_body(path.clone(), "claude".into()).unwrap().count, 2);

        // One prompt, but more bytes than the two it replaces, so size says
        // "grew" and only the head says "different file".
        let b = format!(
            "{{\"type\":\"user\",\"cwd\":\"/y\",\"timestamp\":\"2026-07-19T10:00:00.000Z\",\"message\":{{\"content\":\"bbb {}\"}}}}\n",
            "x".repeat(a.len())
        );
        assert!(b.len() > a.len());
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&p, &b).unwrap();
        assert_eq!(
            session_prompt_tail_body(path.clone(), "claude".into()).unwrap().count,
            1,
            "a replacement must be recounted, not appended to the old total"
        );
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }

    // --- sessions://changed fanout (phase 6) ---

    /// Every touched file resolves, so the payload names exactly the folders
    /// that moved and no listener re-lists anything else.
    #[test]
    fn a_burst_within_one_folder_names_only_that_folder() {
        let index = SessionIndex::default();
        let a = PathBuf::from("/roots/proj-a/one.jsonl");
        let b = PathBuf::from("/roots/proj-a/two.jsonl");
        {
            let mut c = index.0.lock().unwrap();
            c.insert(a.clone(), CacheEntry { mtime: SystemTime::UNIX_EPOCH, meta: Some(meta("one", "/Users/x/proj-a", "claude", 1)) });
            c.insert(b.clone(), CacheEntry { mtime: SystemTime::UNIX_EPOCH, meta: Some(meta("two", "/Users/x/proj-a", "claude", 2)) });
        }
        let touched: HashSet<PathBuf> = [a, b].into_iter().collect();
        assert_eq!(folders_for(&index, &touched), Some(vec!["/Users/x/proj-a".to_string()]));
    }

    /// The new-session case. A transcript the index has never parsed has no
    /// cwd to give, and it is the one change that most needs a folder nobody is
    /// listing to appear, so one miss makes the whole answer "refresh all".
    #[test]
    fn an_unindexed_file_falls_back_to_refreshing_everything() {
        let index = SessionIndex::default();
        let known = PathBuf::from("/roots/proj-a/one.jsonl");
        index.0.lock().unwrap().insert(
            known.clone(),
            CacheEntry { mtime: SystemTime::UNIX_EPOCH, meta: Some(meta("one", "/Users/x/proj-a", "claude", 1)) },
        );
        let touched: HashSet<PathBuf> =
            [known, PathBuf::from("/roots/proj-b/brand-new.jsonl")].into_iter().collect();
        assert_eq!(folders_for(&index, &touched), None);
    }

    /// Naming more files than the cap costs more than the refresh it saves.
    #[test]
    fn a_burst_wider_than_the_cap_gives_up_on_naming_folders() {
        let index = SessionIndex::default();
        let mut touched = HashSet::new();
        {
            let mut c = index.0.lock().unwrap();
            for i in 0..(TOUCHED_CAP + 1) {
                let p = PathBuf::from(format!("/roots/proj/{i}.jsonl"));
                c.insert(p.clone(), CacheEntry { mtime: SystemTime::UNIX_EPOCH, meta: Some(meta(&i.to_string(), "/Users/x/proj", "claude", 1)) });
                touched.insert(p);
            }
        }
        assert_eq!(folders_for(&index, &touched), None);
    }

    /// An emit with nothing recorded (the `set_session_name` path, or a burst
    /// whose paths were dropped) must not read as "no folder changed".
    #[test]
    fn an_empty_touched_set_means_all_not_none() {
        assert_eq!(folders_for(&SessionIndex::default(), &HashSet::new()), None);
        assert_eq!(SessionsChanged::all().folders, None);
    }

    /// A session's sidecars sit in a directory named after the transcript's
    /// whole stem, so both stem shapes `transcript_path` accepts have to resolve.
    #[test]
    fn subagent_sidecars_are_found_beside_either_stem_shape() {
        let root = std::env::temp_dir().join("tori-subagents-dir");
        let _ = std::fs::remove_dir_all(&root);
        for stem in ["7f3a", "myproject_7f3a"] {
            std::fs::create_dir_all(root.join(stem).join("subagents")).expect("scratch dir");
            std::fs::write(root.join(format!("{stem}.jsonl")), "").expect("scratch transcript");
            let path = root.join(format!("{stem}.jsonl"));
            assert_eq!(
                subagents_dir(path.to_str().unwrap()),
                Some(root.join(stem).join("subagents")),
                "{stem} resolves to the directory beside it"
            );
        }
        // A session that never launched one, which is nearly all of them. An ACP
        // session never gets this far: `transcript_path` returns `None` first.
        std::fs::write(root.join("bare.jsonl"), "").expect("scratch transcript");
        assert_eq!(subagents_dir(root.join("bare.jsonl").to_str().unwrap()), None);
        assert_eq!(subagents_dir("/nowhere/session"), None, "a path that is not a transcript at all");
    }

    /// The prompt is the one thing `meta.json` does not record, so it is read
    /// off the subagent's own first message and taken out of its rows: nothing
    /// can talk to a subagent, so a user row in its lane could only be this.
    #[test]
    fn a_sidecar_gives_up_its_prompt_and_keeps_its_work() {
        let path = fixture_session("subagent-foreground");
        let subs = subagent_transcripts(&path, "claude");
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].agent_id, "acb01121756a92ca0");
        assert_eq!(subs[0].agent_type, "general-purpose");
        assert_eq!(subs[0].description, "Create sub-made.txt");
        assert_eq!(subs[0].tool_use_id, "toolu_01Ec9PYYDVBe9S6DjXp4RM1s");
        assert_eq!(subs[0].prompt, "Use the Write tool to create sub-made.txt containing the word sub. Then report done.");
        let kinds: Vec<&str> = subs[0].turns.iter().flat_map(|t| t.blocks.iter()).map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, ["tool_call", "tool_result", "text"], "its work, with the prompt taken out");
    }

    /// The CLI files a backgrounded subagent's ending under the user's own role,
    /// as an XML envelope written for the model. `is_human_prompt` already
    /// refused to count it; until this it was still replayed as their message.
    #[test]
    fn a_task_notification_is_an_ending_rather_than_a_prompt() {
        let turns = transcript_turns(&fixture_session("subagent-background"), "claude");
        let notification = turns.iter().find(|t| t.role == "subagent").expect("the ending is its own turn");
        let outcome = notification.blocks[0].subagent.clone().expect("the block carries one");
        assert_eq!(outcome.agent_id, "ad7048d25dc5e778a");
        assert_eq!(outcome.status, "completed");
        assert_eq!(outcome.summary.as_deref(), Some("Agent \"Create bg file\" finished"));
        assert_eq!(outcome.usage.total_tokens, 9551);
        assert_eq!(outcome.usage.tool_uses, 1);
        assert_eq!(outcome.usage.duration_ms, 5886);

        // Nothing left over: the envelope is not also a message.
        let prompts: Vec<&str> = turns
            .iter()
            .filter(|t| t.role == "user")
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| b.text.as_deref())
            .collect();
        assert!(
            prompts.iter().all(|p| !p.contains("<task-notification>")),
            "the envelope reached the conversation as a prompt: {prompts:?}"
        );
    }

    /// The `Agent` call's own result, which is where a foreground run reports
    /// its ending and a backgrounded one reports only its launch.
    #[test]
    fn an_agent_calls_result_carries_the_outcome_beside_the_card() {
        let outcome = |name: &str| {
            transcript_turns(&fixture_session(name), "claude")
                .iter()
                .flat_map(|t| t.blocks.iter())
                .find_map(|b| b.subagent.clone())
                .expect("an outcome")
        };
        let fg = outcome("subagent-foreground");
        assert_eq!(fg.status, "completed");
        assert_eq!(fg.usage.total_tokens, 10429);
        assert_eq!(fg.usage.tool_uses, 1);
        // The same sentence the live `task_notification` puts on the lane. Its
        // wire twin never sends this run's closing report, so without it a
        // reopened foreground lane would carry less than a watched one did.
        assert_eq!(
            fg.summary.as_deref(),
            Some("Done. Created `/Users/dev/proj/sub-made.txt` containing the word `sub`.")
        );
        // Launched, not finished: the call returned before the work did, and
        // the ending arrives later as its own record.
        assert_eq!(outcome("subagent-background").status, "async_launched");
    }

    /// A committed session fixture's path, sidecars and all. Same reason as
    /// [`session_fixture`]: reading `$HOME` would make the result per-machine.
    fn fixture_session(name: &str) -> String {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/sessions")
            .join(format!("{name}.jsonl"))
            .to_string_lossy()
            .into_owned()
    }
}
