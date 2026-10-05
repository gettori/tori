//! Approvals a person gave on an approval ask, each good for one outward call
//! by the session that asked. See [[adr_a_background_session_needs_a_tori_gate]].

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::forge::model::{DraftComment, ReviewEvent};
use crate::forge::MergeMethod;

/// The one answer that grants an approval; anything else, typed or picked, does not.
pub const APPROVE: &str = "Approve";
pub const REJECT: &str = "Reject";

/// What an outward call will post, exactly as the user is shown it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", deny_unknown_fields)]
pub enum Draft {
    #[serde(rename = "pr.create")]
    PrCreate {
        /// The branch the pull request is from, already pushed.
        head: String,
        /// The branch it merges into.
        base: String,
        /// The pull request's title.
        title: String,
        /// The pull request's body.
        body: String,
        /// Open it as a draft.
        #[serde(default)]
        draft: bool,
        /// The commit pushed as the head; the push is refused once the branch has moved on.
        #[serde(default)]
        head_sha: String,
    },
    #[serde(rename = "review.submit")]
    ReviewSubmit {
        /// The pull request's number.
        number: u64,
        /// The verdict.
        event: ReviewEvent,
        /// The review's body.
        body: String,
        /// Line comments held with the review.
        #[serde(default)]
        comments: Vec<DraftComment>,
        /// The head commit the comments were drawn against; the review is refused once the pull request has moved on.
        head_sha: String,
    },
    #[serde(rename = "pr.merge")]
    PrMerge {
        /// The pull request's number.
        number: u64,
        /// How to land it.
        method: MergeMethod,
        /// The head commit to land; the host refuses once the branch has moved on.
        head_sha: String,
    },
}

impl Draft {
    pub fn action(&self) -> &'static str {
        match self {
            Draft::PrCreate { .. } => "pr.create",
            Draft::ReviewSubmit { .. } => "review.submit",
            Draft::PrMerge { .. } => "pr.merge",
        }
    }

    pub fn target(&self) -> String {
        match self {
            Draft::PrCreate {
                head, base, head_sha, ..
            } => format!("a pull request from {head} at {head_sha} into {base}"),
            Draft::ReviewSubmit {
                number,
                event,
                head_sha,
                ..
            } => format!("a {event:?} review on #{number} at {head_sha}"),
            Draft::PrMerge { number, head_sha, .. } => format!("merging #{number} at {head_sha}"),
        }
    }
}

/// An approval ask's subject, carried on the ask so its card can show the draft.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Approval {
    pub project: String,
    #[serde(flatten)]
    pub draft: Draft,
}

struct Granted {
    session: String,
    approval: Approval,
    in_use: bool,
}

#[derive(Default)]
pub struct Approvals {
    granted: Mutex<HashMap<String, Granted>>,
}

impl Approvals {
    pub fn grant(&self, session: &str, approval: Approval) -> String {
        let id = format!("appr-{}", crate::chat::approval::random_token());
        self.granted().insert(
            id.clone(),
            Granted {
                session: session.to_string(),
                approval,
                in_use: false,
            },
        );
        id
    }

    pub fn reserve(&self, id: Option<&str>, session: &str, wanted: &Approval) -> Result<String, String> {
        let id = id.ok_or("no approval_id was passed")?;
        let mut granted = self.granted();
        let held = granted
            .get_mut(id)
            .ok_or_else(|| format!("approval {id} is unknown or already spent"))?;
        if held.session != session {
            return Err(format!("approval {id} was given to another session"));
        }
        if held.in_use {
            return Err(format!("approval {id} is held by a call still running"));
        }
        let given = &held.approval;
        if given.draft.action() != wanted.draft.action()
            || given.draft.target() != wanted.draft.target()
            || given.project != wanted.project
        {
            return Err(format!(
                "approval {id} was given for {} {} in {}",
                given.draft.action(),
                given.draft.target(),
                given.project
            ));
        }
        if given.draft != wanted.draft {
            return Err(format!(
                "approval {id} was given for a different draft; ask again with the one you mean to post"
            ));
        }
        held.in_use = true;
        Ok(id.to_string())
    }

    pub fn spend(&self, id: &str) {
        self.granted().remove(id);
    }

    pub fn release(&self, id: &str) {
        if let Some(held) = self.granted().get_mut(id) {
            held.in_use = false;
        }
    }

    pub fn forget_session(&self, session: &str) {
        self.granted().retain(|_, g| g.session != session);
    }

    fn granted(&self) -> MutexGuard<'_, HashMap<String, Granted>> {
        self.granted.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(body: &str) -> Approval {
        Approval {
            project: "/p".into(),
            draft: Draft::PrCreate {
                head: "1-x".into(),
                base: "main".into(),
                title: "T".into(),
                body: body.into(),
                draft: false,
                head_sha: "abc".into(),
            },
        }
    }

    #[test]
    fn an_approval_is_spent_once() {
        let approvals = Approvals::default();
        let id = approvals.grant("s1", pr("b"));
        assert_eq!(approvals.reserve(Some(&id), "s1", &pr("b")), Ok(id.clone()));
        assert!(approvals
            .reserve(Some(&id), "s1", &pr("b"))
            .unwrap_err()
            .contains("still running"));
        approvals.spend(&id);
        assert!(approvals
            .reserve(Some(&id), "s1", &pr("b"))
            .unwrap_err()
            .contains("unknown or already spent"));
    }

    #[test]
    fn a_failed_call_releases_the_approval_for_a_retry() {
        let approvals = Approvals::default();
        let id = approvals.grant("s1", pr("b"));
        approvals.reserve(Some(&id), "s1", &pr("b")).unwrap();
        approvals.release(&id);
        assert!(approvals.reserve(Some(&id), "s1", &pr("b")).is_ok());
    }

    #[test]
    fn an_approval_binds_the_session_the_action_the_target_and_the_draft() {
        let approvals = Approvals::default();
        let id = approvals.grant("s1", pr("b"));
        assert!(approvals
            .reserve(None, "s1", &pr("b"))
            .unwrap_err()
            .contains("no approval_id"));
        assert!(approvals
            .reserve(Some(&id), "s2", &pr("b"))
            .unwrap_err()
            .contains("another session"));
        let merge = Approval {
            project: "/p".into(),
            draft: Draft::PrMerge {
                number: 7,
                method: MergeMethod::Squash,
                head_sha: "abc".into(),
            },
        };
        assert!(approvals
            .reserve(Some(&id), "s1", &merge)
            .unwrap_err()
            .contains("given for pr.create"));
        let elsewhere = Approval {
            project: "/q".into(),
            ..pr("b")
        };
        assert!(approvals
            .reserve(Some(&id), "s1", &elsewhere)
            .unwrap_err()
            .contains("in /p"));
        assert!(approvals
            .reserve(Some(&id), "s1", &pr("changed"))
            .unwrap_err()
            .contains("different draft"));
        assert!(
            approvals.reserve(Some(&id), "s1", &pr("b")).is_ok(),
            "none of the misses spent it"
        );
    }

    #[test]
    fn a_sessions_end_drops_its_approvals() {
        let approvals = Approvals::default();
        let id = approvals.grant("s1", pr("b"));
        approvals.forget_session("s1");
        assert!(approvals.reserve(Some(&id), "s1", &pr("b")).is_err());
    }
}
