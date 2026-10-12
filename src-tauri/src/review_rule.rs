//! The project review rule: when a pull request asks for your review, make its
//! review worktree. Deciding is pure over what the rule has seen; this file also
//! keeps that on disk and runs the tick that acts on it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::issues::commands::ReviewRequests;
use crate::settings::{ReviewAction, ReviewRule};

const HOUR_SECS: u64 = 3600;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenPr {
    pub head: Option<String>,
    pub listed: bool,
    pub worktree: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SeenProject {
    pub baselined: bool,
    pub paused: bool,
    pub fired: Vec<u64>,
    pub prs: BTreeMap<u64, SeenPr>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    /// The request entered the list: a first request, or a re-request.
    Entered(u64),
    /// The head moved while the request stayed listed, under a rule worktree.
    Moved(u64),
}

pub fn plan_review_rule(
    seen: &mut SeenProject,
    list: Option<&ReviewRequests>,
    rule: &ReviewRule,
    now: u64,
) -> Vec<Act> {
    if rule.action == ReviewAction::Off {
        seen.baselined = false;
        return Vec::new();
    }
    // A list that failed, is missing or hit the cap cannot say what left it,
    // so it records nothing.
    let Some(list) = list.filter(|l| l.complete) else {
        return Vec::new();
    };
    let rows: BTreeMap<u64, Option<String>> = list
        .rows
        .iter()
        .filter_map(|r| Some((r.key.parse().ok()?, r.head_sha.clone())))
        .collect();
    let first = !seen.baselined;
    seen.baselined = true;
    let mut wanted = Vec::new();
    for (&number, head) in &rows {
        let pr = seen.prs.entry(number).or_default();
        if !pr.listed {
            wanted.push(Act::Entered(number));
        } else if pr.worktree && head.is_some() && pr.head != *head {
            wanted.push(Act::Moved(number));
        }
        pr.listed = true;
        pr.head = head.clone();
    }
    for (number, pr) in seen.prs.iter_mut() {
        if !rows.contains_key(number) {
            pr.listed = false;
        }
    }
    if first || seen.paused {
        return Vec::new();
    }
    seen.fired.retain(|&t| t + HOUR_SECS > now);
    let mut acts = Vec::new();
    for act in wanted {
        if seen.fired.len() >= rule.max_per_hour as usize {
            seen.paused = true;
            break;
        }
        seen.fired.push(now);
        acts.push(act);
    }
    acts
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Seen(BTreeMap<String, SeenProject>);

fn store_path() -> PathBuf {
    crate::owned_state::config_dir().join("review_rule.json")
}

fn key(project: &str) -> String {
    project.trim_end_matches('/').to_string()
}

fn load(path: &Path) -> Seen {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(path: &Path, seen: &Seen) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(seen).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

// Load, change and save under one lock, so two ticks landing together cannot
// both read a request as new.
fn with_project<T>(file: &Path, project: &str, change: impl FnOnce(&mut SeenProject) -> T) -> Result<T, String> {
    let lock = crate::exec::named_lock("review_rule");
    let _held = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut seen = load(file);
    let entry = seen.0.entry(key(project)).or_default();
    let before = entry.clone();
    let out = change(entry);
    if seen.0.get(&key(project)) != Some(&before) {
        save(file, &seen)?;
    }
    Ok(out)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One tick of `project`'s rule over the list its poll just read.
pub fn tick(app: &AppHandle, project: &str, list: Option<&ReviewRequests>) {
    let rule = crate::settings::review_rule(project);
    let file = store_path();
    if rule.action == ReviewAction::Off && !load(&file).0.get(&key(project)).is_some_and(|p| p.baselined) {
        return;
    }
    let planned = with_project(&file, project, |p| {
        let was = p.paused;
        (plan_review_rule(p, list, &rule, now_secs()), !was && p.paused)
    });
    let acts = match planned {
        Ok((acts, paused)) => {
            if paused {
                let _ = app.emit("review-rule://changed", project);
            }
            acts
        }
        Err(e) => {
            eprintln!("tori: review rule state not saved: {e}");
            return;
        }
    };
    let entered: Vec<u64> = acts
        .iter()
        .filter_map(|a| match a {
            Act::Entered(n) => Some(*n),
            Act::Moved(_) => None,
        })
        .collect();
    if entered.is_empty() {
        return;
    }
    let (app, project) = (app.clone(), project.to_string());
    std::thread::spawn(move || {
        for number in entered {
            if let Err(e) = open_worktree(&app, &project, number) {
                eprintln!("tori: review worktree for #{number} not made: {e}");
            }
        }
    });
}

fn open_worktree(app: &AppHandle, project: &str, number: u64) -> Result<(), String> {
    let head = crate::worktree::review_head(project, number).map_err(|e| e.to_string())?;
    crate::worktree::checkout_review(app, project, &head)?;
    with_project(&store_path(), project, |p| {
        p.prs.entry(number).or_default().worktree = true
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleState {
    pub paused: bool,
}

#[tauri::command]
pub fn review_rule_state(project_path: String) -> RuleState {
    let seen = load(&store_path());
    RuleState {
        paused: seen.0.get(&key(&project_path)).is_some_and(|p| p.paused),
    }
}

#[tauri::command]
pub fn review_rule_resume(project_path: String) -> Result<(), String> {
    with_project(&store_path(), &project_path, |p| {
        p.paused = false;
        p.fired.clear();
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issues::{IssueKind, IssueRef};

    fn rule(action: ReviewAction, max: u32) -> ReviewRule {
        ReviewRule {
            action,
            prompt: None,
            max_per_hour: max,
        }
    }

    fn list(rows: &[(u64, &str)], complete: bool) -> ReviewRequests {
        ReviewRequests {
            rows: rows
                .iter()
                .map(|(n, head)| IssueRef {
                    key: n.to_string(),
                    display: format!("#{n}"),
                    title: "t".into(),
                    url: "u".into(),
                    kind: IssueKind::ReviewRequest,
                    author: Some("ana".into()),
                    head_sha: Some(head.to_string()),
                })
                .collect(),
            complete,
        }
    }

    const ON: fn() -> ReviewRule = || rule(ReviewAction::Worktree, 5);

    #[test]
    fn the_first_tick_records_what_was_waiting_and_a_new_entry_acts() {
        let mut seen = SeenProject::default();
        assert!(plan_review_rule(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0).is_empty());
        let acts = plan_review_rule(&mut seen, Some(&list(&[(1, "a"), (2, "b")], true)), &ON(), 10);
        assert_eq!(acts, [Act::Entered(2)]);
        assert!(plan_review_rule(&mut seen, Some(&list(&[(1, "a"), (2, "b")], true)), &ON(), 20).is_empty());
    }

    #[test]
    fn leaving_and_coming_back_acts_again() {
        let mut seen = SeenProject::default();
        plan_review_rule(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0);
        plan_review_rule(&mut seen, Some(&list(&[], true)), &ON(), 10);
        assert_eq!(
            plan_review_rule(&mut seen, Some(&list(&[(1, "b")], true)), &ON(), 20),
            [Act::Entered(1)]
        );
    }

    #[test]
    fn a_head_change_while_listed_acts_only_over_a_rule_worktree() {
        let mut seen = SeenProject::default();
        plan_review_rule(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0);
        assert!(plan_review_rule(&mut seen, Some(&list(&[(1, "b")], true)), &ON(), 10).is_empty());
        seen.prs.get_mut(&1).unwrap().worktree = true;
        assert_eq!(
            plan_review_rule(&mut seen, Some(&list(&[(1, "c")], true)), &ON(), 20),
            [Act::Moved(1)]
        );
    }

    #[test]
    fn a_missing_failed_or_capped_list_changes_nothing() {
        let mut seen = SeenProject::default();
        plan_review_rule(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0);
        let before = seen.clone();
        assert!(plan_review_rule(&mut seen, None, &ON(), 10).is_empty());
        assert!(plan_review_rule(&mut seen, Some(&list(&[(2, "b")], false)), &ON(), 20).is_empty());
        assert_eq!(seen, before);
        assert!(
            plan_review_rule(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 30).is_empty(),
            "a good tick after the gap fires nothing for what never left"
        );
    }

    #[test]
    fn the_cap_pauses_the_rule_and_a_paused_rule_only_records() {
        let mut seen = SeenProject::default();
        let two = rule(ReviewAction::Worktree, 2);
        plan_review_rule(&mut seen, Some(&list(&[], true)), &two, 0);
        let acts = plan_review_rule(&mut seen, Some(&list(&[(1, "a"), (2, "b"), (3, "c")], true)), &two, 10);
        assert_eq!(acts, [Act::Entered(1), Act::Entered(2)]);
        assert!(seen.paused);
        assert!(plan_review_rule(
            &mut seen,
            Some(&list(&[(1, "a"), (2, "b"), (3, "c"), (4, "d")], true)),
            &two,
            20
        )
        .is_empty());
        assert!(
            seen.prs[&4].listed,
            "paused still records, so a resume does not fire the backlog"
        );
    }

    #[test]
    fn turning_the_rule_off_and_on_again_starts_from_a_recording_tick() {
        let mut seen = SeenProject::default();
        plan_review_rule(&mut seen, Some(&list(&[], true)), &ON(), 0);
        plan_review_rule(&mut seen, Some(&list(&[], true)), &rule(ReviewAction::Off, 5), 10);
        assert!(plan_review_rule(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 20).is_empty());
    }

    #[test]
    fn two_ticks_at_once_act_once() {
        let file = std::env::temp_dir().join(format!("tori-review-rule-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&file);
        with_project(&file, "/r", |p| plan_review_rule(p, Some(&list(&[], true)), &ON(), 0)).unwrap();
        let busy = list(&[(1, "a")], true);
        let acts: Vec<Vec<Act>> = std::thread::scope(|s| {
            let runs: Vec<_> = (0..2)
                .map(|_| {
                    s.spawn(|| with_project(&file, "/r", |p| plan_review_rule(p, Some(&busy), &ON(), 10)).unwrap())
                })
                .collect();
            runs.into_iter().map(|r| r.join().unwrap()).collect()
        });
        assert_eq!(acts.concat(), [Act::Entered(1)]);
        let _ = std::fs::remove_file(&file);
    }
}
