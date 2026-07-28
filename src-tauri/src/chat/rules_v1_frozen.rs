//! **A frozen copy of the version-1 rule parser. Never edit this file.**
//!
//! Its only job is to answer one question, forever: *given a rule file written
//! by a later Sway, does a Sway that predates the format honour anything in it?*
//! The answer has to stay "no", and the only way to keep testing that is to keep
//! a parser that genuinely cannot read the newer format.
//!
//! **Why a frozen parser rather than a pinned binary.** The plan asked for the
//! real pre-change helper binary, retained as a test artifact. The property
//! being tested belongs to the *parser*, not to a build: a helper honours a rule
//! because `evaluate` said so, and nothing between here and the socket can turn
//! a refusal into a grant. A frozen parser tests exactly that in milliseconds,
//! cannot rot, and needs no ~100MB artifact stored per format version. It buys
//! one thing less than a binary would - it proves *this* v1 parser refuses,
//! not that some particular shipped build does - and at the time this was
//! written there was no shipped build to differ from (0.1.0, no tags).
//!
//! **What v1 could not do, which is the whole point.** It had no
//! `formatVersion`, and serde ignores unknown fields by default, so a v1 parser
//! handed a v2 file would read the fields it recognised and silently drop the
//! rest. A `deny` rule would arrive as a bare `{tool, prefix}` and be honoured
//! as an **allow** - a silent inversion of the user's intent, in the one place
//! in Sway where that is least acceptable. v2 therefore renames the wire key
//! `swayPid` to `supervisorPid`, which v1 requires and cannot default, so a v2
//! file fails v1 parsing outright instead of being half-read. See
//! `rules::FORMAT_VERSION`.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub tool: String,
    #[serde(default)]
    pub prefix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFile {
    pub sway_pid: u32,
    pub stamp_ms: u64,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Deny(String),
    Ask,
}

pub const STAMP_TTL_MS: u64 = 15_000;

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

impl Rule {
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

pub fn supervisor_ok(file: &RuleFile, now_ms: u64, alive: impl Fn(u32) -> bool) -> bool {
    if !alive(file.sway_pid) {
        return false;
    }
    now_ms.saturating_sub(file.stamp_ms) <= STAMP_TTL_MS
}

pub fn evaluate(
    file: Option<&RuleFile>,
    tool: &str,
    input: &Value,
    now_ms: u64,
    alive: impl Fn(u32) -> bool,
) -> Verdict {
    let Some(file) = file else { return Verdict::Ask };
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

pub fn parse(text: &str) -> Option<RuleFile> {
    serde_json::from_str(text).ok()
}
