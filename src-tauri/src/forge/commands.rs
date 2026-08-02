//! The Tauri surface of the forge layer.
//!
//! Thin by design: every command here is a wrapper over a tested core in
//! `auth`, `device_flow` or `token`. Nothing below `commands.rs` touches Tauri,
//! which is the same one-directional layering the chat host uses.
//!
//! The in-flight device flow lives in [`DeviceFlowState`] rather than crossing
//! to the frontend, because a `device_code` is a secret: whoever holds one can
//! complete the exchange. The frontend gets a user code and a URL.

use super::device_flow::{self, DevicePrompt, PendingFlow, PollOutcome};
use super::http::UreqTransport;
use super::model::AuthState;
use super::{auth, token, Forge, ForgeError};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Default)]
pub struct DeviceFlowState(pub Mutex<Option<PendingFlow>>);

/// A `ForgeError` as the frontend sees it: a stable `kind` to branch on plus a
/// sentence to show.
///
/// The kind is what the UI switches on, so it must not be the display string:
/// a reworded message would silently change behaviour.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeErrorDto {
    pub kind: String,
    pub message: String,
}

impl From<ForgeError> for ForgeErrorDto {
    fn from(e: ForgeError) -> Self {
        let kind = match &e {
            ForgeError::NoRemote => "noRemote",
            ForgeError::UnsupportedRemote { .. } => "unsupportedRemote",
            ForgeError::NotAuthenticated => "notAuthenticated",
            ForgeError::CredentialSuspect => "credentialSuspect",
            ForgeError::Forbidden { .. } => "forbidden",
            ForgeError::RateLimited { .. } => "rateLimited",
            ForgeError::NotFound => "notFound",
            ForgeError::AlreadyExists { .. } => "alreadyExists",
            ForgeError::NotMergeable { .. } => "notMergeable",
            ForgeError::Api { .. } => "api",
            ForgeError::Transport { .. } => "transport",
            ForgeError::Malformed { .. } => "malformed",
        };
        Self { kind: kind.into(), message: e.to_string() }
    }
}

/// What a poll turn tells the frontend.
///
/// The token is deliberately absent: it goes straight to the keychain on the
/// Rust side and never crosses the bridge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PollReport {
    Authorized { login: String },
    Pending { next_interval_secs: u64 },
    Denied,
    Expired,
}

#[tauri::command]
pub fn github_auth_state() -> AuthState {
    auth::state()
}

#[tauri::command]
pub fn github_is_configured() -> bool {
    device_flow::is_configured()
}

/// Starts a device flow, holding the secret half in Rust.
#[tauri::command]
pub fn github_device_start(
    state: tauri::State<'_, DeviceFlowState>,
) -> Result<DevicePrompt, ForgeErrorDto> {
    let (prompt, pending) = device_flow::start(&UreqTransport::default())?;
    *state.0.lock().unwrap() = Some(pending);
    Ok(prompt)
}

/// One poll turn. The frontend owns the waiting, using the interval reported
/// back, so a `slow_down` actually slows the caller down.
#[tauri::command]
pub fn github_device_poll(
    state: tauri::State<'_, DeviceFlowState>,
) -> Result<PollReport, ForgeErrorDto> {
    let pending = state.0.lock().unwrap().clone();
    let Some(flow) = pending else {
        return Err(ForgeError::NotAuthenticated.into());
    };
    let outcome = device_flow::poll_once(&UreqTransport::default(), &flow)?;
    Ok(match outcome {
        PollOutcome::Authorized { token: t } => {
            // Straight to the keychain; the token never reaches the frontend.
            auth::sign_in(t, None)?;
            state.0.lock().unwrap().take();
            // Ask who it belongs to. Without this the account is never named
            // anywhere: the signed-in row reads "Signed in as GitHub", and the
            // suspect notice cannot say which account stopped working, which is
            // the one thing that makes it actionable.
            PollReport::Authorized { login: learn_login().unwrap_or_default() }
        }
        // Both waiting outcomes report the interval to use next, so the caller
        // never has to know which one changed it.
        PollOutcome::Pending { next_interval_secs } | PollOutcome::SlowDown { next_interval_secs } => {
            if let Some(f) = state.0.lock().unwrap().as_mut() {
                f.interval_secs = next_interval_secs;
            }
            PollReport::Pending { next_interval_secs }
        }
        PollOutcome::Denied => {
            state.0.lock().unwrap().take();
            PollReport::Denied
        }
        PollOutcome::Expired => {
            state.0.lock().unwrap().take();
            PollReport::Expired
        }
    })
}

#[tauri::command]
pub fn github_device_cancel(state: tauri::State<'_, DeviceFlowState>) {
    state.0.lock().unwrap().take();
}

/// Signs out. The only thing in the app that deletes the credential.
#[tauri::command]
pub fn github_sign_out() -> Result<(), ForgeErrorDto> {
    auth::sign_out().map_err(Into::into)
}

/// Restores the credential at startup and installs the keychain store.
///
/// Failure is non-fatal and deliberately so: a keychain that will not open
/// should leave Sway running signed-out, not stop it from starting, the same way
/// the askpass bridge and the tray icon handle their own failures.
pub fn restore_at_startup(enabled: bool) {
    if let Err(e) = token::install_store() {
        log_startup(&format!("forge: {e}"));
        return;
    }
    match token::load() {
        Ok(stored) => {
            let had_token = stored.is_some();
            auth::restore(stored, None, enabled);
            // The login is not stored beside the token, so it has to be asked
            // for again on every launch. Best-effort: a failure here leaves the
            // account unnamed, which is cosmetic, and must not stop startup.
            if had_token && enabled {
                let _ = learn_login();
            }
        }
        Err(e) => {
            log_startup(&format!("forge: {e}"));
            auth::restore(None, None, enabled);
        }
    }
}

/// Asks the forge who the stored token belongs to and records it.
///
/// Routed through [`auth::note_result`] like every other forge call, so a token
/// that has been revoked since last launch is discovered here and marks the
/// credential suspect rather than silently failing.
fn learn_login() -> Option<String> {
    let forge = client();
    let result = forge.viewer();
    auth::note_result(&result);
    let login = result.ok().map(|v| v.login)?;
    auth::note_login(login.clone());
    Some(login)
}

/// A forge client built from the current credential.
///
/// Built per call rather than held: the token can change under it (sign-in,
/// sign-out, re-sign-in), and a cached client would keep using the old one.
pub fn client() -> super::github::GitHubForge {
    super::github::GitHubForge::new(
        Box::new(super::http::UreqTransport::default()),
        auth::token(),
        match auth::state() {
            AuthState::SignedIn { login } => Some(login),
            AuthState::Suspect { login } => login,
            AuthState::SignedOut => None,
        },
    )
}

fn log_startup(message: &str) {
    // Matches the prefix every other non-fatal startup failure uses in lib.rs,
    // so one grep finds them all.
    eprintln!("sway: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_kind_is_stable_and_separate_from_its_wording() {
        // The UI switches on `kind`, so it must not be the message: rewording a
        // sentence would otherwise silently change behaviour.
        let dto: ForgeErrorDto = ForgeError::RateLimited {
            kind: super::super::RateLimitKind::Secondary,
            retry_after_secs: Some(60),
        }
        .into();
        assert_eq!(dto.kind, "rateLimited");
        assert!(dto.message.contains("60"));

        let dto: ForgeErrorDto = ForgeError::CredentialSuspect.into();
        assert_eq!(dto.kind, "credentialSuspect");
    }

    #[test]
    fn every_error_variant_has_its_own_kind() {
        // A duplicated kind would collapse two states the UI must tell apart.
        let all = [
            ForgeError::NoRemote,
            ForgeError::UnsupportedRemote { host: "gitlab.com".into() },
            ForgeError::NotAuthenticated,
            ForgeError::CredentialSuspect,
            ForgeError::Forbidden { message: String::new() },
            ForgeError::RateLimited {
                kind: super::super::RateLimitKind::Primary,
                retry_after_secs: None,
            },
            ForgeError::NotFound,
            ForgeError::AlreadyExists { message: String::new() },
            ForgeError::NotMergeable { message: String::new() },
            ForgeError::Api { status: 500, message: String::new() },
            ForgeError::Transport { message: String::new() },
            ForgeError::Malformed { message: String::new() },
        ];
        let mut kinds: Vec<String> =
            all.iter().cloned().map(|e| ForgeErrorDto::from(e).kind).collect();
        let total = kinds.len();
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds.len(), total, "two variants share a kind");
    }

    #[test]
    fn a_poll_report_never_carries_the_token() {
        // The whole reason the report is its own type rather than `PollOutcome`.
        let json = serde_json::to_string(&PollReport::Authorized { login: "skarif2".into() }).unwrap();
        assert!(json.contains("skarif2"));
        assert!(!json.contains("gho_"), "a token reached the frontend: {json}");
    }
}
