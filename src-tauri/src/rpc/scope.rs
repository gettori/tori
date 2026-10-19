//! The browser's reach. A tab speaks for the worktree its dev server runs in,
//! so the browser touches only the sessions that belong to that worktree: the
//! deepest configured unit holding a session's folder.

use serde_json::Value;

use super::auth::Principal;
use super::frame::{Request, RpcError, INVALID_PARAMS, REFUSED};
use super::server::Backend;
use super::table::Method;

enum Reach {
    Free,
    Session,
    Ask,
    List,
    Worktree,
}

fn reach(method: &str) -> Option<Reach> {
    match method {
        "caller" | "projects.list" | "ports.list" | "worktree.at" | "attachment.write" => Some(Reach::Free),
        "session.steer" | "session.tail" | "session.pending" | "window.reveal" => Some(Reach::Session),
        "ask.answer" => Some(Reach::Ask),
        "sessions.list" => Some(Reach::List),
        "chat.draft" | "web.setup" => Some(Reach::Worktree),
        _ => None,
    }
}

fn refuse(message: String) -> RpcError {
    RpcError::new(REFUSED, message)
}

fn tag(req: &Request) -> Result<&str, RpcError> {
    req.worktree
        .as_deref()
        .ok_or_else(|| refuse(format!("{} needs a tab on a Tori worktree", req.method)))
}

fn owns(backend: &dyn Backend, session: &str, tag: &str) -> Result<(), RpcError> {
    match backend.session_unit(session) {
        Some(unit) if unit == tag => Ok(()),
        _ => Err(refuse(format!("{session} is not a session of this tab's worktree"))),
    }
}

pub(super) fn call(
    backend: &dyn Backend,
    method: &Method,
    principal: &Principal,
    req: &Request,
) -> Result<Value, RpcError> {
    let reach = reach(method.name).ok_or_else(|| refuse(format!("{} has no browser scope", method.name)))?;
    let id = || req.params["id"].as_str().unwrap_or_default();
    match reach {
        Reach::Free => {}
        Reach::Session => owns(backend, id(), tag(req)?)?,
        Reach::Ask => {
            let tag = tag(req)?;
            let session = backend
                .ask_session(id())
                .ok_or_else(|| refuse(format!("no ask {}, or it was already answered", id())))?;
            owns(backend, &session, tag)?;
        }
        Reach::List => {
            let tag = tag(req)?;
            let rows = (method.call)(backend, principal, &req.params)?;
            let mine = |row: &Value| {
                let cwd = row["cwd"].as_str().unwrap_or_default();
                backend.folder_unit(cwd).as_deref() == Some(tag)
            };
            return Ok(match rows {
                Value::Array(rows) => Value::Array(rows.into_iter().filter(mine).collect()),
                other => other,
            });
        }
        Reach::Worktree => {
            let mut params = req.params.clone();
            params
                .as_object_mut()
                .ok_or_else(|| RpcError::new(INVALID_PARAMS, "params must be an object"))?
                .insert("folder".into(), Value::String(tag(req)?.into()));
            return (method.call)(backend, principal, &params);
        }
    }
    (method.call)(backend, principal, &req.params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::server::tests::StubBackend;
    use crate::rpc::server::Server;
    use crate::rpc::table::{CallerKind, METHODS};
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;

    const APP: &str = "/w/app";
    const NESTED: &str = "/w/app/.tori/worktrees/x";

    fn server(sessions: Option<Value>) -> Server {
        Server {
            hub: Arc::default(),
            backend: Box::new(StubBackend {
                sessions,
                ..StubBackend::default()
            }),
            auth_timeout: Duration::from_secs(1),
        }
    }

    fn browser(method: &str, params: Value, worktree: Option<&str>) -> Result<Value, RpcError> {
        let req = Request {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: method.into(),
            params,
            worktree: worktree.map(String::from),
        };
        server(None).call(&Principal::Browser("b1".into()), &req)
    }

    fn steer(session: &str, worktree: Option<&str>) -> Result<Value, RpcError> {
        browser("session.steer", json!({ "id": session, "text": "hi" }), worktree)
    }

    #[test]
    fn a_session_of_the_tabs_worktree_is_reached() {
        assert_eq!(
            steer("c1@/w/app/src", Some(APP)).unwrap(),
            json!({ "id": "c1@/w/app/src" })
        );
        assert!(browser("session.tail", json!({ "id": "c1@/w/app" }), Some(APP)).is_ok());
        assert!(browser("session.pending", json!({ "id": "c1@/w/app" }), Some(APP)).is_ok());
        assert!(browser("window.reveal", json!({ "id": "c1@/w/app" }), Some(APP)).is_ok());
        assert!(browser("ask.answer", json!({ "id": "q1@/w/app", "answer": "yes" }), Some(APP)).is_ok());
    }

    #[test]
    fn a_nested_worktrees_session_is_not_the_main_checkouts() {
        let session = format!("c1@{NESTED}/src");
        assert_eq!(steer(&session, Some(APP)).unwrap_err().code, REFUSED);
        assert!(steer(&session, Some(NESTED)).is_ok());
    }

    #[test]
    fn another_projects_session_is_refused() {
        assert_eq!(steer("c1@/w/web", Some(APP)).unwrap_err().code, REFUSED);
        let ask = browser("ask.answer", json!({ "id": "q1@/w/web", "answer": "yes" }), Some(APP));
        assert_eq!(ask.unwrap_err().code, REFUSED);
    }

    #[test]
    fn a_tab_on_no_worktree_reaches_no_session() {
        assert_eq!(steer("c1@/w/app", None).unwrap_err().code, REFUSED);
        assert_eq!(browser("sessions.list", json!({}), None).unwrap_err().code, REFUSED);
        assert!(browser("projects.list", json!({}), None).is_ok());
    }

    #[test]
    fn the_list_holds_only_the_tabs_worktree() {
        let rows = json!([
            { "id": "a", "cwd": "/w/app" },
            { "id": "b", "cwd": NESTED },
            { "id": "c", "cwd": "/w/web" },
            { "id": "d", "cwd": "/w/app/src" },
        ]);
        let req = Request {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "sessions.list".into(),
            params: json!({}),
            worktree: Some(APP.into()),
        };
        let listed = server(Some(rows)).call(&Principal::Browser("b1".into()), &req).unwrap();
        assert_eq!(
            listed,
            json!([{ "id": "a", "cwd": "/w/app" }, { "id": "d", "cwd": "/w/app/src" }])
        );
    }

    #[test]
    fn a_draft_opens_in_the_tabs_worktree_whatever_it_names() {
        let draft = |params: Value, worktree| browser("chat.draft", params, worktree);
        let named = draft(json!({ "text": "hi", "folder": "/w/web" }), Some(APP)).unwrap();
        assert_eq!(named, json!({ "folder": APP }));
        assert_eq!(draft(json!({ "text": "hi" }), None).unwrap_err().code, REFUSED);
    }

    #[test]
    fn only_the_browser_is_scoped() {
        let req = Request {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "session.steer".into(),
            params: json!({ "id": "c1@/w/web", "text": "hi" }),
            worktree: Some(APP.into()),
        };
        assert!(server(None).call(&Principal::Local, &req).is_ok());
    }

    #[test]
    fn attachment_write_is_the_browsers_alone() {
        let params = json!({ "name": "a.png", "data": "" });
        assert!(browser("attachment.write", params.clone(), None).is_ok());
        use crate::rpc::auth::Caller;
        let others = [
            Principal::Local,
            Principal::Session(Caller::Terminal("t1".into())),
            Principal::Session(Caller::Chat("s1".into())),
            Principal::Session(Caller::Chat(crate::rpc::server::tests::WORKER.into())),
            Principal::Device("d1".into()),
        ];
        for principal in others {
            let req = Request {
                jsonrpc: "2.0".into(),
                id: Some(json!(1)),
                method: "attachment.write".into(),
                params: params.clone(),
                worktree: None,
            };
            assert_eq!(server(None).call(&principal, &req).unwrap_err().code, REFUSED);
        }
    }

    #[test]
    fn every_method_open_to_the_browser_has_a_reach() {
        for method in METHODS.iter().filter(|m| m.callers.contains(&CallerKind::Browser)) {
            assert!(
                reach(method.name).is_some(),
                "{} is open to the browser with no reach",
                method.name
            );
        }
    }
}
