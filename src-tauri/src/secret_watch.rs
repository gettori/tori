//! Secret watch: which tool calls read, or named, a file that holds a secret.
//!
//! A fact recorded on the call, never a gate. Two strengths, because the
//! evidence differs: a read or search tool says which path it opened, while a
//! shell command only mentions one, and `ls ~/.aws` mentions without reading.

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
        Self { home, globs, prefixes }
    }

    /// Is `raw` a secret file, once `~`, `$HOME` and a relative `cwd` are
    /// resolved? A path that cannot be anchored is still judged by its name.
    pub fn matches(&self, raw: &str, cwd: Option<&Path>) -> bool {
        let raw = raw.trim();
        if raw.is_empty() {
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

fn expand(raw: &str, home: &Path) -> PathBuf {
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
fn normalize(path: &Path) -> PathBuf {
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
fn shell_words(command: &str) -> impl Iterator<Item = &str> {
    command
        .split(|c: char| c.is_whitespace() || "'\"()`;&|<>=,[]".contains(c))
        .filter(|w| !w.is_empty())
}

// ACP sends a command as either one string or an argument list.
fn command_text(input: &Value) -> Option<String> {
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
    let home = dirs::home_dir().unwrap_or_default();
    let rules = std::sync::Arc::new(Rules::new(home, &crate::settings::secret_patterns()));
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
