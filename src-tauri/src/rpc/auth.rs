//! The one place a connection proves who it is. The unix socket takes the
//! process token or a child's; a network front takes only a device credential.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::devices::Devices;
use super::frame::{Request, RpcError, UNAUTHORIZED};

pub const AUTH_METHOD: &str = "auth";

/// What a front accepts, one variant per kind of front.
pub enum Credential {
    Local {
        // Only in the bridge file, for a process Tori did not start.
        process: String,
        children: Arc<Children>,
    },
    // Never the process token: a device reaches this over the network.
    Remote(Arc<Devices>),
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
    /// Holds a paired device's credential, by device id.
    Device(String),
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
    match credential {
        Credential::Local { process, children } => {
            if constant_time_eq(token.as_bytes(), process.as_bytes()) {
                return Ok(Principal::Local);
            }
            children.get(&token).map(Principal::Session).ok_or(AuthError::WrongToken)
        }
        Credential::Remote(devices) => devices.find(&token).map(Principal::Device).ok_or(AuthError::WrongToken),
    }
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
        Credential::Local { process: "secret".into(), children: Arc::default() }
    }

    fn children(credential: &Credential) -> &Children {
        match credential {
            Credential::Local { children, .. } => children,
            Credential::Remote(_) => unreachable!(),
        }
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
        let tab = children(&credential).mint(Caller::Terminal("t1".into()));
        let chat = children(&credential).mint(Caller::Chat("s1".into()));
        assert_eq!(auth(&tab, &credential), Ok(Principal::Session(Caller::Terminal("t1".into()))));
        assert_eq!(auth(&chat, &credential), Ok(Principal::Session(Caller::Chat("s1".into()))));
        assert_eq!(auth("never-minted", &credential), Err(AuthError::WrongToken));

        children(&credential).revoke_token(&tab);
        assert_eq!(auth(&tab, &credential), Err(AuthError::WrongToken));
        children(&credential).revoke(&Caller::Chat("s1".into()));
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

    #[test]
    fn each_front_takes_only_its_own_kind_of_credential() {
        let path = std::env::temp_dir()
            .join(format!("tori-auth-fronts-{}-{}", std::process::id(), crate::chat::approval::random_token()))
            .join("devices.json");
        let devices = Arc::new(Devices::open(path.clone()));
        let (device, secret) = devices.mint("phone").unwrap();
        let local = cred();
        let child = children(&local).mint(Caller::Chat("s1".into()));
        let remote = Credential::Remote(devices);

        assert_eq!(auth(&secret, &remote), Ok(Principal::Device(device.id)));
        assert_eq!(auth("secret", &remote), Err(AuthError::WrongToken), "the process token is refused on a network front");
        assert_eq!(auth(&child, &remote), Err(AuthError::WrongToken), "and so is a child's");
        assert_eq!(auth(&secret, &local), Err(AuthError::WrongToken), "a device credential is refused on the unix socket");
        assert_eq!(auth("never-minted", &remote), Err(AuthError::WrongToken));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
