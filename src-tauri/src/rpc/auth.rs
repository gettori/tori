//! The one place a connection proves who it is. A WebSocket front will carry a
//! per device credential instead of the process token, and that swap belongs
//! here and nowhere else.

use serde::Deserialize;

use super::frame::{Request, RpcError, UNAUTHORIZED};

pub const AUTH_METHOD: &str = "auth";

pub enum Credential {
    Token(String),
}

/// Who is on the other end once `authenticate` has passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Principal {
    /// Holds the process token: a child Tori spawned, or a reader of the bridge file.
    Local,
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
        Credential::Token(expected) if constant_time_eq(token.as_bytes(), expected.as_bytes()) => Ok(Principal::Local),
        Credential::Token(_) => Err(AuthError::WrongToken),
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
        Credential::Token("secret".into())
    }

    #[test]
    fn the_right_token_is_local() {
        assert_eq!(authenticate(&req("auth", json!({"token": "secret"})), &cred()), Ok(Principal::Local));
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
