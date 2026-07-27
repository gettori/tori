//! Sway-owned, project-scoped allow rules, and the freshness contract that
//! keeps them from outliving their supervisor.
//!
//! **These are never written to `~/.claude/settings.json`.** Writing there would
//! change the behaviour of every terminal session and every other project from a
//! click inside one chat pane, which is not a thing a click in one chat pane
//! should be able to do. Sway enforces its own rules in the bridge before the
//! call ever reaches Claude.
//!
//! The rule file is read by the **hook helper**, a separate short-lived process
//! that runs on every tool call, so two things have to be true at once:
//!
//!   * **It has to be cheap.** The hook matches all tools (Phase 6 promises
//!     approvals hold even under `bypassPermissions`, and the snapshot needs
//!     `Edit`/`Write`/`MultiEdit`), so a turn doing fifty `Read`s must not open
//!     fifty sockets. One file read answers the common case.
//!   * **It must not defeat fail-closed.** A cheap path that only reads a file
//!     would keep auto-approving tools for a `claude` orphaned by a Sway crash,
//!     with nobody supervising it. So the file carries the supervisor's pid and
//!     a refreshed liveness stamp, and a helper that cannot confirm both
//!     **denies**. An allow rule is a statement about what Sway will permit
//!     while Sway is watching, not a standing grant.
//!
//! Per [[lesson_pure_core_for_global_stores]] everything here is a pure function
//! over explicit inputs; the disk and the process table live in `approval.rs`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long a liveness stamp stays credible. Comfortably longer than the
/// refresh interval so ordinary scheduling jitter never denies a live session,
/// and far shorter than a human would take to notice a crashed app.
pub const STAMP_TTL_MS: u64 = 15_000;

/// How often the supervisor refreshes the stamp. A third of the TTL, so two
/// refreshes can be missed before anything is denied.
pub const STAMP_REFRESH_MS: u64 = 5_000;

/// One thing the user has said Sway may run without asking again.
///
/// Deliberately not a regex or a glob. A rule is created by clicking "always
/// allow" on a specific call, and the two questions that produces are "this
/// tool" and "this tool under this path/prefix" - neither needs a pattern
/// language, and a pattern language here would be a way to write a rule whose
/// blast radius the author misjudged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub tool: String,
    /// Matched against the tool's primary argument as a **literal prefix**.
    /// `None` allows every invocation of the tool.
    #[serde(default)]
    pub prefix: Option<String>,
}

/// The on-disk file the helper reads on every tool call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFile {
    /// The Sway that owns these rules. A dead pid means nobody is supervising.
    pub sway_pid: u32,
    /// Unix milliseconds, refreshed by the supervisor. A stale stamp means Sway
    /// is wedged or gone even if something still holds the pid.
    pub stamp_ms: u64,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

/// What the helper should do about one tool call, before any socket is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// A rule matched and the supervisor is alive: allow without prompting.
    Allow,
    /// Fail closed. Carries the reason, which reaches the model as the tool
    /// result and the user as the card's explanation.
    Deny(String),
    /// No rule matched: open the socket and ask.
    Ask,
}

/// The tool argument a rule's prefix is matched against.
///
/// Returns `None` for a tool whose shape we do not know, which makes a
/// prefix rule **unable to match** it rather than matching vacuously. That
/// direction is the safe one: an unknown tool falls through to a prompt.
pub fn primary_arg(tool: &str, input: &Value) -> Option<String> {
    let key = match tool {
        "Bash" | "BashOutput" => "command",
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => "file_path",
        "Glob" | "Grep" => "pattern",
        "WebFetch" => "url",
        "WebSearch" => "query",
        _ => return None,
    };
    input.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Whether a tool's primary argument is a **filesystem path**, and if so the
/// directory it sits in.
///
/// The distinction is load-bearing for project-scoped rules: widening a path to
/// its parent directory is a sensible "anywhere in this project", but widening
/// `Bash`'s command string the same way yields `""`, which matches every command
/// there is. So this answers `None` for anything that is not path-shaped, and
/// the caller falls back to the exact argument rather than guessing.
///
/// `None` for a path with no parent (the filesystem root), for the same reason:
/// a rule covering `/` is not what a click on one file meant.
pub fn path_prefix_for(tool: &str, input: &Value) -> Option<String> {
    let path_shaped = matches!(tool, "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit");
    if !path_shaped {
        return None;
    }
    let arg = primary_arg(tool, input)?;
    let parent = std::path::Path::new(&arg).parent()?.to_string_lossy().into_owned();
    if parent.is_empty() || parent == "/" {
        return None;
    }
    // Trailing separator, so `/proj/src` cannot also match `/proj/srcret`.
    Some(format!("{parent}/"))
}

impl Rule {
    /// Does this rule cover `tool` called with `input`?
    pub fn matches(&self, tool: &str, input: &Value) -> bool {
        if self.tool != tool {
            return false;
        }
        match &self.prefix {
            None => true,
            Some(prefix) => primary_arg(tool, input).is_some_and(|arg| arg.starts_with(prefix.as_str())),
        }
    }
}

/// Is the supervisor that wrote this file still watching?
///
/// Both halves are required. The pid alone is not enough (pids are recycled, and
/// a wedged process still holds its pid), and the stamp alone is not enough (a
/// file written moments before a `SIGKILL` still looks fresh for a few seconds).
pub fn supervisor_ok(file: &RuleFile, now_ms: u64, alive: impl Fn(u32) -> bool) -> bool {
    if !alive(file.sway_pid) {
        return false;
    }
    // `saturating_sub` rather than a signed comparison: a stamp from the future
    // (a clock adjustment) reads as age 0, which is fresh. The alternative,
    // treating it as stale, would deny every tool call after a DST shift.
    now_ms.saturating_sub(file.stamp_ms) <= STAMP_TTL_MS
}

/// The whole cheap-path decision, as a pure function.
///
/// `file` is `None` when there is no rule file at all, or it could not be
/// parsed. That is [`Verdict::Ask`], not [`Verdict::Deny`]: a missing file means
/// nothing has been pre-approved, so the user is asked - which is the safe
/// answer and also the correct one for a brand-new session.
pub fn evaluate(file: Option<&RuleFile>, tool: &str, input: &Value, now_ms: u64, alive: impl Fn(u32) -> bool) -> Verdict {
    let Some(file) = file else { return Verdict::Ask };
    // Checked before matching, not after: a rule must never be honoured by a
    // helper that cannot confirm somebody is supervising it.
    if !supervisor_ok(file, now_ms, alive) {
        return Verdict::Deny(
            "Sway is not supervising this session (its process is gone or unresponsive), so pre-approved tools are denied."
                .to_string(),
        );
    }
    if file.rules.iter().any(|r| r.matches(tool, input)) {
        Verdict::Allow
    } else {
        Verdict::Ask
    }
}

/// Where a session's compiled rules live. One file per session, so revoking a
/// rule in one chat cannot silently widen another.
pub fn rules_path(session_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/chat-rules")
        .join(format!("{}.json", sanitize_id(session_id)))
}

/// Reduce a session id to a bare path segment.
///
/// Claude's ids are UUIDs, so this should never do anything - which is exactly
/// why it is here: the value is concatenated into a path, and a `..` or a `/`
/// arriving from a harness we do not control must not be able to point the rule
/// file somewhere else.
fn sanitize_id(session_id: &str) -> String {
    session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

pub fn parse(text: &str) -> Option<RuleFile> {
    serde_json::from_str(text).ok()
}

pub fn serialize(file: &RuleFile) -> String {
    serde_json::to_string(file).unwrap_or_else(|_| "{}".to_string())
}

pub fn load(path: &Path) -> Option<RuleFile> {
    parse(&std::fs::read_to_string(path).ok()?)
}

pub fn save(path: &Path, file: &RuleFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serialize(file)).map_err(|e| e.to_string())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alive(_: u32) -> bool {
        true
    }
    fn dead(_: u32) -> bool {
        false
    }

    fn file(rules: Vec<Rule>) -> RuleFile {
        RuleFile { sway_pid: 1234, stamp_ms: 1_000_000, rules }
    }

    fn rule(tool: &str, prefix: Option<&str>) -> Rule {
        Rule { tool: tool.to_string(), prefix: prefix.map(str::to_string) }
    }

    #[test]
    fn a_matching_rule_short_circuits_without_ever_prompting() {
        let f = file(vec![rule("Read", None)]);
        assert_eq!(evaluate(Some(&f), "Read", &json!({"file_path": "/a/b.rs"}), 1_000_000, alive), Verdict::Allow);
    }

    #[test]
    fn an_unmatched_tool_asks() {
        let f = file(vec![rule("Read", None)]);
        assert_eq!(evaluate(Some(&f), "Bash", &json!({"command": "rm -rf /"}), 1_000_000, alive), Verdict::Ask);
    }

    /// A prefix rule is a literal prefix on the tool's primary argument, so
    /// "allow Read under this project" cannot leak into a sibling directory.
    #[test]
    fn a_prefix_rule_covers_only_that_prefix() {
        let f = file(vec![rule("Read", Some("/home/me/proj/"))]);
        assert_eq!(evaluate(Some(&f), "Read", &json!({"file_path": "/home/me/proj/src/a.rs"}), 1_000_000, alive), Verdict::Allow);
        assert_eq!(evaluate(Some(&f), "Read", &json!({"file_path": "/home/me/other/a.rs"}), 1_000_000, alive), Verdict::Ask);
    }

    /// A tool whose shape we do not know must not be matched by a prefix rule.
    /// Falling through to a prompt is the safe direction; matching vacuously
    /// would turn "allow Read under /proj" into "allow this unknown tool".
    #[test]
    fn a_prefix_rule_cannot_match_a_tool_with_no_known_primary_argument() {
        assert_eq!(primary_arg("SomeFutureTool", &json!({"whatever": "x"})), None);
        let f = file(vec![rule("SomeFutureTool", Some("/proj"))]);
        assert_eq!(evaluate(Some(&f), "SomeFutureTool", &json!({"whatever": "/proj/x"}), 1_000_000, alive), Verdict::Ask);
    }

    /// A bare tool rule still covers an unknown tool, because it says nothing
    /// about arguments - the user allowed the tool itself.
    #[test]
    fn a_bare_tool_rule_covers_a_tool_with_no_known_argument() {
        let f = file(vec![rule("SomeFutureTool", None)]);
        assert_eq!(evaluate(Some(&f), "SomeFutureTool", &json!({}), 1_000_000, alive), Verdict::Allow);
    }

    /// **The cheap path must not defeat fail-closed.** A rule is a statement
    /// about what Sway will permit while Sway is watching; with the supervisor
    /// gone it is not a standing grant.
    #[test]
    fn a_dead_supervisor_denies_even_an_allow_listed_tool() {
        let f = file(vec![rule("Read", None)]);
        let v = evaluate(Some(&f), "Read", &json!({"file_path": "/a"}), 1_000_000, dead);
        match v {
            Verdict::Deny(reason) => assert!(reason.contains("not supervising"), "got {reason}"),
            other => panic!("expected a deny, got {other:?}"),
        }
    }

    /// A live pid is not enough on its own: a wedged Sway still holds one.
    #[test]
    fn a_stale_stamp_denies_even_with_a_live_pid() {
        let f = file(vec![rule("Read", None)]);
        let later = 1_000_000 + STAMP_TTL_MS + 1;
        assert!(matches!(evaluate(Some(&f), "Read", &json!({"file_path": "/a"}), later, alive), Verdict::Deny(_)));
        // One millisecond inside the window is still fresh.
        let just_ok = 1_000_000 + STAMP_TTL_MS;
        assert_eq!(evaluate(Some(&f), "Read", &json!({"file_path": "/a"}), just_ok, alive), Verdict::Allow);
    }

    /// A clock that jumps backwards must not deny every tool call. The stamp
    /// reads as age zero rather than as an enormous negative age.
    #[test]
    fn a_stamp_from_the_future_reads_as_fresh_rather_than_stale() {
        let f = file(vec![rule("Read", None)]);
        assert_eq!(evaluate(Some(&f), "Read", &json!({"file_path": "/a"}), 1, alive), Verdict::Allow);
    }

    /// Missing and invalid both mean "nothing pre-approved", so the user is
    /// asked. Denying here would make a brand-new session unable to do anything.
    #[test]
    fn a_missing_or_invalid_rule_file_asks_rather_than_denying() {
        assert_eq!(evaluate(None, "Read", &json!({}), 1_000_000, alive), Verdict::Ask);
        assert!(parse("").is_none());
        assert!(parse("{ not json").is_none());
        assert!(parse(r#"{"swayPid": 1}"#).is_none(), "a file missing stampMs is not a usable rule file");
    }

    #[test]
    fn rules_round_trip_through_the_on_disk_shape() {
        let f = file(vec![rule("Read", None), rule("Bash", Some("git status"))]);
        assert_eq!(parse(&serialize(&f)), Some(f));
    }

    #[test]
    fn write_read_back_and_removal_all_work_off_disk() {
        let dir = std::env::temp_dir().join(format!("sway-rules-{}", std::process::id()));
        let path = dir.join("s.json");
        let _ = std::fs::remove_dir_all(&dir);

        let f = file(vec![rule("Read", None)]);
        save(&path, &f).unwrap();
        assert_eq!(load(&path), Some(f));

        std::fs::remove_file(&path).unwrap();
        assert_eq!(load(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A partial file (rules omitted) is usable and simply grants nothing.
    #[test]
    fn a_file_with_no_rules_is_valid_and_grants_nothing() {
        let parsed = parse(r#"{"swayPid": 5, "stampMs": 10}"#).expect("rules should default to empty");
        assert!(parsed.rules.is_empty());
        assert_eq!(evaluate(Some(&parsed), "Read", &json!({}), 10, alive), Verdict::Ask);
    }

    /// The session id is concatenated into a path. Claude's are UUIDs, so this
    /// should never fire - which is why it is tested rather than assumed.
    #[test]
    fn a_session_id_cannot_escape_the_rules_directory() {
        let path = rules_path("../../.claude/settings");
        assert!(!path.to_string_lossy().contains(".."), "got {}", path.display());
        assert_eq!(path.parent(), rules_path("normal-id").parent());
    }

    /// **A project-scoped rule must not become "allow everything".**
    ///
    /// Widening a path to its parent directory is a sensible "anywhere in this
    /// project". Widening `Bash`'s primary argument the same way is not: it is
    /// the *command string*, and `Path::parent("git status")` is `""`, which
    /// every string starts with. One click on "always allow in this project"
    /// would have allowed every shell command the session ever ran.
    #[test]
    fn only_a_path_shaped_argument_can_be_widened_to_a_directory() {
        assert_eq!(path_prefix_for("Read", &json!({"file_path": "/proj/src/a.rs"})), Some("/proj/src/".to_string()));
        assert_eq!(path_prefix_for("Edit", &json!({"file_path": "/proj/a.rs"})), Some("/proj/".to_string()));

        // The escalation this guards against.
        assert_eq!(path_prefix_for("Bash", &json!({"command": "git status"})), None);
        assert_eq!(path_prefix_for("WebFetch", &json!({"url": "https://example.com"})), None);
        assert_eq!(path_prefix_for("Grep", &json!({"pattern": "fn main"})), None);
    }

    /// An empty prefix would match every argument, so it must never be produced.
    #[test]
    fn a_root_level_path_is_never_widened_to_a_rule_covering_everything() {
        assert_eq!(path_prefix_for("Read", &json!({"file_path": "/a.rs"})), None);
        assert_eq!(path_prefix_for("Read", &json!({"file_path": "a.rs"})), None);
    }

    /// The widened prefix keeps its trailing separator, so a rule for
    /// `/proj/src` cannot also cover a sibling whose name merely starts the same.
    #[test]
    fn a_widened_directory_prefix_cannot_leak_into_a_sibling() {
        let dir = path_prefix_for("Read", &json!({"file_path": "/proj/src/a.rs"})).unwrap();
        let rule = Rule { tool: "Read".into(), prefix: Some(dir) };
        assert!(rule.matches("Read", &json!({"file_path": "/proj/src/deep/b.rs"})));
        assert!(!rule.matches("Read", &json!({"file_path": "/proj/srcret/b.rs"})), "a name that merely starts the same must not match");
    }

    /// If an empty prefix ever did reach a rule, it would match everything -
    /// documented here so the guard above is visibly load-bearing rather than
    /// looking like defensive noise.
    #[test]
    fn an_empty_prefix_would_match_everything_which_is_why_one_is_never_written() {
        let dangerous = Rule { tool: "Bash".into(), prefix: Some(String::new()) };
        assert!(dangerous.matches("Bash", &json!({"command": "rm -rf /"})));
    }

    /// The refresh interval has to leave room for a missed tick, or ordinary
    /// scheduling jitter would deny a live session's tool calls.
    #[test]
    fn the_refresh_interval_leaves_room_for_a_missed_tick() {
        assert!(STAMP_REFRESH_MS * 2 < STAMP_TTL_MS, "two missed refreshes must still be inside the TTL");
    }
}
