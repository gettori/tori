//! The project review rule: when a pull request asks for your review, make its
//! review worktree, and with `review` start a read-only session on it. Deciding
//! is pure over what the rule has seen; this file also keeps that on disk and
//! runs the tick that acts on it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::issues::commands::ReviewRequests;
use crate::settings::{ReviewAction, ReviewRule};
use crate::worktree::{ReviewHead, ReviewMove};

const HOUR_SECS: u64 = 3600;

pub const DEFAULT_PROMPT: &str = "Review this pull request against its base branch. Read the change, run nothing that writes, and do not edit, commit, push or post anything.

Look for bugs, missed cases, risky changes and anything the description promises that the code does not do. Say what is fine as plainly as what is not.

End your last message with one JSON block {\"event\", \"body\", \"comments\"}. \"event\" is \"approve\", \"comment\" or \"requestChanges\". Each comment is {\"path\", \"line\", \"side\", \"startLine\", \"startSide\", \"body\"}, with \"side\" RIGHT for a line in the new file and LEFT for a removed one, \"startLine\" and \"startSide\" only for a range, and only on lines inside the diff.";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SeenPr {
    pub head: Option<String>,
    pub listed: bool,
    pub worktree: bool,
    pub worktree_at: Option<String>,
    pub own_work: bool,
    pub session: Option<String>,
    pub move_held: bool,
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

impl Act {
    fn number(self) -> u64 {
        match self {
            Act::Entered(n) | Act::Moved(n) => n,
        }
    }
}

pub fn plan_review_rule(
    seen: &mut SeenProject,
    list: Option<&ReviewRequests>,
    rule: &ReviewRule,
    now: u64,
    busy: impl Fn(&str) -> bool,
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
        } else if pr.move_held
            || (rule.action == ReviewAction::Review
                && pr.worktree
                && !pr.own_work
                && head.is_some()
                && pr.head != *head)
        {
            wanted.push(Act::Moved(number));
        }
        pr.listed = true;
        pr.head = head.clone();
    }
    for (number, pr) in seen.prs.iter_mut() {
        if !rows.contains_key(number) {
            pr.listed = false;
            pr.move_held = false;
            pr.own_work = false;
        }
    }
    if first || seen.paused {
        return Vec::new();
    }
    seen.fired.retain(|&t| t + HOUR_SECS > now);
    let mut acts = Vec::new();
    for act in wanted {
        let pr = seen.prs.entry(act.number()).or_default();
        if pr.worktree && pr.session.as_deref().is_some_and(&busy) {
            pr.move_held = true;
            continue;
        }
        if seen.fired.len() >= rule.max_per_hour as usize {
            seen.paused = true;
            break;
        }
        pr.move_held = false;
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
    let busy = |session: &str| crate::rpc::session_mid_turn(app, session);
    let planned = with_project(&file, project, |p| {
        let was = p.paused;
        (plan_review_rule(p, list, &rule, now_secs(), busy), !was && p.paused)
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
    let Some(list) = list.filter(|_| !acts.is_empty()) else {
        return;
    };
    let (app, project, list) = (app.clone(), project.to_string(), list.clone());
    std::thread::spawn(move || {
        for act in acts {
            let number = act.number();
            if let Err(e) = review(&app, &project, &rule, &list, number) {
                eprintln!("tori: review rule on #{number}: {e}");
            }
        }
    });
}

fn review(app: &AppHandle, project: &str, rule: &ReviewRule, list: &ReviewRequests, number: u64) -> Result<(), String> {
    // Without a review to re-run, new pushes are the reader's to pull.
    if rule.action != ReviewAction::Review && crate::worktree::review_worktree(project, number).is_some() {
        return Ok(());
    }
    let file = store_path();
    let head = crate::worktree::review_head(project, number).map_err(|e| e.to_string())?;
    let before = with_project(&file, project, |p| p.prs.get(&number).cloned().unwrap_or_default())?;
    let placed = worktree_for(app, project, &head, before.worktree_at.as_deref());
    let own_work = matches!(placed, Ok((_, Some(ReviewMove::OwnWork(_)))));
    with_project(&file, project, |p| {
        let pr = p.prs.entry(number).or_default();
        pr.own_work = own_work;
        if placed.is_ok() && !own_work {
            pr.worktree = true;
            pr.worktree_at = Some(head.sha.clone());
        }
    })?;
    let (folder, from) = match placed? {
        (_, Some(ReviewMove::OwnWork(why))) => return Err(why),
        (folder, Some(ReviewMove::Moved { from })) => (folder, Some(from)),
        (folder, None) => (folder, None),
    };
    if rule.action != ReviewAction::Review {
        return Ok(());
    }
    let live = before.session.filter(|s| crate::rpc::session_live(app, s));
    let session = match (&from, live) {
        (Some(from), Some(session)) => {
            crate::rpc::steer_idle(app, &session, "review_rule", &again(&head, from))?;
            session
        }
        _ => {
            let row = list.rows.iter().find(|r| r.key == number.to_string());
            let prompt = first(rule, &head, row.map_or("", |r| r.title.as_str()), from.as_deref());
            let session = crate::rpc::spawn_review(app, &folder, project, prompt)?;
            with_project(&file, project, |p| {
                p.prs.entry(number).or_default().session = Some(session.clone())
            })?;
            session
        }
    };
    if !crate::settings::autopilot().available {
        return Ok(());
    }
    let row = list.rows.iter().find(|r| r.key == number.to_string());
    let review = crate::autopilot::RuleReview {
        number,
        url: row.map(|r| r.url.clone()).unwrap_or_default(),
        title: row.map(|r| r.title.clone()).unwrap_or_default(),
        worktree: folder,
        session: Some(session),
    };
    crate::rpc::record_rule_review(app, project, &list.full_name, &list.account, review)
}

// `None` for a worktree made just now; a worktree already there is a re-review.
fn worktree_for(
    app: &AppHandle,
    project: &str,
    head: &ReviewHead,
    worktree_at: Option<&str>,
) -> Result<(String, Option<ReviewMove>), String> {
    match crate::worktree::review_worktree(project, head.number) {
        Some(folder) => {
            let moved = crate::worktree::move_review(app, project, head, &folder, worktree_at)?;
            Ok((folder, Some(moved)))
        }
        None => Ok((crate::worktree::checkout_review(app, project, head)?, None)),
    }
}

fn first(rule: &ReviewRule, head: &ReviewHead, title: &str, earlier: Option<&str>) -> String {
    let ask = rule.prompt.as_deref().unwrap_or(DEFAULT_PROMPT);
    let mut prompt = format!(
        "Pull request #{}: {title}\nBase branch: {}. Head commit: {}.\n\n{ask}",
        head.number, head.base_ref, head.sha
    );
    if let Some(earlier) = earlier.filter(|e| *e != head.sha) {
        prompt.push_str(&format!(
            "\n\nAn earlier review read it at {earlier}. Look hardest at what changed since."
        ));
    }
    prompt
}

fn again(head: &ReviewHead, from: &str) -> String {
    let n = head.number;
    let sha = &head.sha;
    if from == sha {
        return format!(
            "Your review of pull request #{n} was asked for again, still at {sha}. Look again, then end your last message with the JSON block as before."
        );
    }
    format!(
        "The author pushed. Pull request #{n} is now at {sha} and this worktree is on it. Review what changed since {from} (git diff {from} {sha}), then end your last message with the JSON block as before."
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleState {
    pub paused: bool,
    pub default_prompt: &'static str,
}

#[tauri::command]
pub fn review_rule_state(project_path: String) -> RuleState {
    let seen = load(&store_path());
    RuleState {
        paused: seen.0.get(&key(&project_path)).is_some_and(|p| p.paused),
        default_prompt: DEFAULT_PROMPT,
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
            account: "me".into(),
            full_name: "o/r".into(),
        }
    }

    fn plan(seen: &mut SeenProject, list: Option<&ReviewRequests>, rule: &ReviewRule, now: u64) -> Vec<Act> {
        plan_review_rule(seen, list, rule, now, |_| false)
    }

    const ON: fn() -> ReviewRule = || rule(ReviewAction::Worktree, 5);

    #[test]
    fn the_first_tick_records_what_was_waiting_and_a_new_entry_acts() {
        let mut seen = SeenProject::default();
        assert!(plan(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0).is_empty());
        let acts = plan(&mut seen, Some(&list(&[(1, "a"), (2, "b")], true)), &ON(), 10);
        assert_eq!(acts, [Act::Entered(2)]);
        assert!(plan(&mut seen, Some(&list(&[(1, "a"), (2, "b")], true)), &ON(), 20).is_empty());
    }

    #[test]
    fn leaving_and_coming_back_acts_again() {
        let mut seen = SeenProject::default();
        plan(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0);
        plan(&mut seen, Some(&list(&[], true)), &ON(), 10);
        assert_eq!(
            plan(&mut seen, Some(&list(&[(1, "b")], true)), &ON(), 20),
            [Act::Entered(1)]
        );
    }

    #[test]
    fn a_head_change_while_listed_acts_only_over_a_rule_worktree() {
        let mut seen = SeenProject::default();
        let review = rule(ReviewAction::Review, 5);
        plan(&mut seen, Some(&list(&[(1, "a")], true)), &review, 0);
        assert!(plan(&mut seen, Some(&list(&[(1, "b")], true)), &review, 10).is_empty());
        seen.prs.get_mut(&1).unwrap().worktree = true;
        assert_eq!(
            plan(&mut seen, Some(&list(&[(1, "c")], true)), &review, 20),
            [Act::Moved(1)]
        );
    }

    #[test]
    fn create_a_worktree_leaves_a_push_to_the_reader() {
        let mut seen = SeenProject::default();
        plan(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0);
        seen.prs.get_mut(&1).unwrap().worktree = true;
        assert!(plan(&mut seen, Some(&list(&[(1, "b")], true)), &ON(), 10).is_empty());
    }

    #[test]
    fn a_missing_failed_or_capped_list_changes_nothing() {
        let mut seen = SeenProject::default();
        plan(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0);
        let before = seen.clone();
        assert!(plan(&mut seen, None, &ON(), 10).is_empty());
        assert!(plan(&mut seen, Some(&list(&[(2, "b")], false)), &ON(), 20).is_empty());
        assert_eq!(seen, before);
        assert!(
            plan(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 30).is_empty(),
            "a good tick after the gap fires nothing for what never left"
        );
    }

    #[test]
    fn the_cap_pauses_the_rule_and_a_paused_rule_only_records() {
        let mut seen = SeenProject::default();
        let two = rule(ReviewAction::Worktree, 2);
        plan(&mut seen, Some(&list(&[], true)), &two, 0);
        let acts = plan(&mut seen, Some(&list(&[(1, "a"), (2, "b"), (3, "c")], true)), &two, 10);
        assert_eq!(acts, [Act::Entered(1), Act::Entered(2)]);
        assert!(seen.paused);
        assert!(plan(
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
        plan(&mut seen, Some(&list(&[], true)), &ON(), 0);
        plan(&mut seen, Some(&list(&[], true)), &rule(ReviewAction::Off, 5), 10);
        assert!(plan(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 20).is_empty());
    }

    #[test]
    fn two_ticks_at_once_act_once() {
        let file = std::env::temp_dir().join(format!("tori-review-rule-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&file);
        with_project(&file, "/r", |p| plan(p, Some(&list(&[], true)), &ON(), 0)).unwrap();
        let busy = list(&[(1, "a")], true);
        let acts: Vec<Vec<Act>> = std::thread::scope(|s| {
            let runs: Vec<_> = (0..2)
                .map(|_| s.spawn(|| with_project(&file, "/r", |p| plan(p, Some(&busy), &ON(), 10)).unwrap()))
                .collect();
            runs.into_iter().map(|r| r.join().unwrap()).collect()
        });
        assert_eq!(acts.concat(), [Act::Entered(1)]);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_re_review_waits_while_its_session_is_mid_turn_and_fires_once_idle() {
        let mut seen = SeenProject::default();
        plan(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0);
        let pr = seen.prs.get_mut(&1).unwrap();
        pr.worktree = true;
        pr.session = Some("s1".into());
        let two = rule(ReviewAction::Review, 1);
        let held = plan_review_rule(&mut seen, Some(&list(&[(1, "b")], true)), &two, 10, |s| s == "s1");
        assert!(held.is_empty());
        assert!(
            seen.prs[&1].move_held && seen.fired.is_empty(),
            "a held move spends nothing"
        );
        let still = plan_review_rule(&mut seen, Some(&list(&[(1, "b")], true)), &two, 20, |s| s == "s1");
        assert!(still.is_empty());
        let idle = plan_review_rule(&mut seen, Some(&list(&[(1, "b")], true)), &two, 30, |_| false);
        assert_eq!(idle, [Act::Moved(1)]);
        assert!(!seen.prs[&1].move_held);
        assert!(plan(&mut seen, Some(&list(&[(1, "b")], true)), &two, 40).is_empty());
    }

    #[test]
    fn a_held_re_review_is_dropped_when_the_request_leaves() {
        let mut seen = SeenProject::default();
        plan(&mut seen, Some(&list(&[(1, "a")], true)), &ON(), 0);
        let pr = seen.prs.get_mut(&1).unwrap();
        pr.worktree = true;
        pr.session = Some("s1".into());
        plan_review_rule(&mut seen, Some(&list(&[(1, "b")], true)), &ON(), 10, |_| true);
        plan(&mut seen, Some(&list(&[], true)), &ON(), 20);
        assert!(!seen.prs[&1].move_held);
    }

    #[test]
    fn a_worktree_with_work_of_its_own_is_not_tried_again_on_each_push() {
        let mut seen = SeenProject::default();
        let review = rule(ReviewAction::Review, 5);
        plan(&mut seen, Some(&list(&[(1, "a")], true)), &review, 0);
        let pr = seen.prs.get_mut(&1).unwrap();
        pr.worktree = true;
        pr.own_work = true;
        assert!(plan(&mut seen, Some(&list(&[(1, "b")], true)), &review, 10).is_empty());
        plan(&mut seen, Some(&list(&[], true)), &review, 20);
        assert_eq!(
            plan(&mut seen, Some(&list(&[(1, "c")], true)), &review, 30),
            [Act::Entered(1)],
            "asked again, it is tried again"
        );
    }

    fn head(sha: &str) -> ReviewHead {
        ReviewHead {
            number: 4,
            sha: sha.into(),
            head_ref: "refs/pull/4/head".into(),
            branch: "fix".into(),
            base_ref: "main".into(),
            fork: false,
        }
    }

    #[test]
    fn the_first_prompt_names_the_pull_request_and_runs_the_rule_prompt_or_the_default() {
        let review = rule(ReviewAction::Review, 5);
        let prompt = first(&review, &head("b2"), "Fix it", None);
        assert!(prompt.starts_with("Pull request #4: Fix it\nBase branch: main. Head commit: b2."));
        assert!(prompt.ends_with(DEFAULT_PROMPT));
        let own = ReviewRule {
            prompt: Some("Only look at tests.".into()),
            ..review
        };
        let prompt = first(&own, &head("b2"), "Fix it", Some("a1"));
        assert!(prompt.contains("Only look at tests."), "{prompt}");
        assert!(prompt.contains("earlier review read it at a1"), "{prompt}");
    }

    #[test]
    fn a_steer_names_the_commit_the_last_review_read() {
        assert!(again(&head("b2"), "a1").contains("what changed since a1 (git diff a1 b2)"));
        assert!(again(&head("b2"), "b2").contains("asked for again, still at b2"));
    }
}
