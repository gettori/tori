//! The fix loop's side of an autopilot item's own pull request watch.

use super::pr_watch::{self, News, Watch};
use super::watcher::What;
use crate::autopilot::{Item, Kind};

#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub reruns: Vec<(u64, String)>,
    pub whats: Vec<What>,
}

pub fn check_failed(name: &str, run_id: &str) -> What {
    What::CheckFailed(format!("{}, run {}", pr_watch::clean(name), pr_watch::clean(run_id)))
}

pub fn plan(next: &mut Watch, stop_on_review: bool) -> Plan {
    let mut plan = Plan::default();
    for news in std::mem::take(&mut next.pending) {
        match news {
            News::CheckFailed { name, run_id, .. } => match run_id.parse::<u64>() {
                Ok(id) if !next.reran.contains(&name) => {
                    next.reran.insert(name.clone());
                    plan.reruns.push((id, name));
                }
                _ => plan.whats.push(check_failed(&name, &run_id)),
            },
            News::Passed => plan.whats.push(What::ChecksPassed),
            News::Conflicting => plan.whats.push(What::Conflicting),
            News::Remark { bot: true, .. } => {}
            News::Remark { author, review, .. } => {
                let approval = review.as_deref() == Some("approved");
                if stop_on_review && !approval && next.stopped.is_none() {
                    next.stopped = Some(author.clone());
                }
                let author = pr_watch::clean(&author);
                plan.whats.push(What::Remark(match review {
                    Some(verdict) => format!("@{author}, {}", pr_watch::clean(&verdict)),
                    None => format!("@{author}"),
                }));
            }
            News::Ended { why } => plan.whats.push(What::Pr(why)),
        }
    }
    plan
}

pub fn mark_stopped(row: &mut serde_json::Value, watches: &[Watch]) {
    let Some(id) = row["id"].as_str() else { return };
    let stopped = watches
        .iter()
        .find(|w| w.item.as_deref() == Some(id))
        .and_then(|w| w.stopped.clone());
    if let Some(who) = stopped {
        row["fix_stopped"] = serde_json::json!(who);
    }
}

pub fn wants_watch(item: &Item, loop_on: bool) -> bool {
    loop_on
        && item.kind == Kind::Ship
        && !item.state.terminal()
        && item
            .pr_url
            .as_deref()
            .is_some_and(|url| pr_watch::parse_url(url).is_some())
}

// The watches to start for `items` and the item ids whose watch should go.
pub fn reconcile(
    items: &[Item],
    watches: &[Watch],
    loop_on: impl Fn(&str) -> bool,
    now: u64,
) -> (Vec<Watch>, Vec<String>) {
    let held = |id: &str| watches.iter().any(|w| w.item.as_deref() == Some(id));
    let wanted: Vec<&Item> = items.iter().filter(|i| wants_watch(i, loop_on(&i.project))).collect();
    let start = wanted
        .iter()
        .filter(|i| !held(&i.id))
        .map(|i| {
            let branch = i
                .worktree
                .as_deref()
                .and_then(crate::git::current_branch)
                .unwrap_or_default();
            Watch::for_item(&i.id, i.pr_url.as_deref().unwrap_or_default(), &i.project, &branch, now)
        })
        .collect();
    let gone = watches
        .iter()
        .filter_map(|w| w.item.clone())
        .filter(|id| !wanted.iter().any(|i| i.id == *id))
        .collect();
    (start, gone)
}

fn loop_on(project: &str) -> bool {
    crate::settings::pr_fix_loop(project).is_some()
}

pub fn sync(items: &[Item]) {
    let store = pr_watch::store();
    let (start, gone) = reconcile(items, &store.list(), loop_on, crate::owned_state::now_ms());
    let moved = !start.is_empty() || !gone.is_empty();
    if let Err(e) = store.update(|_| start) {
        eprintln!("tori: fix loop watch not started: {e}");
    }
    for item in gone {
        if let Err(e) = store.remove_item(&item) {
            eprintln!("tori: fix loop watch not dropped: {e}");
        }
    }
    if moved {
        pr_watch::polled_moved();
    }
}

pub fn sync_item(item: &Item) {
    let store = pr_watch::store();
    let held = store.list().iter().any(|w| w.item.as_deref() == Some(item.id.as_str()));
    let moved = match (wants_watch(item, loop_on(&item.project)), held) {
        (true, false) => {
            let (start, _) = reconcile(std::slice::from_ref(item), &[], |_| true, crate::owned_state::now_ms());
            store.update(|_| start).map(|()| true)
        }
        (false, true) => store.remove_item(&item.id),
        _ => Ok(false),
    };
    match moved {
        Ok(true) => pr_watch::polled_moved(),
        Ok(false) => {}
        Err(e) => eprintln!("tori: fix loop watch not kept in step: {e}"),
    }
}

fn rerun_or_tell(project: &str, id: u64, name: &str) -> Option<What> {
    let failed = crate::forge::commands::rerun_check(project, id).err()?;
    eprintln!("tori: check {name} not rerun: {failed}");
    Some(check_failed(name, &id.to_string()))
}

pub fn tick() {
    let mut planned = Vec::new();
    let mut stopped = Vec::new();
    let saved = pr_watch::store().update(|watches| {
        watches
            .iter()
            .filter(|w| w.item.is_some() && !w.pending.is_empty())
            .map(|w| {
                let stop = crate::settings::pr_fix_loop(&w.project).is_some_and(|l| l.stop_on_review);
                let mut next = w.clone();
                let plan = plan(&mut next, stop);
                if next.stopped != w.stopped {
                    stopped.extend(w.item.clone());
                }
                planned.push((w.item.clone().unwrap_or_default(), w.project.clone(), plan));
                next
            })
            .collect()
    });
    if let Err(e) = saved {
        return eprintln!("tori: fix loop news not saved: {e}");
    }
    if let Some(office) = crate::rpc::office() {
        stopped.iter().for_each(|item| office.republish_item(item));
    }
    for (item, project, mut plan) in planned {
        let told: Vec<What> = plan
            .reruns
            .iter()
            .filter_map(|(id, name)| rerun_or_tell(&project, *id, name))
            .collect();
        plan.whats.extend(told);
        super::watcher_fix_news(&item, plan.whats);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autopilot::State;

    fn watch(pending: Vec<News>) -> Watch {
        let mut w = Watch::for_item("i1", "https://github.com/o/r/pull/7", "/p", "fix", 1);
        w.pending = pending;
        w
    }

    fn failed(name: &str, run_id: &str) -> News {
        News::CheckFailed {
            name: name.into(),
            url: None,
            run_id: run_id.into(),
        }
    }

    fn remark(author: &str, review: Option<&str>, bot: bool) -> News {
        News::Remark {
            author: author.into(),
            body: "b".into(),
            review: review.map(str::to_string),
            bot,
        }
    }

    #[test]
    fn a_failed_job_is_rerun_once_before_it_is_told() {
        let mut w = watch(vec![failed("test", "11")]);
        let first = plan(&mut w, true);
        assert_eq!(first.reruns, vec![(11, "test".to_string())]);
        assert!(first.whats.is_empty(), "nothing wakes on the first failure");
        assert!(w.pending.is_empty());

        w.pending = vec![failed("test", "12")];
        let second = plan(&mut w, true);
        assert!(second.reruns.is_empty());
        assert_eq!(second.whats, vec![check_failed("test", "12")]);
    }

    #[test]
    fn a_new_head_lets_a_check_be_rerun_again() {
        let mut next = watch(vec![failed("test", "11")]);
        plan(&mut next, true);
        next.compare(&pr_watch::Snapshot {
            state: pr_watch::PrState::Open,
            head_sha: "new".into(),
            mergeable: pr_watch::Mergeable::Mergeable,
            checks: None,
            remarks: None,
        });
        next.pending = vec![failed("test", "13")];
        assert_eq!(plan(&mut next, true).reruns, vec![(13, "test".to_string())]);
    }

    #[test]
    fn a_status_context_has_no_job_to_rerun_and_is_told_at_once() {
        let mut w = watch(vec![failed("ci/legacy", "SC_kw1")]);
        let p = plan(&mut w, true);
        assert!(p.reruns.is_empty());
        assert_eq!(p.whats, vec![check_failed("ci/legacy", "SC_kw1")]);
    }

    #[test]
    fn only_a_persons_remark_that_is_not_an_approval_stops_the_loop() {
        let mut next = watch(vec![remark("codecov", None, true)]);
        let p = plan(&mut next, true);
        assert_eq!(next.stopped, None, "a bot");
        assert!(p.whats.is_empty(), "and it is not told");

        let mut next = watch(vec![remark("ana", Some("approved"), false)]);
        let p = plan(&mut next, true);
        assert_eq!(next.stopped, None, "an approval");
        assert_eq!(p.whats, vec![What::Remark("@ana, approved".into())]);

        let mut next = watch(vec![remark("ana", None, false)]);
        let _ = plan(&mut next, false);
        assert_eq!(next.stopped, None, "stop on review is off");

        let mut next = watch(vec![remark("ana", None, false)]);
        let p = plan(&mut next, true);
        assert_eq!(next.stopped.as_deref(), Some("ana"));
        assert_eq!(p.whats, vec![What::Remark("@ana".into())]);
    }

    #[test]
    fn passing_conflicting_and_ending_are_told_as_they_are() {
        let news = vec![News::Passed, News::Conflicting, News::Ended { why: "merged".into() }];
        let mut w = watch(news);
        let p = plan(&mut w, true);
        assert_eq!(
            p.whats,
            vec![What::ChecksPassed, What::Conflicting, What::Pr("merged".into())]
        );
    }

    fn item(id: &str, kind: Kind, state: State, pr: Option<&str>) -> Item {
        let mut i = crate::autopilot::tests::item(id, state);
        i.kind = kind;
        i.pr_url = pr.map(str::to_string);
        i
    }

    #[test]
    fn an_open_ship_item_with_a_pull_request_in_a_loop_project_gets_a_watch() {
        let url = "https://github.com/o/r/pull/7";
        let pr = Some(url);
        let items = vec![
            item("ship", Kind::Ship, State::Running, pr),
            item("review", Kind::Review, State::Running, pr),
            item("done", Kind::Ship, State::Done, pr),
            item("nopr", Kind::Ship, State::Running, None),
        ];
        let (start, gone) = reconcile(&items, &[], |_| true, 5);
        assert_eq!(
            start.iter().map(|w| w.item.as_deref()).collect::<Vec<_>>(),
            vec![Some("ship")]
        );
        assert!(gone.is_empty());
        assert!(reconcile(&items, &[], |_| false, 5).0.is_empty(), "loop off");

        let held = vec![Watch::for_item("ship", url, "/p", "fix", 1)];
        let (start, gone) = reconcile(&items, &held, |_| true, 5);
        assert!(start.is_empty(), "already held");
        assert!(gone.is_empty());

        let closed = vec![item("ship", Kind::Ship, State::Done, pr)];
        assert_eq!(reconcile(&closed, &held, |_| true, 5).1, vec!["ship".to_string()]);
        assert_eq!(
            reconcile(&items, &held, |_| false, 5).1,
            vec!["ship".to_string()],
            "loop turned off"
        );
    }

    #[test]
    fn a_row_names_who_stopped_its_loop() {
        let mut stopped = Watch::for_item("i1", "https://github.com/o/r/pull/7", "/p", "fix", 1);
        stopped.stopped = Some("ana".into());
        let running = Watch::for_item("i2", "https://github.com/o/r/pull/8", "/p", "fix", 1);
        let watches = [stopped, running];
        let mut row = serde_json::json!({ "id": "i1" });
        mark_stopped(&mut row, &watches);
        assert_eq!(row["fix_stopped"], "ana");
        let mut row = serde_json::json!({ "id": "i2" });
        mark_stopped(&mut row, &watches);
        assert!(row.get("fix_stopped").is_none());
    }
}
