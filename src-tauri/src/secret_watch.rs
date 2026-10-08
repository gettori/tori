//! Secret watch: which tool calls read, or named, a file that holds a secret.
//!
//! A fact recorded on the call, never a gate. Two strengths, because the
//! evidence differs: a read or search tool says which path it opened, while a
//! shell command only mentions one, and `ls ~/.aws` mentions without reading.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat::model::{ToolKind, ToolLocation};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretStrength {
    /// A shell command had the path as one of its tokens.
    Named,
    /// A read or search tool opened the path.
    Read,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretHit {
    pub paths: Vec<String>,
    pub strength: SecretStrength,
}

const ENV_TEMPLATES: [&str; 3] = ["example", "sample", "template"];
const KEY_NAMES: [&str; 4] = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];
const SSH_PUBLIC: [&str; 3] = ["config", "known_hosts", "authorized_keys"];

/// The default list plus the user's additions, resolved against one home.
pub struct Rules {
    enabled: bool,
    home: PathBuf,
    globs: Vec<globset::GlobMatcher>,
    prefixes: Vec<PathBuf>,
}

impl Rules {
    pub fn new(home: PathBuf, extra: &[String]) -> Self {
        let mut globs = Vec::new();
        let mut prefixes = Vec::new();
        for pattern in extra.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
            if pattern.contains('/') {
                prefixes.push(normalize(&expand(pattern, &home)));
            } else if let Ok(glob) = globset::Glob::new(pattern) {
                globs.push(glob.compile_matcher());
            }
        }
        Self {
            enabled: true,
            home,
            globs,
            prefixes,
        }
    }

    /// Rules that match nothing, for when secret watch is switched off.
    pub fn off() -> Self {
        Self {
            enabled: false,
            home: PathBuf::new(),
            globs: Vec::new(),
            prefixes: Vec::new(),
        }
    }

    /// Is `raw` a secret file, once `~`, `$HOME` and a relative `cwd` are
    /// resolved? A path that cannot be anchored is still judged by its name.
    pub fn matches(&self, raw: &str, cwd: Option<&Path>) -> bool {
        let raw = raw.trim();
        if !self.enabled || raw.is_empty() {
            return false;
        }
        let mut path = expand(raw, &self.home);
        if path.is_relative() {
            if let Some(cwd) = cwd {
                path = cwd.join(path);
            }
        }
        let path = normalize(&path);
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        if name.ends_with(".pub") {
            return false;
        }
        if default_name(name) || self.globs.iter().any(|g| g.is_match(name)) {
            return true;
        }
        let home = |rel: &str| self.home.join(rel);
        if path.starts_with(home(".aws")) || path.starts_with(home(".config/gh")) {
            return true;
        }
        if path.starts_with(home(".ssh")) && path != home(".ssh") && !name.contains('.') && !SSH_PUBLIC.contains(&name)
        {
            return true;
        }
        self.prefixes.iter().any(|p| path.starts_with(p))
    }
}

fn default_name(name: &str) -> bool {
    name == ".env"
        || (name.starts_with(".env.")
            && !name
                .rsplit('.')
                .next()
                .is_some_and(|last| ENV_TEMPLATES.contains(&last)))
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || KEY_NAMES.contains(&name)
        || name == "credentials"
        || name == "credentials.json"
        || name == ".netrc"
}

pub(crate) fn expand(raw: &str, home: &Path) -> PathBuf {
    for prefix in ["~/", "$HOME/", "${HOME}/"] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return home.join(rest);
        }
    }
    if matches!(raw, "~" | "$HOME" | "${HOME}") {
        return home.to_path_buf();
    }
    PathBuf::from(raw)
}

// Lexical: the file may not exist, and a symlink is not followed, since the
// claim is about the path the agent wrote down.
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    out
}

// Wider than whitespace, so `--env-file=.env`, `$(cat .env)` and
// `open('.env')` all surface `.env` as a word of its own.
pub(crate) fn shell_words(command: &str) -> impl Iterator<Item = &str> {
    command
        .split(|c: char| c.is_whitespace() || "'\"()`;&|<>=,[]".contains(c))
        .filter(|w| !w.is_empty())
}

// ACP sends a command as either one string or an argument list.
pub(crate) fn command_text(input: &Value) -> Option<String> {
    match input.get("command")? {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => Some(parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
        _ => None,
    }
}

/// The secret files one emission of a tool call reads or names.
///
/// Called per emission, patches included: an ACP update can carry the
/// locations its opening frame left out, and that is the only place the path
/// appears.
pub fn classify(
    name: &str,
    kind: ToolKind,
    input: &Value,
    locations: &[ToolLocation],
    cwd: Option<&Path>,
    rules: &Rules,
) -> Option<SecretHit> {
    let mut paths: Vec<String> = Vec::new();
    let strength = match kind {
        // `Glob` lists names and opens nothing.
        ToolKind::Read | ToolKind::Search if name != "Glob" => {
            let named = ["file_path", "path", "notebook_path"]
                .iter()
                .filter_map(|k| input.get(*k).and_then(Value::as_str));
            for p in named.chain(locations.iter().map(|l| l.path.as_str())) {
                if rules.matches(p, cwd) {
                    paths.push(p.to_string());
                }
            }
            SecretStrength::Read
        }
        ToolKind::Execute => {
            let command = command_text(input)?;
            for word in shell_words(&command) {
                if rules.matches(word, cwd) {
                    paths.push(word.to_string());
                }
            }
            SecretStrength::Named
        }
        _ => return None,
    };
    paths.sort();
    paths.dedup();
    (!paths.is_empty()).then_some(SecretHit { paths, strength })
}

/// The rules for the settings file as it is now, rebuilt only when the file's
/// modification time moves. Also the generation a cache of hits keys on, so a
/// pattern added in settings invalidates what was computed under the old list.
pub fn current() -> (std::sync::Arc<Rules>, Option<SystemTime>) {
    static CACHE: Mutex<Option<(Option<SystemTime>, std::sync::Arc<Rules>)>> = Mutex::new(None);
    let stamp = crate::settings::modified();
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, rules)) = cache.as_ref() {
        if *at == stamp {
            return (rules.clone(), stamp);
        }
    }
    let watch = crate::settings::secret_watch();
    let rules = std::sync::Arc::new(if watch.enabled {
        Rules::new(dirs::home_dir().unwrap_or_default(), &watch.patterns)
    } else {
        Rules::off()
    });
    *cache = Some((stamp, rules.clone()));
    (rules, stamp)
}

/// Fold a hit into the call's `secret` field when the event is a tool call.
pub fn annotate(event: &mut crate::chat::model::ChatEvent, cwd: Option<&Path>, rules: &Rules) {
    if let crate::chat::model::ChatEvent::ToolCallStarted {
        name,
        input,
        kind,
        locations,
        secret,
        ..
    } = event
    {
        *secret = classify(name, *kind, input, locations, cwd, rules);
    }
}

/// One turn's secret reads, for a surface that shows a turn without its calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretTurn {
    /// `None` for a history with no prompts to anchor on, which is an ACP log.
    pub prompt_ts: Option<u64>,
    pub paths: Vec<String>,
    pub strength: SecretStrength,
}

fn merge(into: &mut SecretTurn, hit: SecretHit) {
    into.paths.extend(hit.paths);
    into.paths.sort();
    into.paths.dedup();
    if hit.strength == SecretStrength::Read {
        into.strength = SecretStrength::Read;
    }
}

/// Fold a conversation's calls into one entry per turn. `prompts` pairs each
/// prompt's timestamp with the index of its first event; with none, calls are
/// grouped by the turn id they carry instead.
pub fn secret_turns(
    events: &[crate::chat::model::ChatEvent],
    prompts: &[(u64, usize)],
    cwd: Option<&Path>,
    rules: &Rules,
) -> Vec<SecretTurn> {
    let mut out: Vec<(String, SecretTurn)> = Vec::new();
    for (at, event) in events.iter().enumerate() {
        let crate::chat::model::ChatEvent::ToolCallStarted {
            turn_id,
            name,
            input,
            kind,
            locations,
            ..
        } = event
        else {
            continue;
        };
        let Some(hit) = classify(name, *kind, input, locations, cwd, rules) else {
            continue;
        };
        let prompt_ts = prompts.iter().rev().find(|(_, first)| *first <= at).map(|(ts, _)| *ts);
        let key = match prompt_ts {
            Some(ts) => ts.to_string(),
            None if prompts.is_empty() => turn_id.clone(),
            None => String::new(),
        };
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some((_, turn)) => merge(turn, hit),
            None => out.push((
                key,
                SecretTurn {
                    prompt_ts,
                    paths: hit.paths,
                    strength: hit.strength,
                },
            )),
        }
    }
    out.into_iter().map(|(_, turn)| turn).collect()
}

/// Per-session results, kept while neither the history nor the settings file
/// has moved. Both are part of the key: a pattern added in settings changes the
/// answer for a transcript that did not change at all.
pub struct TurnCache<T = SecretTurn> {
    entries: HashMap<String, (Stamp, Vec<T>)>,
}

impl<T> Default for TurnCache<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

pub type Stamp = (Option<SystemTime>, Option<SystemTime>);

const TURN_CACHE_CAP: usize = 256;

impl<T: Clone> TurnCache<T> {
    pub fn get(&self, session_id: &str, stamp: Stamp) -> Option<Vec<T>> {
        let (at, turns) = self.entries.get(session_id)?;
        (*at == stamp).then(|| turns.clone())
    }

    pub fn put(&mut self, session_id: &str, stamp: Stamp, turns: Vec<T>) {
        if self.entries.len() >= TURN_CACHE_CAP {
            self.entries.clear();
        }
        self.entries.insert(session_id.to_string(), (stamp, turns));
    }
}

/// The newest write to a transcript or to any of its subagents' files, which
/// is when its conversation last changed.
pub fn history_stamp(source: &Path) -> Option<SystemTime> {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let mut newest = modified(source);
    let subagents = source.to_str().and_then(crate::sessions::subagents_dir);
    for entry in subagents
        .and_then(|d| std::fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .flatten()
    {
        newest = newest.max(modified(&entry.path()));
    }
    newest
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules() -> Rules {
        Rules::new(PathBuf::from("/Users/me"), &[])
    }

    fn hit(raw: &str) -> bool {
        rules().matches(raw, Some(Path::new("/Users/me/work/app/src")))
    }

    #[test]
    fn the_default_list_flags_each_kind_of_secret() {
        for raw in [
            ".env",
            ".env.local",
            ".env.production",
            "config/server.pem",
            "tls.key",
            "/Users/me/.ssh/id_rsa",
            "id_ed25519",
            "id_ecdsa",
            "id_dsa",
            "credentials",
            "credentials.json",
            "/Users/me/.netrc",
            "~/.aws/credentials",
            "~/.aws/config",
            "$HOME/.config/gh/hosts.yml",
            "${HOME}/.aws/sso/cache/token.json",
            "~/.ssh/deploy_key",
            "../../../.aws/config",
        ] {
            assert!(hit(raw), "{raw} should be a secret");
        }
    }

    #[test]
    fn templates_public_keys_and_lookalikes_are_not_secrets() {
        for raw in [
            ".env.example",
            ".env.sample",
            ".env.template",
            ".env.local.example",
            ".env.production.sample",
            "src/id_utils.ts",
            "src/credentials.ts",
            "~/.ssh/id_rsa.pub",
            "~/.ssh/config",
            "~/.ssh/known_hosts",
            "~/.ssh/known_hosts.pub",
            "~/.ssh/authorized_keys",
            "~/.ssh",
            "README.md",
            "",
        ] {
            assert!(!hit(raw), "{raw} should not be a secret");
        }
    }

    #[test]
    fn switched_off_nothing_is_a_secret() {
        assert!(!Rules::off().matches(".env", None));
        let call = classify(
            "Bash",
            ToolKind::Execute,
            &json!({ "command": "cat .env" }),
            &[],
            None,
            &Rules::off(),
        );
        assert_eq!(call, None);
    }

    #[test]
    fn added_patterns_extend_the_list_by_name_or_by_prefix() {
        let rules = Rules::new(
            PathBuf::from("/Users/me"),
            &["*.secret".into(), "~/vault/".into(), " ".into()],
        );
        assert!(rules.matches("a.secret", None));
        assert!(rules.matches("/Users/me/vault/db.txt", None));
        assert!(!rules.matches("a.txt", None));
        assert!(!rules.matches("/Users/me/vaulted/db.txt", None));
    }

    #[test]
    fn a_cached_answer_holds_until_the_history_or_the_settings_move() {
        let at = |s: u64| Some(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(s));
        let turn = SecretTurn {
            prompt_ts: Some(1),
            paths: vec![".env".into()],
            strength: SecretStrength::Read,
        };
        let mut cache = TurnCache::default();
        cache.put("s1", (at(10), at(20)), vec![turn.clone()]);
        assert_eq!(cache.get("s1", (at(10), at(20))), Some(vec![turn]));
        assert_eq!(cache.get("s1", (at(11), at(20))), None, "the transcript grew");
        assert_eq!(cache.get("s1", (at(10), at(21))), None, "a pattern was added");
        assert_eq!(cache.get("s2", (at(10), at(20))), None);
    }

    fn started(name: &str, kind: ToolKind, input: Value, locations: &[&str]) -> Option<SecretHit> {
        let locations: Vec<ToolLocation> = locations
            .iter()
            .map(|p| ToolLocation {
                path: p.to_string(),
                line: None,
            })
            .collect();
        classify(
            name,
            kind,
            &input,
            &locations,
            Some(Path::new("/Users/me/app")),
            &rules(),
        )
    }

    fn read(paths: &[&str]) -> Option<SecretHit> {
        Some(SecretHit {
            paths: paths.iter().map(|p| p.to_string()).collect(),
            strength: SecretStrength::Read,
        })
    }

    fn named(paths: &[&str]) -> Option<SecretHit> {
        Some(SecretHit {
            paths: paths.iter().map(|p| p.to_string()).collect(),
            strength: SecretStrength::Named,
        })
    }

    #[test]
    fn a_read_or_search_tool_reads_the_path_it_names() {
        assert_eq!(
            started("Read", ToolKind::Read, json!({"file_path": "/Users/me/app/.env"}), &[]),
            read(&["/Users/me/app/.env"])
        );
        assert_eq!(
            started(
                "Grep",
                ToolKind::Search,
                json!({"pattern": "KEY", "path": ".env.local"}),
                &[]
            ),
            read(&[".env.local"])
        );
        assert_eq!(
            started("read", ToolKind::Read, Value::Null, &["/Users/me/.netrc"]),
            read(&["/Users/me/.netrc"])
        );
        assert_eq!(started("", ToolKind::Other, Value::Null, &["/Users/me/.netrc"]), None);
        assert_eq!(
            started("Read", ToolKind::Read, json!({"file_path": "src/main.rs"}), &[]),
            None
        );
    }

    #[test]
    fn a_patch_with_only_locations_still_classifies() {
        assert_eq!(
            started("", ToolKind::Read, Value::Null, &["~/.aws/credentials"]),
            read(&["~/.aws/credentials"])
        );
    }

    #[test]
    fn glob_opens_nothing() {
        assert_eq!(
            started(
                "Glob",
                ToolKind::Search,
                json!({"pattern": "*.pem", "path": "~/.aws"}),
                &[]
            ),
            None
        );
    }

    #[test]
    fn a_shell_command_names_any_secret_among_its_words() {
        let bash = |c: &str| started("Bash", ToolKind::Execute, json!({ "command": c }), &[]);
        assert_eq!(bash("cat .env"), named(&[".env"]));
        assert_eq!(bash("cat .env; echo done"), named(&[".env"]));
        assert_eq!(bash("docker run --env-file=.env app"), named(&[".env"]));
        assert_eq!(bash("echo $(cat .env)"), named(&[".env"]));
        assert_eq!(bash("cp ~/.aws/credentials /tmp"), named(&["~/.aws/credentials"]));
        assert_eq!(bash("python -c \"open('.env').read()\""), named(&[".env"]));
        assert_eq!(bash("source $HOME/.aws/env"), named(&["$HOME/.aws/env"]));
        assert_eq!(bash("grep -r TOKEN src"), None);
        assert_eq!(
            started(
                "execute",
                ToolKind::Execute,
                json!({ "command": ["cat", "/Users/me/.netrc"] }),
                &[]
            ),
            named(&["/Users/me/.netrc"])
        );
    }
}
