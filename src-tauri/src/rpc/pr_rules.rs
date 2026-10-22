use std::collections::HashMap;

use super::events::same_folder;
use super::pr_watch::{parse_url, News, Watch};
use super::states::{SessionState, Shown};
use crate::autopilot::RuleHit;
use crate::settings::{PrEvent, PrRule};

pub const HANDED_OVER: &str = "handed to the autopilot";

fn event_of(news: &News) -> Option<PrEvent> {
    match news {
        News::Remark { review: Some(r), .. } if r == "changes_requested" => Some(PrEvent::ChangesRequested),
        News::CheckFailed { .. } => Some(PrEvent::CheckFailed),
        News::Conflicting => Some(PrEvent::Conflicting),
        _ => None,
    }
}

pub fn session_ended(shown: &HashMap<String, Shown>, session: &str) -> bool {
    shown.get(session).is_none_or(|s| s.state == SessionState::Ended)
}

pub fn hits(watches: &[Watch], rules: &HashMap<String, PrRule>, gone: impl Fn(&str) -> bool) -> Vec<RuleHit> {
    watches
        .iter()
        .filter(|w| !w.ended && w.item.is_none())
        .filter_map(|w| {
            let rule = rules
                .iter()
                .find(|(project, _)| same_folder(project, &w.project))
                .map(|(_, r)| r)?;
            let event = w.pending.iter().filter_map(event_of).find(|e| rule.on.contains(e))?;
            if !gone(&w.session) {
                return None;
            }
            let (owner, repo, pr) = parse_url(&w.url)?;
            Some(RuleHit {
                session: w.session.clone(),
                project: w.project.clone(),
                url: w.url.clone(),
                repo: format!("{owner}/{repo}"),
                pr,
                event,
                max_per_hour: rule.max_per_hour,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch(session: &str, pending: Vec<News>) -> Watch {
        let mut w = Watch::new(session, "https://github.com/o/r/pull/7", "/p", "7-fix", 1);
        w.pending = pending;
        w
    }

    fn rule(on: &[PrEvent]) -> HashMap<String, PrRule> {
        HashMap::from([(
            "/p".to_string(),
            PrRule {
                on: on.to_vec(),
                max_per_hour: 3,
            },
        )])
    }

    fn review(state: &str) -> News {
        News::Remark {
            author: "x".into(),
            body: "b".into(),
            review: Some(state.into()),
            bot: false,
        }
    }

    #[test]
    fn news_the_rule_names_on_a_gone_chat_is_a_hit() {
        let found = hits(
            &[watch("s", vec![News::Passed, review("changes_requested")])],
            &rule(&[PrEvent::ChangesRequested]),
            |_| true,
        );
        assert_eq!(found.len(), 1);
        let hit = &found[0];
        assert_eq!(
            (hit.repo.as_str(), hit.pr, hit.event),
            ("o/r", 7, PrEvent::ChangesRequested)
        );
        assert_eq!(hit.session, "s");
    }

    #[test]
    fn news_the_rule_does_not_name_is_no_hit() {
        let watches = [watch("s", vec![review("approved"), News::Passed, News::Conflicting])];
        assert!(hits(
            &watches,
            &rule(&[PrEvent::ChangesRequested, PrEvent::CheckFailed]),
            |_| true
        )
        .is_empty());
        assert!(hits(&watches, &HashMap::new(), |_| true).is_empty(), "no rule, no hit");
    }

    #[test]
    fn only_a_session_not_shown_or_ended_has_ended() {
        let shown = |state| {
            HashMap::from([(
                "s".to_string(),
                Shown {
                    state,
                    source: crate::rpc::states::Source::Chat,
                    tab: None,
                    folder: None,
                },
            )])
        };
        assert!(session_ended(&HashMap::new(), "s"));
        assert!(session_ended(&shown(SessionState::Ended), "s"));
        for live in [SessionState::Idle, SessionState::Working, SessionState::NeedsYou] {
            assert!(!session_ended(&shown(live), "s"), "{live:?} is still there");
        }
    }

    #[test]
    fn a_handed_over_watch_ends_telling_the_chat_only_that() {
        let mut w = watch("s", vec![News::Conflicting, News::Passed]);
        w.hand_over(HANDED_OVER);
        assert!(w.ended);
        assert_eq!(
            w.pending,
            vec![News::Ended {
                why: HANDED_OVER.into()
            }]
        );
    }

    #[test]
    fn a_chat_still_there_keeps_its_news() {
        let watches = [watch("s", vec![News::Conflicting])];
        assert!(hits(&watches, &rule(&[PrEvent::Conflicting]), |_| false).is_empty());
    }
}
