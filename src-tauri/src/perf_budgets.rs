//! The rust half of `perf-budgets.json`. Counts and bytes only: a timing seen
//! across runs is machine noise, and a gate that flakes gets ignored.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::chat::commands::{history_reply, HistorySource};
use crate::chat::host::ChatHost;
use crate::config::{resolve_root, ProjectIndex, ProjectKind};
use crate::exec::git_spawns_under;
use crate::git::{git_branch_sync_many, SyncUnit};

const TABLE: &str = include_str!("../../perf-budgets.json");

#[derive(Deserialize)]
struct Row {
    name: String,
    runtime: String,
    unit: Unit,
    budget: u64,
    reason: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum Unit {
    Count,
    Bytes,
}

const BYTES_SLACK_PERCENT: u64 = 10;

fn rows(runtime: &str) -> Vec<Row> {
    let all: Vec<Row> = serde_json::from_str(TABLE).expect("perf-budgets.json parses");
    all.into_iter().filter(|r| r.runtime == runtime).collect()
}

fn drift(rows: &[Row], measured: &BTreeMap<String, u64>) -> Vec<String> {
    let mut out = Vec::new();
    for row in rows {
        let Some(&actual) = measured.get(&row.name) else {
            out.push(format!("{}: in the table but never measured", row.name));
            continue;
        };
        let budget = row.budget;
        match row.unit {
            Unit::Count if actual != budget => {
                out.push(format!("{}: budget {budget}, measured {actual} ({})", row.name, row.reason));
            }
            Unit::Bytes if actual > budget => {
                out.push(format!("{}: budget {budget} bytes, measured {actual} ({})", row.name, row.reason));
            }
            Unit::Bytes if actual * 100 <= budget * (100 - BYTES_SLACK_PERCENT) => {
                out.push(format!(
                    "{}: measured {actual} bytes, {BYTES_SLACK_PERCENT}% or more under the budget of {budget}, lower the row",
                    row.name
                ));
            }
            _ => {}
        }
    }
    for name in measured.keys() {
        if !rows.iter().any(|r| &r.name == name) {
            out.push(format!("{name}: measured but has no row"));
        }
    }
    out
}

fn transcript(turns: usize, output: impl Fn(usize) -> String) -> String {
    let mut lines = Vec::with_capacity(turns * 4);
    for i in 0..turns {
        let ts = format!("2026-01-01T00:{:02}:{:02}.000Z", (i / 60) % 60, i % 60);
        let mut push = |v: serde_json::Value| lines.push(v.to_string());
        push(serde_json::json!({
            "type": "user", "cwd": "/p", "timestamp": ts,
            "message": { "content": format!("prompt {i}: look at the file and run the tests") },
        }));
        push(serde_json::json!({
            "type": "assistant", "cwd": "/p", "timestamp": ts,
            "message": { "content": [
                { "type": "text", "text": "On it." },
                { "type": "tool_use", "id": format!("toolu_{i}"), "name": "Bash", "input": { "command": "npm test" } },
            ] },
        }));
        push(serde_json::json!({
            "type": "user", "cwd": "/p", "timestamp": ts,
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": format!("toolu_{i}"), "content": output(i), "is_error": false },
            ] },
        }));
        push(serde_json::json!({
            "type": "assistant", "cwd": "/p", "timestamp": ts,
            "message": { "content": [{ "type": "text", "text": "All tests pass." }] },
        }));
    }
    lines.join("\n") + "\n"
}

/// For a session the host does not know, the browse path every restored tab
/// takes before its chat is spawned.
fn history_bytes(name: &str, body: &str) -> u64 {
    let dir = std::env::temp_dir().join(format!("tori-perf-budgets-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{name}.jsonl"));
    std::fs::write(&path, body).unwrap();
    let file = path.to_string_lossy().into_owned();
    let from = move || HistorySource::Transcript(file);
    let reply = tauri::async_runtime::block_on(history_reply(
        &ChatHost::default(),
        "s1".into(),
        from,
        "claude".into(),
        None,
    ));
    let _ = std::fs::remove_file(&path);
    serde_json::to_vec(&reply).unwrap().len() as u64
}

fn git(dir: &Path, args: &[&str]) {
    let out = crate::exec::git_in(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t.test")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t.test")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

// A worktree container and a plain repo: the two shapes the sidebar probes
// differently.
fn sidebar_fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("tori-perf-sidebar-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("space")).unwrap();
    let root = root.canonicalize().unwrap();

    let plain = root.join("space/plain");
    std::fs::create_dir_all(&plain).unwrap();
    git(&plain, &["init", "-q", "-b", "main"]);
    std::fs::write(plain.join("README.md"), "hi").unwrap();
    git(&plain, &["add", "."]);
    git(&plain, &["commit", "-q", "-m", "init"]);
    git(&plain, &["branch", "feat"]);

    let cont = root.join("space/cont");
    std::fs::create_dir_all(&cont).unwrap();
    git(&root, &["init", "-q", "--bare", cont.join(".bare").to_str().unwrap()]);
    std::fs::write(cont.join(".git"), "gitdir: ./.bare\n").unwrap();
    git(&plain, &["push", "-q", cont.join(".bare").to_str().unwrap(), "main", "feat"]);
    git(&cont, &["worktree", "add", "-q", "main"]);
    git(&cont, &["worktree", "add", "-q", "feat"]);
    root
}

// The warm refresh sends the batch no rows because `branchSync.ts` only asks
// about rows it has not drawn. That rule lives in the webview, so this cannot
// see it change.
fn sidebar_spawns() -> (u64, u64) {
    let root = sidebar_fixture();
    let built = git_spawns_under(&root);
    let index = ProjectIndex::default();
    let config = resolve_root(&root, &index);
    let units: Vec<SyncUnit> = config
        .spaces
        .iter()
        .flat_map(|g| &g.projects)
        .flat_map(|p| &p.branch_units)
        .filter(|u| matches!(u.kind, ProjectKind::Worktree | ProjectKind::Plain))
        .map(|u| SyncUnit { path: u.folder_path.clone(), branch: u.branch.clone().unwrap_or_default() })
        .collect();
    assert_eq!(units.len(), 3, "two worktrees, and the plain repo's checked out branch");
    git_branch_sync_many(units).unwrap();
    let cold = git_spawns_under(&root) - built;
    resolve_root(&root, &index);
    let warm = git_spawns_under(&root) - built - cold;
    let _ = std::fs::remove_dir_all(&root);
    (cold as u64, warm as u64)
}

fn measure() -> BTreeMap<String, u64> {
    let short = |i: usize| format!("{} passed", i + 1);
    let big = |_: usize| "x".repeat(5 * 1024 * 1024);
    let (cold, warm) = sidebar_spawns();
    BTreeMap::from([
        ("git.spawns.sidebar.cold".into(), cold),
        ("git.spawns.sidebar.warm".into(), warm),
        ("chat_history.bytes.small".into(), history_bytes("small", &transcript(3, short))),
        ("chat_history.bytes.2000_turns".into(), history_bytes("2000_turns", &transcript(2000, short))),
        ("chat_history.bytes.5mb_tool_output".into(), history_bytes("5mb_tool_output", &transcript(1, big))),
    ])
}

#[test]
fn every_rust_budget_holds() {
    let drifted = drift(&rows("rust"), &measure());
    assert!(drifted.is_empty(), "perf budgets drifted:\n{}", drifted.join("\n"));
}

#[test]
fn the_table_names_every_row_once_with_a_reason() {
    let all: Vec<Row> = serde_json::from_str(TABLE).unwrap();
    let mut names: Vec<&str> = all.iter().map(|r| r.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), all.len(), "a row name appears twice");
    for row in &all {
        assert!(["rust", "webview"].contains(&row.runtime.as_str()), "{}: unknown runtime", row.name);
        assert!(!row.reason.trim().is_empty(), "{}: no reason", row.name);
    }
}

mod drift {
    use super::*;

    fn row(name: &str, unit: Unit, budget: u64) -> Row {
        Row { name: name.into(), runtime: "rust".into(), unit, budget, reason: "why".into() }
    }

    fn check(rows: &[Row], measured: &[(&str, u64)]) -> Vec<String> {
        drift(rows, &measured.iter().map(|(n, v)| ((*n).to_string(), *v)).collect())
    }

    #[test]
    fn a_count_must_match_exactly() {
        let rows = [row("c", Unit::Count, 5)];
        assert!(check(&rows, &[("c", 5)]).is_empty());
        assert_eq!(check(&rows, &[("c", 6)]).len(), 1);
        assert_eq!(check(&rows, &[("c", 4)]).len(), 1);
    }

    #[test]
    fn bytes_fail_over_the_budget_and_well_under_it() {
        let rows = [row("b", Unit::Bytes, 1000)];
        assert!(check(&rows, &[("b", 1000)]).is_empty());
        assert!(check(&rows, &[("b", 901)]).is_empty());
        assert_eq!(check(&rows, &[("b", 1001)]).len(), 1, "over");
        assert_eq!(check(&rows, &[("b", 900)]).len(), 1, "10% under is stale");
    }

    #[test]
    fn a_row_nobody_measures_fails() {
        let found = check(&[row("c", Unit::Count, 1)], &[]);
        assert!(found[0].contains("never measured"), "{found:?}");
    }

    #[test]
    fn a_measurement_with_no_row_fails() {
        let found = check(&[], &[("stray", 1)]);
        assert!(found[0].contains("has no row"), "{found:?}");
    }
}
