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

/// The rule-file format this build writes, and the only one it will act on.
///
/// **A version a build does not recognise is a denial, not a shrug.** Serde
/// ignores unknown fields by default, so without this an older Sway handed a
/// newer file would read the fields it knew and drop the rest - and since a
/// restrictive rule is expressed by a field (`kind`), dropping it turns a `deny`
/// into an `allow`. Silently inverting a restriction is the worst failure this
/// module has, so the version is checked before any rule is looked at.
pub const FORMAT_VERSION: u32 = 2;

/// What a rule does when it matches.
///
/// Restrictions exist because "allow" alone cannot express the two things people
/// actually want from a project: *never* do this, and *always ask* about this.
/// Both are stronger than a grant, which is why [`evaluate`] resolves them in
/// that order rather than by file position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleKind {
    /// Run it without prompting. The only kind v1 could express, so it is also
    /// what a rule carried over from a v1 project file becomes.
    #[default]
    Allow,
    /// Prompt every time, even if another rule would have allowed it.
    Ask,
    /// Refuse, with the reason reaching the model as the tool result.
    Deny,
}

/// Where a rule came from, so the rule list can say why it exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleOrigin {
    /// The user wrote it, or clicked "always allow" on a specific call.
    #[default]
    Manual,
    /// Sway offered it after the same call had been approved by hand enough
    /// times, and the user accepted. Recorded so a rule nobody remembers
    /// writing can be explained rather than merely listed.
    Learned,
}

/// One thing the user has said about a tool call.
///
/// **Patterns are restricted to restrictions.** A rule was originally created
/// only by clicking "always allow" on a specific call, and this module refused a
/// pattern language on the grounds that it is a way to write a rule whose blast
/// radius the author misjudged. That reasoning holds for a *grant* and inverts
/// for a *restriction*: misjudging the radius of `ask` or `deny` means more
/// prompting, never more permission. So `glob` is honoured for `Ask` and `Deny`
/// and ignored for `Allow` - enforced in [`Rule::matches`], not just at the
/// write path, so a hand-edited file cannot widen a grant either.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub tool: String,
    /// Matched against the tool's primary argument as a **literal prefix**.
    /// `None` covers every invocation of the tool.
    #[serde(default)]
    pub prefix: Option<String>,
    /// Matched against the tool's primary argument as a path glob (`?`, `*`
    /// within a segment, `**` across them). Restrictive kinds only.
    #[serde(default)]
    pub glob: Option<String>,
    #[serde(default)]
    pub kind: RuleKind,
    #[serde(default)]
    pub origin: RuleOrigin,
}

/// The on-disk file the helper reads on every tool call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleFile {
    /// Which format this file is in. See [`FORMAT_VERSION`].
    pub format_version: u32,
    /// The Sway that owns these rules. A dead pid means nobody is supervising.
    ///
    /// **The wire name is deliberately not `swayPid`.** v1 had no version field,
    /// so nothing in a v1 parser could have noticed a v2 file; renaming a key it
    /// requires and cannot default is what makes such a file fail to parse there
    /// instead of being half-read. Keeping the Rust name means no call site
    /// changed for the sake of the rename. See `rules_v1_frozen`.
    #[serde(rename = "supervisorPid")]
    pub sway_pid: u32,
    /// Unix milliseconds, refreshed by the supervisor. A stale stamp means Sway
    /// is wedged or gone even if something still holds the pid.
    pub stamp_ms: u64,
    /// The retired spend stop, read so that a file written before the ceiling
    /// moved to the turn boundary still parses, and never written again.
    ///
    /// It cannot simply be deleted: this struct is `deny_unknown_fields`, which
    /// is what makes a v1 file fail loudly rather than half-read, and that same
    /// strictness would turn every session file left on disk by a previous build
    /// into `Parsed::Unreadable` - which the helper treats as "written by a Sway
    /// I do not know" and answers by denying every call. `skip_serializing` is
    /// what actually retires the key: the next save writes it out of existence.
    #[serde(rename = "stop", default, skip_serializing)]
    pub legacy_stop: Option<String>,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

impl RuleFile {
    /// A file in this build's format. Used everywhere a `RuleFile` is built, so
    /// the version is never spelled out by hand at a call site.
    pub fn new(sway_pid: u32, stamp_ms: u64, rules: Vec<Rule>) -> Self {
        Self { format_version: FORMAT_VERSION, sway_pid, stamp_ms, legacy_stop: None, rules }
    }
}

/// What reading a rule file produced.
///
/// Three outcomes, not two, because "I cannot read this" and "this was written
/// by a Sway I do not know" call for opposite answers: the first is a
/// brand-new or corrupt file and means *ask*, the second means a rule set exists
/// that this build cannot be trusted to interpret, and means *deny*.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Ok(RuleFile),
    /// A format version this build does not know, carried for the message.
    UnknownVersion(u32),
    /// No file, or one that does not parse at all.
    Unreadable,
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

/// Match a path against a glob: `?` for one character, `*` for any run within a
/// segment, `**` for any run of whole segments (including none).
///
/// Segment-first, so `*` genuinely cannot cross a `/`. That is the property that
/// makes `src/*` a statement about one directory rather than a subtree, and it
/// is why this is not just a regex translation.
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let pat: Vec<&str> = pattern.split('/').collect();
    let seg: Vec<&str> = path.split('/').collect();
    segments_match(&pat, &seg)
}

fn segments_match(pat: &[&str], seg: &[&str]) -> bool {
    match pat.first() {
        None => seg.is_empty(),
        // Zero or more whole segments. Bounded by path depth, so the branching
        // cannot run away on any real path.
        Some(&"**") => (0..=seg.len()).any(|skip| segments_match(&pat[1..], &seg[skip..])),
        Some(p) => match seg.first() {
            Some(s) if segment_matches(p, s) => segments_match(&pat[1..], &seg[1..]),
            _ => false,
        },
    }
}

/// `?` and `*` within a single path segment, matched as a table rather than by
/// backtracking so a pathological pattern cannot blow up.
fn segment_matches(pat: &str, text: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let mut reach = vec![vec![false; t.len() + 1]; p.len() + 1];
    reach[0][0] = true;
    for i in 1..=p.len() {
        reach[i][0] = reach[i - 1][0] && p[i - 1] == '*';
    }
    for i in 1..=p.len() {
        for j in 1..=t.len() {
            reach[i][j] = match p[i - 1] {
                '*' => reach[i - 1][j] || reach[i][j - 1],
                '?' => reach[i - 1][j - 1],
                c => reach[i - 1][j - 1] && c == t[j - 1],
            };
        }
    }
    reach[p.len()][t.len()]
}

impl Rule {
    /// A plain "allow this tool, optionally under this prefix" rule. What every
    /// rule was before v2, and still what almost every rule is.
    pub fn allow(tool: &str, prefix: Option<&str>) -> Self {
        Self {
            tool: tool.to_string(),
            prefix: prefix.map(str::to_string),
            glob: None,
            kind: RuleKind::Allow,
            origin: RuleOrigin::Manual,
        }
    }

    /// Are these the same rule, in the sense that keeping both would be keeping
    /// a duplicate?
    ///
    /// `origin` is provenance, not identity. Comparing it too would let the same
    /// restriction exist twice - once accepted from an offer, once typed by hand
    /// - and revoking the one on screen would silently leave the other in force.
    pub fn same_scope(&self, other: &Rule) -> bool {
        self.tool == other.tool && self.prefix == other.prefix && self.glob == other.glob && self.kind == other.kind
    }

    /// Does this rule cover `tool` called with `input`?
    ///
    /// Every condition the rule states must hold. A rule stating none covers
    /// every invocation of the tool, which is what a bare "always allow Read"
    /// has always meant.
    pub fn matches(&self, tool: &str, input: &Value) -> bool {
        if self.tool != tool {
            return false;
        }
        // A glob on a grant is ignored, so a file that somehow carries one
        // cannot widen what is permitted. See the note on [`Rule`].
        if self.kind == RuleKind::Allow && self.glob.is_some() {
            return false;
        }
        let arg = primary_arg(tool, input);
        if let Some(prefix) = &self.prefix {
            if !arg.as_deref().is_some_and(|a| a.starts_with(prefix.as_str())) {
                return false;
            }
        }
        if let Some(glob) = &self.glob {
            if !arg.as_deref().is_some_and(|a| glob_matches(glob, a)) {
                return false;
            }
        }
        true
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
/// [`Parsed::Unreadable`] is [`Verdict::Ask`], not [`Verdict::Deny`]: a missing
/// file means nothing has been pre-approved, so the user is asked - the safe
/// answer, and the correct one for a brand-new session.
///
/// [`Parsed::UnknownVersion`] is a denial, and it is the reason this function
/// takes the parse outcome rather than an `Option`. A file it cannot interpret
/// is not an absent file: somebody wrote rules that this build might be reading
/// with the wrong meaning, and the only honest response is to stop.
///
/// **Resolution order is by kind, not by position.** Deny beats ask beats
/// allow, so a restriction cannot be undone by an allow rule that happens to sit
/// after it. Position-ordered resolution would make the safety of a rule set
/// depend on the order clicks happened to land in.
pub fn evaluate(parsed: &Parsed, tool: &str, input: &Value, now_ms: u64, alive: impl Fn(u32) -> bool) -> Verdict {
    let file = match parsed {
        Parsed::Unreadable => return Verdict::Ask,
        Parsed::UnknownVersion(v) => {
            return Verdict::Deny(format!(
                "This session's rule file is in format v{v}, which this version of Sway does not understand, so none of its rules are being applied."
            ))
        }
        Parsed::Ok(file) => file,
    };
    // Checked before matching, not after, and ahead of every kind: no rule of
    // any kind may be honoured by a helper that cannot confirm somebody is
    // supervising it. A `deny` rule surviving here would be harmless, but
    // treating the kinds differently is how the contract starts to erode.
    if !supervisor_ok(file, now_ms, alive) {
        return Verdict::Deny(
            "Sway is not supervising this session (its process is gone or unresponsive), so pre-approved tools are denied."
                .to_string(),
        );
    }
    // No spend ceiling here any more. It used to outrank every rule from this
    // file, because Sway's hook saw every tool call and could refuse one; the
    // hook no longer decides, so the ceiling moved to the turn boundary, where
    // Sway still has the last word (`utils/chatBudget.ts`).
    let mut strongest = None;
    for rule in file.rules.iter().filter(|r| r.matches(tool, input)) {
        match rule.kind {
            RuleKind::Deny => {
                return Verdict::Deny(format!(
                    "A Sway rule for this project refuses {tool} here. Remove the rule from the chat's rule list to allow it."
                ))
            }
            RuleKind::Ask => strongest = Some(RuleKind::Ask),
            RuleKind::Allow => {
                if strongest.is_none() {
                    strongest = Some(RuleKind::Allow)
                }
            }
        }
    }
    match strongest {
        Some(RuleKind::Allow) => Verdict::Allow,
        // An `ask` rule and no match both end at the prompt. They are not the
        // same thing though: `ask` got there by overriding an allow.
        _ => Verdict::Ask,
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

/// Rules the user asked to keep for a **project**, which have to outlive the
/// chat that created them.
///
/// The session file above is a compiled artefact: the helper reads it on every
/// call and it is deleted at teardown. "Always allow in this project" written
/// only there would silently expire when the tab closed, so the durable copy
/// lives here, keyed by working directory, and is compiled into each new
/// session's file at spawn. Still Sway-owned and still never
/// `~/.claude/settings.json`.
/// Unlike the session file, this one is **not** version-gated into a denial.
///
/// It is durable user intent, not a compiled artefact, and every v1 project rule
/// was an allow rule, so reading one as `kind: Allow` is exact rather than a
/// guess - `RuleKind`'s default is what performs the upgrade, and the file is
/// rewritten in the current format the next time it is touched. Refusing to read
/// it would throw away rules the user really did write, to guard against a
/// misreading that cannot happen in this direction.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuleFile {
    /// 0 for a file written before project rules were versioned.
    #[serde(default)]
    pub format_version: u32,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

/// Where a project's durable rules live.
///
/// The directory name carries a readable basename plus a hash of the full path,
/// because two checkouts of one repo are two projects and must not share a rule
/// set, while a path used verbatim would blow past the filename length cap.
pub fn project_rules_path(cwd: &str) -> PathBuf {
    let base = Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway/chat-rules/projects")
        .join(format!("{}-{:016x}.json", sanitize_id(&base), path_hash(cwd)))
}

/// FNV-1a over the path bytes. Not cryptographic and does not need to be: it
/// only has to separate two directories that share a basename.
fn path_hash(cwd: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in cwd.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// The session file a fresh chat starts with: the project's durable rules,
/// stamped by the supervisor that is about to watch them.
///
/// Pure so the compile order is assertable off-disk. `existing` is carried
/// through rather than replaced, because a resumed session id may already have a
/// file and dropping its session-scoped rules would silently re-prompt for
/// things the user had allowed.
pub fn compiled(project: &ProjectRuleFile, existing: Option<&RuleFile>, sway_pid: u32, stamp_ms: u64) -> RuleFile {
    let mut rules = existing.map(|f| f.rules.clone()).unwrap_or_default();
    for rule in &project.rules {
        if !rules.iter().any(|r| r.same_scope(rule)) {
            rules.push(rule.clone());
        }
    }
    RuleFile::new(sway_pid, stamp_ms, rules)
}

/// Read the durable project rules, or say why not.
///
/// **Absent and unreadable are not the same answer here, and conflating them
/// destroys data.** This is the one rule store with no compiled copy to rebuild
/// from: the session file is regenerated at every spawn, and this is not. A
/// blanket `unwrap_or_default()` would read a file this build cannot parse - a
/// future format, a rule carrying a field it does not know - as "no rules", and
/// the next [`save_project`] would then write that emptiness over the user's
/// real ones. So a failed read is reported and, above all, is never a base to
/// write from.
pub fn read_project(path: &Path) -> Result<ProjectRuleFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        // No file is genuinely no rules, and is the common case: every project
        // starts here.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ProjectRuleFile::default()),
        Err(e) => return Err(e.to_string()),
    };
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// The project's rules for a reader that only wants to *use* them.
///
/// Falls back to empty, which is safe in this direction: rules that cannot be
/// read are rules that are not applied, and not applying a rule only ever means
/// asking the user. Callers that are about to **write** must use
/// [`read_project`] instead, so an unreadable file is not overwritten with the
/// empty one this returns.
pub fn load_project(path: &Path) -> ProjectRuleFile {
    read_project(path).unwrap_or_default()
}

pub fn save_project(path: &Path, file: &ProjectRuleFile) -> Result<(), String> {
    // Stamped on write, so a v1 file becomes a v2 one the first time it is
    // amended rather than needing a migration pass.
    let stamped = ProjectRuleFile { format_version: FORMAT_VERSION, rules: file.rules.clone() };
    let text = serde_json::to_string(&stamped).map_err(|e| e.to_string())?;
    // Durable user intent, and the one rule store with no compiled copy to fall
    // back on, so it gets the atomic replace rather than a truncating write.
    write_atomically(path, &text)
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

/// Just the version, read on its own.
///
/// Separate from the full parse on purpose: a file from a *future* format may
/// well fail to deserialize into this build's `RuleFile`, and if the version
/// could only be read as part of that parse, such a file would collapse into
/// "unreadable" and be treated as an absent one. Reading the version first is
/// what keeps "written by a Sway I do not know" a distinguishable answer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionProbe {
    format_version: u32,
}

pub fn parse(text: &str) -> Parsed {
    // No version at all is a v1 file (or something that is not a rule file).
    // Either way this build will not act on it: v1 predates every restrictive
    // kind, so reading its rules would be reading them without the fields that
    // say what they mean.
    let Ok(probe) = serde_json::from_str::<VersionProbe>(text) else { return Parsed::Unreadable };
    if probe.format_version != FORMAT_VERSION {
        return Parsed::UnknownVersion(probe.format_version);
    }
    match serde_json::from_str(text) {
        Ok(file) => Parsed::Ok(file),
        Err(_) => Parsed::Unreadable,
    }
}

pub fn serialize(file: &RuleFile) -> String {
    serde_json::to_string(file).unwrap_or_else(|_| "{}".to_string())
}

pub fn load(path: &Path) -> Parsed {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text),
        Err(_) => Parsed::Unreadable,
    }
}

/// The rule file, when it is one this build can act on. For the callers that
/// only ever want to read or amend Sway's own current-format file.
pub fn load_ok(path: &Path) -> Option<RuleFile> {
    match load(path) {
        Parsed::Ok(file) => Some(file),
        _ => None,
    }
}

pub fn save(path: &Path, file: &RuleFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serialize(file)).map_err(|e| e.to_string())
}

// --- approval counts -------------------------------------------------------
//
// How often the user has approved the same call by hand, per project, so Sway
// can offer to stop asking. Written by the **supervisor** and never by the
// helper: the helper runs on every tool call and its cheap path is one file
// read, so a write there would put a file write on the path
// [[concept_pretooluse_approval_bridge]] exists to keep free.

/// Approvals counted per project, as the atomically-replaced small map the
/// owned-state layout calls for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalCounts {
    /// Absent in a file written before counts were versioned, which reads as 0
    /// and is simply an empty count - losing a tally is not worth a migration.
    #[serde(default)]
    pub format_version: u32,
    /// Keyed by [`count_key`]. A `BTreeMap` so the serialized bytes are stable,
    /// which keeps an unchanged file byte-identical across writes.
    #[serde(default)]
    pub counts: std::collections::BTreeMap<String, u32>,
}

/// The identity a count is kept against: the tool plus the scope an offer would
/// use. Two different scopes for one tool are two different tallies, so
/// approving `Read` all over the tree never adds up to an offer for one folder.
pub fn count_key(tool: &str, scope: &str) -> String {
    format!("{tool}\t{scope}")
}

/// The scope an "always allow in this project" offer would cover for one call:
/// the containing directory for a path-shaped tool, the exact argument
/// otherwise. `None` when the tool's shape is unknown, which is what stops an
/// offer being made for a call Sway cannot describe.
pub fn offer_scope(tool: &str, input: &Value) -> Option<String> {
    path_prefix_for(tool, input).or_else(|| primary_arg(tool, input))
}

pub fn counts_path(cwd: &str) -> PathBuf {
    project_state_path("chat-rules/counts", cwd)
}

/// Where a per-project store lives, under `kind`.
///
/// Shared so every per-project map keys itself the same way. The directory name
/// carries a readable basename plus a hash of the full path, because two
/// checkouts of one repo are two projects and must not share a store, while a
/// path used verbatim would blow past the filename length cap.
pub fn project_state_path(kind: &str, cwd: &str) -> PathBuf {
    let base = Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config/sway")
        .join(kind)
        .join(format!("{}-{:016x}.json", sanitize_id(&base), path_hash(cwd)))
}

pub fn load_counts(path: &Path) -> ApprovalCounts {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Record one approval and return the new tally.
///
/// Read-modify-write under the supervisor's own single-threaded call path, so
/// there is no second writer to race. A failed write loses a count and nothing
/// else, which is why it degrades to a returned error rather than to a refusal.
pub fn record_approval(path: &Path, tool: &str, scope: &str) -> Result<u32, String> {
    let mut file = load_counts(path);
    file.format_version = FORMAT_VERSION;
    let n = file.counts.entry(count_key(tool, scope)).or_insert(0);
    *n = n.saturating_add(1);
    let total = *n;
    write_atomically(path, &serde_json::to_string(&file).map_err(|e| e.to_string())?)?;
    Ok(total)
}

/// Replace a file's contents in one step: write a sibling temp, flush it to
/// disk, then rename over the target.
///
/// The rename is what makes this atomic - a reader sees the old file or the new
/// one, never a half-written one. The `sync_all` before it is what makes the
/// contents durable rather than merely the name: without it a crash can leave
/// the renamed file present but empty, which for a rule store reads as "no rules
/// here" and is exactly the silent state this module exists to avoid.
pub fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".{}.tmp", path.file_name().unwrap_or_default().to_string_lossy()));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    // The rename itself is only durable once the directory entry is, so a crash
    // straight after this cannot resurrect the file that was replaced.
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
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

    fn file(rules: Vec<Rule>) -> Parsed {
        Parsed::Ok(RuleFile::new(1234, 1_000_000, rules))
    }

    fn rule(tool: &str, prefix: Option<&str>) -> Rule {
        Rule::allow(tool, prefix)
    }

    #[test]
    fn a_matching_rule_short_circuits_without_ever_prompting() {
        let f = file(vec![rule("Read", None)]);
        assert_eq!(evaluate(&f, "Read", &json!({"file_path": "/a/b.rs"}), 1_000_000, alive), Verdict::Allow);
    }

    #[test]
    fn an_unmatched_tool_asks() {
        let f = file(vec![rule("Read", None)]);
        assert_eq!(evaluate(&f, "Bash", &json!({"command": "rm -rf /"}), 1_000_000, alive), Verdict::Ask);
    }

    /// A prefix rule is a literal prefix on the tool's primary argument, so
    /// "allow Read under this project" cannot leak into a sibling directory.
    #[test]
    fn a_prefix_rule_covers_only_that_prefix() {
        let f = file(vec![rule("Read", Some("/home/me/proj/"))]);
        assert_eq!(evaluate(&f, "Read", &json!({"file_path": "/home/me/proj/src/a.rs"}), 1_000_000, alive), Verdict::Allow);
        assert_eq!(evaluate(&f, "Read", &json!({"file_path": "/home/me/other/a.rs"}), 1_000_000, alive), Verdict::Ask);
    }

    /// A tool whose shape we do not know must not be matched by a prefix rule.
    /// Falling through to a prompt is the safe direction; matching vacuously
    /// would turn "allow Read under /proj" into "allow this unknown tool".
    #[test]
    fn a_prefix_rule_cannot_match_a_tool_with_no_known_primary_argument() {
        assert_eq!(primary_arg("SomeFutureTool", &json!({"whatever": "x"})), None);
        let f = file(vec![rule("SomeFutureTool", Some("/proj"))]);
        assert_eq!(evaluate(&f, "SomeFutureTool", &json!({"whatever": "/proj/x"}), 1_000_000, alive), Verdict::Ask);
    }

    /// A bare tool rule still covers an unknown tool, because it says nothing
    /// about arguments - the user allowed the tool itself.
    #[test]
    fn a_bare_tool_rule_covers_a_tool_with_no_known_argument() {
        let f = file(vec![rule("SomeFutureTool", None)]);
        assert_eq!(evaluate(&f, "SomeFutureTool", &json!({}), 1_000_000, alive), Verdict::Allow);
    }

    /// **The cheap path must not defeat fail-closed.** A rule is a statement
    /// about what Sway will permit while Sway is watching; with the supervisor
    /// gone it is not a standing grant.
    #[test]
    fn a_dead_supervisor_denies_even_an_allow_listed_tool() {
        let f = file(vec![rule("Read", None)]);
        let v = evaluate(&f, "Read", &json!({"file_path": "/a"}), 1_000_000, dead);
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
        assert!(matches!(evaluate(&f, "Read", &json!({"file_path": "/a"}), later, alive), Verdict::Deny(_)));
        // One millisecond inside the window is still fresh.
        let just_ok = 1_000_000 + STAMP_TTL_MS;
        assert_eq!(evaluate(&f, "Read", &json!({"file_path": "/a"}), just_ok, alive), Verdict::Allow);
    }

    /// A clock that jumps backwards must not deny every tool call. The stamp
    /// reads as age zero rather than as an enormous negative age.
    #[test]
    fn a_stamp_from_the_future_reads_as_fresh_rather_than_stale() {
        let f = file(vec![rule("Read", None)]);
        assert_eq!(evaluate(&f, "Read", &json!({"file_path": "/a"}), 1, alive), Verdict::Allow);
    }

    /// Missing and invalid both mean "nothing pre-approved", so the user is
    /// asked. Denying here would make a brand-new session unable to do anything.
    #[test]
    fn a_missing_or_invalid_rule_file_asks_rather_than_denying() {
        assert_eq!(evaluate(&Parsed::Unreadable, "Read", &json!({}), 1_000_000, alive), Verdict::Ask);
        assert_eq!(parse(""), Parsed::Unreadable);
        assert_eq!(parse("{ not json"), Parsed::Unreadable);
        // A v1 file: no version at all, so this build will not act on it either.
        assert_eq!(parse(r#"{"swayPid": 1, "stampMs": 2}"#), Parsed::Unreadable);
    }

    #[test]
    fn rules_round_trip_through_the_on_disk_shape() {
        let Parsed::Ok(f) = file(vec![rule("Read", None), rule("Bash", Some("git status"))]) else {
            unreachable!("the fixture is a current-format file")
        };
        assert_eq!(parse(&serialize(&f)), Parsed::Ok(f));
    }

    #[test]
    fn write_read_back_and_removal_all_work_off_disk() {
        let dir = std::env::temp_dir().join(format!("sway-rules-{}", std::process::id()));
        let path = dir.join("s.json");
        let _ = std::fs::remove_dir_all(&dir);

        let Parsed::Ok(f) = file(vec![rule("Read", None)]) else { unreachable!() };
        save(&path, &f).unwrap();
        assert_eq!(load(&path), Parsed::Ok(f));

        std::fs::remove_file(&path).unwrap();
        assert_eq!(load(&path), Parsed::Unreadable);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A partial file (rules omitted) is usable and simply grants nothing.
    #[test]
    fn a_file_with_no_rules_is_valid_and_grants_nothing() {
        let parsed = parse(r#"{"formatVersion": 2, "supervisorPid": 5, "stampMs": 10}"#);
        let Parsed::Ok(f) = &parsed else { panic!("rules should default to empty, got {parsed:?}") };
        assert!(f.rules.is_empty());
        assert_eq!(evaluate(&parsed, "Read", &json!({}), 10, alive), Verdict::Ask);
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
        let rule = Rule::allow("Read", Some(&dir));
        assert!(rule.matches("Read", &json!({"file_path": "/proj/src/deep/b.rs"})));
        assert!(!rule.matches("Read", &json!({"file_path": "/proj/srcret/b.rs"})), "a name that merely starts the same must not match");
    }

    /// If an empty prefix ever did reach a rule, it would match everything -
    /// documented here so the guard above is visibly load-bearing rather than
    /// looking like defensive noise.
    #[test]
    fn an_empty_prefix_would_match_everything_which_is_why_one_is_never_written() {
        let dangerous = Rule::allow("Bash", Some(""));
        assert!(dangerous.matches("Bash", &json!({"command": "rm -rf /"})));
    }

    /// "Always allow in this project" has to mean the project, not the tab. The
    /// session file is deleted at teardown, so a rule that lived only there
    /// would expire the moment the chat closed.
    #[test]
    fn a_projects_rules_compile_into_a_session_that_has_none_of_its_own() {
        let project = ProjectRuleFile { format_version: FORMAT_VERSION, rules: vec![rule("Read", Some("/proj/"))] };
        let compiled = compiled(&project, None, 42, 1_000);
        assert_eq!(compiled.rules, project.rules);
        assert_eq!(compiled.sway_pid, 42, "the compiling supervisor is the one that will be checked");
        assert_eq!(compiled.stamp_ms, 1_000);
    }

    /// A resumed session id can already have a file. Replacing it wholesale
    /// would silently revoke the session-scoped rules the user granted last
    /// time, which reads as approvals coming back for no reason.
    #[test]
    fn compiling_keeps_a_sessions_own_rules_and_never_duplicates_a_shared_one() {
        let shared = rule("Read", Some("/proj/"));
        let own = rule("Bash", Some("git status"));
        let Parsed::Ok(existing) = file(vec![own.clone(), shared.clone()]) else { unreachable!() };
        let project = ProjectRuleFile { format_version: FORMAT_VERSION, rules: vec![shared.clone(), rule("Grep", None)] };

        let compiled = compiled(&project, Some(&existing), 7, 2_000);
        assert_eq!(compiled.rules, vec![own, shared, rule("Grep", None)]);
    }

    /// Two checkouts of one repo are two working trees. Sharing a rule set
    /// between them would let a click in one grant tool access in the other.
    #[test]
    fn two_checkouts_sharing_a_basename_get_separate_rule_files() {
        let a = project_rules_path("/Users/x/Projects/sway/main");
        let b = project_rules_path("/Users/x/Projects/sway-wt/main");
        assert_ne!(a, b);
        assert_eq!(a.parent(), b.parent());
        assert_eq!(a, project_rules_path("/Users/x/Projects/sway/main"), "the same path must be stable across runs");
    }

    /// The refresh interval has to leave room for a missed tick, or ordinary
    /// scheduling jitter would deny a live session's tool calls.
    #[test]
    fn the_refresh_interval_leaves_room_for_a_missed_tick() {
        assert!(STAMP_REFRESH_MS * 2 < STAMP_TTL_MS, "two missed refreshes must still be inside the TTL");
    }

    // --- version skew ------------------------------------------------------

    fn restrictive(tool: &str, kind: RuleKind, glob: Option<&str>) -> Rule {
        Rule { tool: tool.into(), prefix: None, glob: glob.map(str::to_string), kind, origin: RuleOrigin::Manual }
    }

    /// **The failure this whole version gate exists to prevent.**
    ///
    /// A Sway that predates the restrictive kinds, handed a file containing a
    /// `deny` rule, must not read it as a bare allow rule. Serde drops unknown
    /// fields by default, so without the wire-key rename it would do exactly
    /// that, and the user's "never touch this" would have become "always allow
    /// this" - silently, in the one module where silence is least acceptable.
    #[test]
    fn a_version_one_sway_honours_nothing_in_a_version_two_file() {
        use super::super::rules_v1_frozen as v1;

        let denies_bash = serialize(&RuleFile::new(1234, 1_000_000, vec![restrictive("Bash", RuleKind::Deny, None)]));
        let call = json!({"command": "rm -rf /"});

        // The frozen v1 parser cannot read the file at all, which is the point:
        // there is no half-reading to get wrong.
        assert!(v1::parse(&denies_bash).is_none(), "a v2 file must not parse as v1");
        let verdict = v1::evaluate(v1::parse(&denies_bash).as_ref(), "Bash", &call, 1_000_000, |_| true);
        assert_eq!(verdict, v1::Verdict::Ask, "with nothing parsed there is nothing to honour");

        // `Ask` is not a grant, and for the orphan case it is not even a
        // prompt: the helper goes on to open the approval socket, and a session
        // orphaned by a crashed Sway has none, which `helper_exchange` turns
        // into a denial. That last hop is covered by
        // `approval::tests::an_unreachable_socket_denies`, so the chain from
        // "cannot read the file" to "denied" is asserted end to end rather
        // than argued for here.
    }

    /// The mirror of the above from this side: a file from a *later* Sway is
    /// refused outright rather than being read for the parts that still fit.
    #[test]
    fn a_file_from_a_newer_sway_denies_rather_than_being_half_read() {
        let future = r#"{"formatVersion": 99, "supervisorPid": 1, "stampMs": 2, "rules": [], "somethingNew": true}"#;
        assert_eq!(parse(future), Parsed::UnknownVersion(99));
        let Verdict::Deny(why) = evaluate(&parse(future), "Read", &json!({}), 2, alive) else {
            panic!("a version this build cannot interpret must deny")
        };
        assert!(why.contains("v99"), "the reason should name the version it could not read: {why}");
    }

    // --- restrictive kinds -------------------------------------------------

    /// Restrictions beat grants **whatever order they sit in**. Resolving by
    /// position would make the safety of a rule set depend on the order clicks
    /// happened to land in, which nobody can see and nobody could audit.
    #[test]
    fn a_deny_rule_beats_an_allow_rule_in_either_order() {
        let call = json!({"command": "git push"});
        for rules in [
            vec![rule("Bash", None), restrictive("Bash", RuleKind::Deny, None)],
            vec![restrictive("Bash", RuleKind::Deny, None), rule("Bash", None)],
        ] {
            assert!(matches!(evaluate(&file(rules), "Bash", &call, 1_000_000, alive), Verdict::Deny(_)));
        }
    }

    #[test]
    fn an_ask_rule_takes_back_a_standing_allow() {
        let f = file(vec![rule("Bash", None), restrictive("Bash", RuleKind::Ask, None)]);
        assert_eq!(evaluate(&f, "Bash", &json!({"command": "git push"}), 1_000_000, alive), Verdict::Ask);
    }

    /// Every kind, including the new restrictive ones, is behind the liveness
    /// contract. A `deny` surviving an absent supervisor would be harmless on
    /// its own, which is exactly why it is worth asserting: the contract is
    /// "no rule of any kind is honoured unsupervised", and carving out the safe
    /// exception is how that erodes into a case-by-case judgement.
    #[test]
    fn no_kind_of_rule_is_honoured_without_a_live_supervisor() {
        for kind in [RuleKind::Allow, RuleKind::Ask, RuleKind::Deny] {
            let f = file(vec![restrictive("Read", kind, None)]);
            let Verdict::Deny(why) = evaluate(&f, "Read", &json!({"file_path": "/a"}), 1_000_000, dead) else {
                panic!("{kind:?} should be denied when nothing is supervising")
            };
            assert!(why.contains("not supervising"), "{why}");
        }
    }

    // --- path-scoped restrictions ------------------------------------------

    /// The shape task 4 asks for: "prompt me about anything under migrations",
    /// and nowhere else.
    #[test]
    fn a_glob_restriction_prompts_inside_its_tree_and_nowhere_else() {
        let f = file(vec![rule("Write", None), restrictive("Write", RuleKind::Ask, Some("**/migrations/**"))]);
        let ask = json!({"file_path": "/proj/db/migrations/001_init.sql"});
        let allow = json!({"file_path": "/proj/src/main.rs"});
        assert_eq!(evaluate(&f, "Write", &ask, 1_000_000, alive), Verdict::Ask);
        assert_eq!(evaluate(&f, "Write", &allow, 1_000_000, alive), Verdict::Allow);
    }

    /// A glob widens a rule in a way its author cannot easily picture. That is
    /// tolerable for a restriction, where the worst case is more prompting, and
    /// not for a grant. Enforced at match time and not only on the write path,
    /// so a hand-edited file cannot smuggle one in either.
    #[test]
    fn a_glob_on_an_allow_rule_grants_nothing() {
        let smuggled =
            Rule { tool: "Read".into(), prefix: None, glob: Some("**".into()), kind: RuleKind::Allow, origin: RuleOrigin::Manual };
        let f = file(vec![smuggled]);
        assert_eq!(evaluate(&f, "Read", &json!({"file_path": "/anything"}), 1_000_000, alive), Verdict::Ask);
    }

    #[test]
    fn a_star_stops_at_a_path_separator_and_a_double_star_does_not() {
        assert!(glob_matches("src/*.rs", "src/main.rs"));
        assert!(!glob_matches("src/*.rs", "src/deep/main.rs"), "one star must not cross a separator");
        assert!(glob_matches("src/**/*.rs", "src/deep/main.rs"));
        // `**` matches zero segments too, or `src/**/x` would not cover `src/x`.
        assert!(glob_matches("src/**/main.rs", "src/main.rs"));
        assert!(glob_matches("**/migrations/**", "/proj/db/migrations/001.sql"));
        assert!(!glob_matches("**/migrations/**", "/proj/db/migrated/001.sql"));
        assert!(glob_matches("a?c", "abc"));
        assert!(!glob_matches("a?c", "ac"));
    }

    // --- spend ceilings ----------------------------------------------------

    /// **The hole this design exists to close.** A `Read` covered by an allow
    /// rule never opens the approval socket - that is the cheap path, and it is
    /// deliberate. So a ceiling enforced at the socket would be one that a
    /// **A rule file written when the ceiling lived here still parses.** The
    /// `stop` key is gone from the struct, but it is on disk in every session
    /// file a previous build left behind, and serde must ignore it rather than
    /// fail the read - an unparseable rule file reads as "written by a Sway I do
    /// not know" and refuses every call.
    #[test]
    fn a_rule_file_carrying_the_retired_spend_stop_still_parses() {
        let text = serde_json::json!({
            "formatVersion": FORMAT_VERSION,
            "supervisorPid": std::process::id(),
            "stampMs": 1_000_000u64,
            "stop": "Session budget reached.",
            "rules": [],
        })
        .to_string();
        let Parsed::Ok(f) = parse(&text) else { panic!("a file with the retired key must still parse") };
        assert!(f.rules.is_empty());
        // And it decides nothing: the ceiling is the turn boundary's business now.
        assert_eq!(evaluate(&Parsed::Ok(f.clone()), "Read", &json!({"file_path": "/a"}), 1_000_000, alive), Verdict::Ask);
        // The next write drops the key, so the file heals rather than carrying a
        // dead stop forever.
        assert!(!serialize(&f).contains("stop"), "the retired key must not be written back");
    }

    // --- approval counts ---------------------------------------------------

    /// Counted per (tool, scope) and durable, so the tally that produces an
    /// offer survives closing the app - the whole point being to notice a habit,
    /// which by definition spans more than one sitting.
    #[test]
    fn approvals_are_counted_per_scope_and_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("sway-counts-{}", std::process::id()));
        let path = dir.join("counts.json");
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(record_approval(&path, "Read", "/proj/src/").unwrap(), 1);
        assert_eq!(record_approval(&path, "Read", "/proj/src/").unwrap(), 2);
        // A different scope is a different habit: approving Read all over the
        // tree must not add up to an offer about one folder.
        assert_eq!(record_approval(&path, "Read", "/proj/docs/").unwrap(), 1);

        // Re-read from disk, which is what a restart amounts to here.
        let reloaded = load_counts(&path);
        assert_eq!(reloaded.counts.get(&count_key("Read", "/proj/src/")), Some(&2));
        assert_eq!(reloaded.counts.get(&count_key("Read", "/proj/docs/")), Some(&1));
        assert_eq!(reloaded.format_version, FORMAT_VERSION);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The replace has to be all-or-nothing: a reader that caught a half-written
    /// counts file would read a truncated map, and for a rule store the same
    /// mechanism reading half a file means "no rules here".
    #[test]
    fn an_atomic_write_leaves_no_temp_file_behind() {
        let dir = std::env::temp_dir().join(format!("sway-atomic-{}", std::process::id()));
        let path = dir.join("thing.json");
        let _ = std::fs::remove_dir_all(&dir);

        write_atomically(&path, "first").unwrap();
        write_atomically(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "thing.json")
            .collect();
        assert!(leftovers.is_empty(), "the temp file should be gone: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The one store with nothing to rebuild it from.** A project file this
    /// build cannot parse must not read as "no rules", because the caller that
    /// asked is usually about to write, and it would write that emptiness over
    /// the real ones. Reading for *use* still falls back to empty, which is safe
    /// in that direction: a rule not applied only ever means asking the user.
    #[test]
    fn an_unreadable_project_file_is_reported_rather_than_read_as_empty() {
        let dir = std::env::temp_dir().join(format!("sway-projrules-{}", std::process::id()));
        let path = dir.join("p.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // No file at all is genuinely no rules: every project starts here.
        assert_eq!(read_project(&path), Ok(ProjectRuleFile::default()));

        // A rule carrying a field this build does not know - which is what a
        // later format looks like from here, and why `Rule` denies unknown
        // fields at all.
        std::fs::write(&path, r#"{"rules":[{"tool":"Write","somethingNew":true}]}"#).unwrap();
        assert!(read_project(&path).is_err(), "a writer must be told rather than handed an empty set");
        assert!(load_project(&path).rules.is_empty(), "a reader may still fall back to applying nothing");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An offer is about a place, so a path-shaped tool is scoped to its
    /// directory and everything else to the exact argument it was approved for.
    #[test]
    fn an_offers_scope_widens_a_path_and_never_a_command() {
        assert_eq!(offer_scope("Write", &json!({"file_path": "/proj/src/a.rs"})), Some("/proj/src/".into()));
        assert_eq!(offer_scope("Bash", &json!({"command": "git status"})), Some("git status".into()));
        assert_eq!(offer_scope("Mystery", &json!({"x": 1})), None, "a tool we cannot describe gets no offer");
    }
}
