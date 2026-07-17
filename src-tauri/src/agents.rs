// Agent adapter registry: what used to be "claude"/"pi" string branches
// scattered through sessions.rs is now data. Two adapters ship bundled
// (agents/claude.toml, agents/pi.toml, embedded at compile time); a user can
// add or whole-replace an adapter by dropping a `schema_version = 1` TOML
// file into `~/.config/sway/agents/`. See ADAPTERS.md for the schema.
//
// Parser kinds stay code (an enum, not a config string): a config-driven
// launch/discovery/running-pattern description is enough to make an agent
// show up and resume correctly, but turning its transcript into `SessionMeta`/
// `SessionDetail`/touched-files/transcript-turns needs a real parser
// implementation. A user adapter may only reference an existing kind.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParserKind {
    ClaudeJsonl,
    PiJsonl,
}

impl ParserKind {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude_jsonl" => Some(Self::ClaudeJsonl),
            "pi_jsonl" => Some(Self::PiJsonl),
            _ => None,
        }
    }
}

/// A resolved, validated adapter. The frontend gets a mirrored subset of this
/// via `list_agents` (the regex/path fields stay backend-only).
#[derive(Debug, Clone, Serialize)]
pub struct AgentAdapter {
    pub id: String,
    pub label: String,
    pub program: String,
    pub base_args: Vec<String>,
    pub yolo_args: Vec<String>,
    /// `{id}`/`{file}` placeholder template; `apply_template` substitutes.
    pub resume_args: Vec<String>,
    #[serde(skip)]
    pub discovery_dir: PathBuf,
    #[serde(skip)]
    pub filename_regex: Regex,
    pub parser_kind: ParserKind,
    /// ERE template (for `pgrep -f`) with an `{id}` placeholder.
    pub running_pattern: String,
    pub pty_quiet_ms: u64,
}

// --- raw TOML shape (kept separate from `AgentAdapter`: a `Regex` isn't
// `Deserialize`, and validation needs to happen before the typed struct is
// trusted) ---

#[derive(Debug, Deserialize)]
struct AdapterToml {
    schema_version: u32,
    id: String,
    label: String,
    launch: LaunchToml,
    discovery: DiscoveryToml,
    parser: ParserToml,
    running: RunningToml,
    #[serde(default)]
    capabilities: CapabilitiesToml,
}

#[derive(Debug, Deserialize)]
struct LaunchToml {
    program: String,
    #[serde(default)]
    base_args: Vec<String>,
    #[serde(default)]
    yolo_args: Vec<String>,
    resume_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct DiscoveryToml {
    dir: String,
    filename_pattern: String,
}

#[derive(Debug, Deserialize)]
struct ParserToml {
    kind: String,
}

#[derive(Debug, Deserialize)]
struct RunningToml {
    pattern: String,
}

#[derive(Debug, Deserialize)]
struct CapabilitiesToml {
    #[serde(default = "default_quiet_ms")]
    pty_quiet_ms: u64,
}

impl Default for CapabilitiesToml {
    fn default() -> Self {
        Self { pty_quiet_ms: default_quiet_ms() }
    }
}

fn default_quiet_ms() -> u64 {
    2000
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

const REQUIRED_TOP_LEVEL: [&str; 7] =
    ["schema_version", "id", "label", "launch", "discovery", "parser", "running"];
const KNOWN_TOP_LEVEL: [&str; 8] =
    ["schema_version", "id", "label", "launch", "discovery", "parser", "running", "capabilities"];

/// Parse + validate one adapter TOML source. `source` labels the origin for
/// error messages/warnings (a file path, or a fixed name for a built-in).
/// Rejects an unsupported `schema_version`, names every missing required
/// field in one message (not just the first, the way a bare serde error
/// would), warns (doesn't reject) on an unrecognized top-level field, and
/// rejects a `parser.kind` outside the closed set of implemented parsers.
fn load_adapter_str(text: &str, source: &str) -> Result<AgentAdapter, String> {
    let value: toml::Value = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if let Some(table) = value.as_table() {
        for key in table.keys() {
            if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
                eprintln!("sway: agent adapter {source}: unknown field `{key}`, ignoring");
            }
        }
        let missing: Vec<&str> =
            REQUIRED_TOP_LEVEL.iter().filter(|k| !table.contains_key(**k)).copied().collect();
        if !missing.is_empty() {
            return Err(format!("{source}: missing required field(s): {}", missing.join(", ")));
        }
    }

    let raw: AdapterToml = toml::from_str(text).map_err(|e| format!("{source}: {e}"))?;

    if raw.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "{source}: unsupported schema_version {} (sway supports {SCHEMA_VERSION})",
            raw.schema_version
        ));
    }

    let parser_kind = ParserKind::from_str(&raw.parser.kind).ok_or_else(|| {
        format!(
            "{source}: unknown parser kind `{}` (expected claude_jsonl or pi_jsonl)",
            raw.parser.kind
        )
    })?;

    let filename_regex = Regex::new(&raw.discovery.filename_pattern)
        .map_err(|e| format!("{source}: invalid discovery.filename_pattern: {e}"))?;
    if filename_regex.capture_names().flatten().all(|n| n != "id") {
        return Err(format!(
            "{source}: discovery.filename_pattern must have a named `id` capture group"
        ));
    }

    Ok(AgentAdapter {
        id: raw.id,
        label: raw.label,
        program: raw.launch.program,
        base_args: raw.launch.base_args,
        yolo_args: raw.launch.yolo_args,
        resume_args: raw.launch.resume_args,
        discovery_dir: expand_tilde(&raw.discovery.dir),
        filename_regex,
        parser_kind,
        running_pattern: raw.running.pattern,
        pty_quiet_ms: raw.capabilities.pty_quiet_ms,
    })
}

const BUILTIN_CLAUDE: &str = include_str!("../agents/claude.toml");
const BUILTIN_PI: &str = include_str!("../agents/pi.toml");

fn user_agents_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/sway/agents")
}

/// Bundled built-ins, then every `*.toml` in `user_dir`. A user file whose id
/// matches a built-in whole-replaces it (last insert wins - the entire
/// struct, never a field-by-field merge). A user file that fails validation
/// is never silently swallowed: it's logged loudly (naming the problem) and
/// the id it would have overridden keeps its previous (built-in or
/// earlier-loaded) entry, so one broken file can't make an agent disappear.
fn build_registry_from(user_dir: &Path) -> Vec<AgentAdapter> {
    let mut by_id: HashMap<String, AgentAdapter> = HashMap::new();

    for (source, text) in [("bundled:claude", BUILTIN_CLAUDE), ("bundled:pi", BUILTIN_PI)] {
        match load_adapter_str(text, source) {
            Ok(a) => {
                by_id.insert(a.id.clone(), a);
            }
            Err(e) => eprintln!("sway: ERROR loading built-in agent adapter {source}: {e}"),
        }
    }

    if let Ok(entries) = std::fs::read_dir(user_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            let source = path.to_string_lossy().into_owned();
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("sway: ERROR reading agent adapter {source}: {e}");
                    continue;
                }
            };
            match load_adapter_str(&text, &source) {
                Ok(a) => {
                    by_id.insert(a.id.clone(), a);
                }
                Err(e) => eprintln!(
                    "sway: ERROR loading agent adapter {source}: {e} (keeping the previous adapter for this id)"
                ),
            }
        }
    }

    let mut list: Vec<AgentAdapter> = by_id.into_values().collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

fn build_registry() -> Vec<AgentAdapter> {
    build_registry_from(&user_agents_dir())
}

static REGISTRY: OnceLock<Vec<AgentAdapter>> = OnceLock::new();

/// The process-wide adapter registry, loaded once on first use (bundled +
/// `~/.config/sway/agents/*.toml`; not live-watched - restart to pick up
/// edits, same as any other loaded-at-startup config in Sway today).
pub fn registry() -> &'static [AgentAdapter] {
    REGISTRY.get_or_init(build_registry)
}

pub fn find(id: &str) -> Option<&'static AgentAdapter> {
    registry().iter().find(|a| a.id == id)
}

/// Substitute `{id}`/`{file}` placeholders in an arg template.
pub fn apply_template(template: &[String], id: &str, file: &str) -> Vec<String> {
    template.iter().map(|a| a.replace("{id}", id).replace("{file}", file)).collect()
}

/// ERE pattern (for `pgrep -f`) matching a live process resuming session
/// `id`. Falls back to the claude pattern for an unrecognized agent id,
/// matching this function's pre-registry implicit default.
pub fn session_pattern(agent: &str, id: &str) -> String {
    match find(agent).or_else(|| find("claude")) {
        Some(a) => a.running_pattern.replace("{id}", id),
        None => format!("claude (--resume|-r) {id}"),
    }
}

/// The parser kind for `agent`, defaulting to Claude's shape for an
/// unrecognized id (matches the pre-registry implicit `else` branch every
/// transcript-parsing call site used to take).
pub fn parser_kind_for(agent: &str) -> ParserKind {
    find(agent).map(|a| a.parser_kind).unwrap_or(ParserKind::ClaudeJsonl)
}

#[tauri::command]
pub fn list_agents() -> Vec<AgentAdapter> {
    registry().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("sway_agents_test_{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const VALID_MINIMAL: &str = r#"
schema_version = 1
id = "x"
label = "X"

[launch]
program = "x"
resume_args = ["--resume", "{id}"]

[discovery]
dir = "~/.x/sessions"
filename_pattern = '^(?P<id>.+)\.jsonl$'

[parser]
kind = "claude_jsonl"

[running]
pattern = 'x --resume {id}'
"#;

    #[test]
    fn bundled_adapters_load_and_validate() {
        let claude = load_adapter_str(BUILTIN_CLAUDE, "bundled:claude").expect("claude parses");
        assert_eq!(claude.id, "claude");
        assert_eq!(claude.program, "claude");
        assert_eq!(claude.parser_kind, ParserKind::ClaudeJsonl);
        assert_eq!(claude.yolo_args, vec!["--dangerously-skip-permissions"]);

        let pi = load_adapter_str(BUILTIN_PI, "bundled:pi").expect("pi parses");
        assert_eq!(pi.id, "pi");
        assert_eq!(pi.program, "pi");
        assert_eq!(pi.parser_kind, ParserKind::PiJsonl);
    }

    #[test]
    fn sample_user_toml_for_a_new_agent_loads() {
        let a = load_adapter_str(VALID_MINIMAL, "test").expect("valid user adapter parses");
        assert_eq!(a.id, "x");
        assert_eq!(a.resume_args, vec!["--resume", "{id}"]);
        assert!(a.filename_regex.is_match("abc.jsonl"));
    }

    #[test]
    fn full_override_of_claude_whole_replaces_the_builtin() {
        let dir = tmp_dir();
        std::fs::write(
            dir.join("claude.toml"),
            r#"
schema_version = 1
id = "claude"
label = "Claude (custom)"

[launch]
program = "claude-beta"
resume_args = ["--resume", "{id}"]

[discovery]
dir = "~/.claude-beta/projects"
filename_pattern = '^(?P<id>.+)\.jsonl$'

[parser]
kind = "claude_jsonl"

[running]
pattern = 'claude-beta (--resume|-r) {id}'
"#,
        )
        .unwrap();

        let reg = build_registry_from(&dir);
        let claude = reg.iter().find(|a| a.id == "claude").expect("claude present");
        assert_eq!(claude.program, "claude-beta");
        assert_eq!(claude.label, "Claude (custom)");
        // pi is untouched by an override that only names claude.
        let pi = reg.iter().find(|a| a.id == "pi").expect("pi present");
        assert_eq!(pi.program, "pi");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_override_keeps_the_builtin_available_not_a_silent_swap() {
        let dir = tmp_dir();
        // Missing label/launch/discovery/parser/running.
        std::fs::write(dir.join("claude.toml"), "schema_version = 1\nid = \"claude\"\n").unwrap();

        let reg = build_registry_from(&dir);
        let claude = reg.iter().find(|a| a.id == "claude").expect("built-in claude still present");
        assert_eq!(claude.program, "claude"); // untouched bundled value, not silently dropped

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bad_schema_version_is_rejected() {
        let text = VALID_MINIMAL.replacen("schema_version = 1", "schema_version = 2", 1);
        let err = load_adapter_str(&text, "test").unwrap_err();
        assert!(err.contains("schema_version"), "error should mention schema_version: {err}");
    }

    #[test]
    fn partial_override_names_every_missing_field() {
        let err = load_adapter_str("schema_version = 1\nid = \"x\"\n", "test").unwrap_err();
        for field in ["label", "launch", "discovery", "parser", "running"] {
            assert!(err.contains(field), "error should name missing field `{field}`: {err}");
        }
    }

    #[test]
    fn unknown_parser_kind_is_rejected() {
        let text = VALID_MINIMAL.replacen("kind = \"claude_jsonl\"", "kind = \"made_up_kind\"", 1);
        let err = load_adapter_str(&text, "test").unwrap_err();
        assert!(err.contains("made_up_kind"), "error should name the bad kind: {err}");
    }

    /// ADAPTERS.md's complete example (a from-scratch `gemini` adapter) is not
    /// just illustrative prose - it must actually validate, so the doc can't
    /// silently drift from what the loader accepts.
    #[test]
    fn adapters_md_example_parses() {
        let doc = include_str!("../../ADAPTERS.md");
        let heading = "## Example: a from-scratch third-party adapter";
        let after_heading =
            doc.find(heading).expect("ADAPTERS.md must document a complete example") + heading.len();
        let rest = &doc[after_heading..];
        let fence_start =
            rest.find("```toml").expect("the example section must have a ```toml block") + "```toml".len();
        let fence_end = rest[fence_start..].find("```").expect("unterminated ```toml fence") + fence_start;
        let example = rest[fence_start..fence_end].trim();

        let a = load_adapter_str(example, "ADAPTERS.md example").expect("the example TOML should parse");
        assert_eq!(a.id, "gemini");
        assert_eq!(a.parser_kind, ParserKind::ClaudeJsonl);
    }

    #[test]
    fn apply_template_substitutes_placeholders() {
        let resume = vec!["--resume".to_string(), "{id}".to_string()];
        assert_eq!(apply_template(&resume, "abc", ""), vec!["--resume", "abc"]);
        let session = vec!["--session".to_string(), "{file}".to_string()];
        assert_eq!(
            apply_template(&session, "", "/path/to/file.jsonl"),
            vec!["--session", "/path/to/file.jsonl"]
        );
    }
}
