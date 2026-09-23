//! The one place a connection proves who it is. A WebSocket front will carry a
//! per device credential instead of the process token, and that swap belongs
//! here and nowhere else.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::frame::{Request, RpcError, UNAUTHORIZED};

pub const AUTH_METHOD: &str = "auth";

pub struct Credential {
    // Only in the bridge file, for a process Tori did not start.
    pub process: String,
    pub children: Arc<Children>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Caller {
    // By frontend tab id.
    Terminal(String),
    // By session id.
    Chat(String),
}

// One token per spawned child, so a connection says which tab or chat it came
// from and cannot claim to be another one.
#[derive(Default)]
pub struct Children(Mutex<HashMap<String, Caller>>);

impl Children {
    pub fn mint(&self, caller: Caller) -> String {
        let token = crate::chat::approval::random_token();
        self.lock().insert(token.clone(), caller);
        token
    }

    pub fn revoke_token(&self, token: &str) {
        self.lock().remove(token);
    }

    pub fn revoke(&self, caller: &Caller) {
        self.lock().retain(|_, held| held != caller);
    }

    fn get(&self, token: &str) -> Option<Caller> {
        self.lock().get(token).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Caller>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Who is on the other end once `authenticate` has passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    /// Holds the process token from the bridge file: Tori did not start it.
    Local,
    /// Holds a token minted for one child Tori spawned.
    Session(Caller),
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    NotAnAuthFrame,
    MissingToken,
    WrongToken,
}

impl AuthError {
    pub fn rpc(&self) -> RpcError {
        let message = match self {
            AuthError::NotAnAuthFrame => "the first frame must be an auth request",
            AuthError::MissingToken => "auth needs a token",
            AuthError::WrongToken => "wrong token",
        };
        RpcError::new(UNAUTHORIZED, message)
    }
}

#[derive(Deserialize)]
struct AuthParams {
    token: Option<String>,
}

pub fn authenticate(first: &Request, credential: &Credential) -> Result<Principal, AuthError> {
    if first.method != AUTH_METHOD {
        return Err(AuthError::NotAnAuthFrame);
    }
    let token = serde_json::from_value::<AuthParams>(first.params.clone())
        .ok()
        .and_then(|p| p.token)
        .ok_or(AuthError::MissingToken)?;
    if constant_time_eq(token.as_bytes(), credential.process.as_bytes()) {
        return Ok(Principal::Local);
    }
    credential.children.get(&token).map(Principal::Session).ok_or(AuthError::WrongToken)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn req(method: &str, params: Value) -> Request {
        Request { jsonrpc: "2.0".into(), id: Some(json!(1)), method: method.into(), params }
    }

    fn cred() -> Credential {
        Credential { process: "secret".into(), children: Arc::default() }
    }

    fn auth(token: &str, credential: &Credential) -> Result<Principal, AuthError> {
        authenticate(&req("auth", json!({ "token": token })), credential)
    }

    #[test]
    fn the_right_token_is_local() {
        assert_eq!(auth("secret", &cred()), Ok(Principal::Local));
    }

    #[test]
    fn each_child_token_is_its_own_caller_until_revoked() {
        let credential = cred();
        let tab = credential.children.mint(Caller::Terminal("t1".into()));
        let chat = credential.children.mint(Caller::Chat("s1".into()));
        assert_eq!(auth(&tab, &credential), Ok(Principal::Session(Caller::Terminal("t1".into()))));
        assert_eq!(auth(&chat, &credential), Ok(Principal::Session(Caller::Chat("s1".into()))));
        assert_eq!(auth("never-minted", &credential), Err(AuthError::WrongToken));

        credential.children.revoke_token(&tab);
        assert_eq!(auth(&tab, &credential), Err(AuthError::WrongToken));
        credential.children.revoke(&Caller::Chat("s1".into()));
        assert_eq!(auth(&chat, &credential), Err(AuthError::WrongToken));
    }

    #[test]
    fn anything_else_is_refused_with_its_reason() {
        assert_eq!(authenticate(&req("auth", json!({"token": "secreT"})), &cred()), Err(AuthError::WrongToken));
        assert_eq!(authenticate(&req("auth", json!({"token": "secret-longer"})), &cred()), Err(AuthError::WrongToken));
        assert_eq!(authenticate(&req("auth", json!({})), &cred()), Err(AuthError::MissingToken));
        assert_eq!(authenticate(&req("auth", Value::Null), &cred()), Err(AuthError::MissingToken));
        assert_eq!(
            authenticate(&req("sessions.list", json!({"token": "secret"})), &cred()),
            Err(AuthError::NotAnAuthFrame)
        );
    }
}
