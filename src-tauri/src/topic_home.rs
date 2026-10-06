// A Topic's home folder: where its chats run, so one session reaches every
// member through `--add-dir` instead of living inside one member's worktree.
// Tori owns the folder; `TOPIC.md` is regenerated from the record on every
// write, so a hand edit there does not survive.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::topics::{member_root, Member, MemberMode, MemberState, Promotion, Topic};

pub const NOTE: &str = "TOPIC.md";

/// The MCP name of `topic.member.promote`, which the rules and a refused write
/// point a chat at.
pub const PROMOTE_TOOL: &str = "mcp__tori__topic_member_promote";

/// Beside the record, so a store in a temp dir gets its homes there too.
pub fn home_dir(store_path: &Path, topic_id: &str) -> PathBuf {
    store_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("topics")
        .join(topic_id)
}

/// Bring every Topic's note up to date. Best effort: a note that cannot be
/// written leaves the record saved, and the next write tries again.
pub fn sync(store_path: &Path, topics: &[Topic]) {
    for topic in topics {
        let dir = home_dir(store_path, &topic.id);
        let text = topic_md(topic);
        let path = dir.join(NOTE);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = crate::owned_state::write_atomically(&path, &text);
        }
    }
}

pub fn remove(store_path: &Path, topic_id: &str) {
    let _ = std::fs::remove_dir_all(home_dir(store_path, topic_id));
}

/// A member's own Claude project config, as far as a chat running elsewhere
/// can use it: the permission rules carry over, anchored to the member's root;
/// hooks and project MCP servers are tied to their folder and do not.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MemberConfig {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub ask: Vec<String>,
    pub hooks: bool,
    pub mcp_servers: Vec<String>,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

pub fn member_config(root: &Path) -> MemberConfig {
    let mut out = MemberConfig::default();
    for file in ["settings.json", "settings.local.json"] {
        let Some(json) = read_json(&root.join(".claude").join(file)) else {
            continue;
        };
        for (key, into) in [
            ("allow", &mut out.allow),
            ("deny", &mut out.deny),
            ("ask", &mut out.ask),
        ] {
            let rules = json.pointer(&format!("/permissions/{key}")).and_then(Value::as_array);
            for rule in rules.into_iter().flatten().filter_map(Value::as_str) {
                let anchored = anchor(rule, root);
                if !into.contains(&anchored) {
                    into.push(anchored);
                }
            }
        }
        if json
            .get("hooks")
            .and_then(Value::as_object)
            .is_some_and(|h| !h.is_empty())
        {
            out.hooks = true;
        }
    }
    if let Some(servers) = read_json(&root.join(".mcp.json")).and_then(|j| j.get("mcpServers").cloned()) {
        out.mcp_servers = servers
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
    }
    out
}

const PATH_TOOLS: &[&str] = &["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep"];
const WRITE_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// A path rule written for the member's own folder, rewritten to name that
/// folder absolutely (`//abs`). Left relative it would resolve against the home
/// folder, where a deny guarding `./.env` protects nothing.
pub fn anchor(rule: &str, root: &Path) -> String {
    let Some((tool, rest)) = rule.split_once('(') else {
        return rule.to_string();
    };
    let Some(spec) = rest.strip_suffix(')') else {
        return rule.to_string();
    };
    if !PATH_TOOLS.contains(&tool) || spec.starts_with("//") || spec.starts_with('~') {
        return rule.to_string();
    }
    let rel = spec.trim_start_matches("./").trim_start_matches('/');
    let base = root.to_string_lossy();
    format!("{tool}(//{}/{rel})", base.trim_start_matches('/').trim_end_matches('/'))
}

fn mode_word(m: &Member) -> &'static str {
    match m.mode {
        MemberMode::Reference => "reference, read only",
        MemberMode::Worktree => "worktree",
    }
}

fn state_word(state: &MemberState) -> Option<String> {
    match state {
        MemberState::Present => None,
        MemberState::WorktreeMissing => Some("worktree missing".into()),
        MemberState::RepoMissing => Some("repository unavailable".into()),
        MemberState::CheckoutMissing => Some("no default branch checkout".into()),
        MemberState::Failed { reason } => Some(format!("failed: {reason}")),
    }
}

pub fn topic_md(topic: &Topic) -> String {
    format!(
        "# {}\n\nTori writes this file from the Topic record and rewrites it on every change. Edits here are lost.\n\n{}",
        topic.name,
        body(topic)
    )
}

/// What a chat in the Topic's home is told about it, at its start and after
/// every change: the same facts `TOPIC.md` holds.
pub fn note(topic: &Topic) -> String {
    format!(
        "# {}\n\nThis chat runs in the home folder of the Topic {}, which spans the members below.\n\n{}",
        topic.name,
        topic.name,
        body(topic)
    )
}

fn body(topic: &Topic) -> String {
    let mut members: Vec<&Member> = topic.members.iter().collect();
    members.sort_by_key(|m| m.order);
    let mut out = format!("Branch: `{}`\n\n## Members\n\n", topic.branch);
    let mut unavailable = Vec::new();
    for m in &members {
        let path = member_root(m).unwrap_or(&m.repo_path);
        out.push_str(&format!("- {} ({}): `{}`", m.display_name, mode_word(m), path));
        if let Some(s) = state_word(&m.state) {
            out.push_str(&format!(", {s}"));
        }
        out.push('\n');
        if let Some(root) = member_root(m) {
            let cfg = member_config(Path::new(root));
            let mut gone = Vec::new();
            if cfg.hooks {
                gone.push("project hooks".to_string());
            }
            if !cfg.mcp_servers.is_empty() {
                gone.push(format!(
                    "MCP servers {}",
                    cfg.mcp_servers
                        .iter()
                        .map(|s| format!("`{s}`"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if !gone.is_empty() {
                unavailable.push(format!("- {}: {}", m.display_name, gone.join(", ")));
            }
        }
    }
    let promote = match topic.promotion {
        Promotion::Ask => {
            format!("To change one, call `{PROMOTE_TOOL}` with its name; the user is asked to create its worktree.")
        }
        Promotion::Auto => {
            format!("To change one, call `{PROMOTE_TOOL}` with its name; its worktree is created at once.")
        }
        Promotion::Never => "This Topic does not let a chat create worktrees. Ask the user to create one.".to_string(),
    };
    out.push_str(&format!(
        "\n## Rules\n\n- A reference member is the repository's own checkout. Read it, never change it. {promote}\n- Change a worktree member only inside the path listed above.\n"
    ));
    if !unavailable.is_empty() {
        out.push_str("\n## Not available in this chat\n\nProject hooks and project MCP servers belong to their own folder and do not run here.\n\n");
        out.push_str(&unavailable.join("\n"));
        out.push('\n');
    }
    out
}

/// What a chat started in a Topic home needs beyond its cwd.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct HomeLaunch {
    pub roots: Vec<String>,
    pub note: String,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub ask: Vec<String>,
}

/// The Topic whose home `cwd` is, as the launch sees it: every present
/// member's root, and their permission rules together.
pub fn launch_for(store: &crate::topics::Store, cwd: &str) -> Option<HomeLaunch> {
    // Checked before the listing, which reconciles every member against git:
    // most chats are not in a home, and they should not pay for it.
    let homes = crate::platform::fs::canonical(store.path().parent()?.join("topics")).ok()?;
    let target = crate::platform::fs::canonical(cwd).ok()?;
    if target.parent() != Some(homes.as_path()) {
        return None;
    }
    let topic = crate::topics::list_topics(store).into_iter().find(|t| {
        crate::platform::fs::canonical(home_dir(store.path(), &t.id))
            .ok()
            .as_ref()
            == Some(&target)
    })?;
    let mut out = HomeLaunch {
        note: crate::rpc::events::from_tori("topic", None, &note(&topic)),
        ..Default::default()
    };
    let mut members: Vec<&Member> = topic.members.iter().collect();
    members.sort_by_key(|m| m.order);
    for m in members {
        let Some(root) = member_root(m) else { continue };
        out.roots.push(root.to_string());
        let mut cfg = member_config(Path::new(root));
        // A reference is read only: its own rules may not open it to writes.
        if m.mode == MemberMode::Reference {
            cfg.allow.retain(|rule| {
                !WRITE_TOOLS
                    .iter()
                    .any(|t| rule == t || rule.starts_with(&format!("{t}(")))
            });
        }
        for (from, into) in [
            (cfg.allow, &mut out.allow),
            (cfg.deny, &mut out.deny),
            (cfg.ask, &mut out.ask),
        ] {
            for rule in from {
                if !into.contains(&rule) {
                    into.push(rule);
                }
            }
        }
    }
    Some(out)
}

/// The Topic whose home, or `topic:<id>` workspace key, `at` is. Never a
/// member's own folder, which a chat started there has to itself.
pub fn topic_at_home<'a>(topics: &'a [Topic], at: &str) -> Option<&'a Topic> {
    if let Some(id) = at.strip_prefix(crate::unit_home::TOPIC_KEY) {
        return topics.iter().find(|t| t.id == id);
    }
    let at = at.trim_end_matches('/');
    topics
        .iter()
        .find(|t| t.home.as_deref().is_some_and(|h| h.trim_end_matches('/') == at))
}

/// Why a chat running for a Topic may not write `target`, or `None` when it
/// may. Its own worktrees are open; the rest of every member's repository,
/// the user's checkout and other Topics' worktrees included, is not. Outside
/// every member Tori has no say.
pub fn write_refusal(topics: &[Topic], cwd: &str, target: &str) -> Option<String> {
    use crate::sessions::cwd_matches;
    let topic = crate::unit_home::topic_of(topics, cwd)?;
    let path = lexical(&Path::new(cwd).join(target));
    let own = |m: &&Member| {
        m.mode == MemberMode::Worktree && m.worktree_path.as_deref().is_some_and(|w| cwd_matches(&path, w))
    };
    if topic.members.iter().any(|m| own(&m)) {
        return None;
    }
    let under = |m: &&Member| {
        cwd_matches(&path, &m.repo_path) || m.checkout.as_ref().is_some_and(|c| cwd_matches(&path, &c.path))
    };
    let m = topic.members.iter().find(under)?;
    Some(match (m.mode, m.worktree_path.as_deref()) {
        (MemberMode::Worktree, Some(w)) => format!(
            "{} has a worktree for the Topic {} at {w}. Make this change there, not in {}.",
            m.display_name, topic.name, m.repo_path
        ),
        _ if topic.promotion == Promotion::Never => format!(
            "{} is a reference in the Topic {}, so it is read only here, and this Topic does not let a chat create worktrees. Ask the user to create one.",
            m.display_name, topic.name
        ),
        _ => format!(
            "{} is a reference in the Topic {}, so it is read only here. Call {PROMOTE_TOOL} with member \"{}\" to get a worktree, then make the change there.",
            m.display_name, topic.name, m.display_name
        ),
    })
}

// `..` resolved without touching the disk, so a path climbing out of a
// worktree is judged where it lands.
fn lexical(path: &Path) -> String {
    use std::path::Component;
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out.to_string_lossy().into_owned()
}

/// The roots a live chat in this Topic's home has not been given yet.
pub fn roots_of(topic: &Topic) -> Vec<String> {
    let mut members: Vec<&Member> = topic.members.iter().collect();
    members.sort_by_key(|m| m.order);
    members
        .into_iter()
        .filter_map(|m| member_root(m).map(str::to_string))
        .collect()
}

/// What a home chat was last told, taken before a change so the change can be
/// measured against it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Told {
    pub roots: Vec<String>,
    pub note: String,
}

pub fn told(topic: &Topic) -> Told {
    Told {
        roots: roots_of(topic),
        note: note(topic),
    }
}

/// After the Topic changed in a way its note shows: every live chat running in
/// its home gets any new root granted, then the whole note again. Told even
/// when the grant fails, since the note states what is read only rather than
/// promising access.
pub fn tell_home_chats(
    before: &Told,
    topic: &Topic,
    live: &[(String, String)],
    grant: impl Fn(&str, &[String]) -> Result<(), String>,
    tell: impl Fn(&str, &str) -> Result<(), String>,
) {
    let Some(home) = topic.home.as_deref() else { return };
    let now = note(topic);
    if now == before.note {
        return;
    }
    let added: Vec<String> = roots_of(topic)
        .into_iter()
        .filter(|r| !before.roots.contains(r))
        .collect();
    let text = format!("The Topic {} changed. This is how it stands now.\n\n{now}", topic.name);
    let home = crate::platform::fs::canonical(home).unwrap_or_else(|_| PathBuf::from(home));
    for (session, cwd) in live {
        if crate::platform::fs::canonical(cwd).unwrap_or_else(|_| PathBuf::from(cwd)) != home {
            continue;
        }
        if !added.is_empty() {
            let _ = grant(session, &added);
        }
        let _ = tell(session, &text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_path_rule_is_anchored_to_the_member_and_every_other_rule_is_kept() {
        let root = Path::new("/w/api");
        assert_eq!(anchor("Read(./.env)", root), "Read(//w/api/.env)");
        assert_eq!(anchor("Edit(src/**)", root), "Edit(//w/api/src/**)");
        assert_eq!(anchor("Edit(/docs/*.md)", root), "Edit(//w/api/docs/*.md)");
        assert_eq!(anchor("Read(//etc/hosts)", root), "Read(//etc/hosts)");
        assert_eq!(anchor("Read(~/.ssh/**)", root), "Read(~/.ssh/**)");
        assert_eq!(anchor("Bash(npm run test:*)", root), "Bash(npm run test:*)");
        assert_eq!(anchor("WebFetch", root), "WebFetch");
    }

    #[test]
    fn a_topic_chat_writes_only_inside_its_own_worktrees() {
        let mut topic = crate::unit_home::tests::topic();
        topic.members[0].display_name = "api".into();
        topic.members[1].display_name = "web".into();
        let topics = [topic];
        let home = "/cfg/topics/auth-1";
        let refused = |target: &str| write_refusal(&topics, home, target);

        let reference = refused("/p/web/src/app.ts").expect("a reference root is refused");
        assert!(
            reference.contains(PROMOTE_TOOL) && reference.contains("\"web\""),
            "{reference}"
        );
        let promoted = refused("/p/api/src/lib.rs").expect("a promoted member's own checkout is refused");
        assert!(promoted.contains("/p/api/.tori/worktrees/auth"), "{promoted}");
        assert_eq!(refused("/p/api/.tori/worktrees/auth/src/lib.rs"), None);
        assert!(
            refused("/p/api/.tori/worktrees/auth/../../../../web/x.ts").is_some(),
            "climbing out of the worktree lands in web"
        );
        assert!(
            refused("/p/api/.tori/worktrees/other/x.rs").is_some(),
            "another Topic's worktree is not this chat's"
        );
        assert_eq!(refused("TOPIC.md"), None);
        assert_eq!(refused("/tmp/scratch.txt"), None);
        assert_eq!(write_refusal(&topics, "/elsewhere", "/p/web/src/app.ts"), None);
    }
}
