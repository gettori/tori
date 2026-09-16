//! The OAuth device flow: how Sway gets a forge token without a redirect
//! server or a client secret.
//!
//! Three steps, and the middle one is a loop:
//!
//!   1. `POST /login/device/code` returns a short `user_code` to show, a
//!      `verification_uri` to open, and a `device_code` to poll with.
//!   2. `POST /login/oauth/access_token` is polled until it stops answering
//!      `authorization_pending`.
//!   3. The token that comes back goes to the keychain via [`super::token`].
//!
//! The `device_code` is a **secret** and deliberately never leaves Rust: the
//! frontend is handed the user code and the URL, nothing else. Anyone holding a
//! device code can complete the exchange.
//!
//! The classification of a poll response is a pure function ([`classify_poll`])
//! so every branch, including the backoff arithmetic, is tested off the wire.

use super::http::{HttpRequest, Transport};
use super::ForgeError;
use serde::Serialize;
use serde_json::Value;

/// The OAuth app's client id.
///
/// Public by design, and committed on purpose: the device flow has no client
/// secret, which is exactly why it suits a desktop app. A secret shipped in a
/// binary is a secret shipped to every user, so there is none to ship.
/// A build with this left empty refuses to start a flow it cannot finish
/// instead of failing at GitHub, which is why the shaping functions guard on an
/// empty id rather than trusting the constant.
pub const CLIENT_ID: &str = "Ov23liDBQcC2uWTVFpjp";

/// GitLab's equivalent, per instance rather than global: a self-managed server
/// only has an application if its own admin registered one, which is why the
/// id is stored per host and this constant covers gitlab.com alone. Empty until
/// that application exists, and an empty id offers no browser flow at all.
pub const GITLAB_COM_CLIENT_ID: &str = "";

/// The scope asked for. `repo` covers private repositories, PRs, and the
/// Checks API. Deliberately nothing wider: no `workflow`, no `read:org`.
const SCOPE: &str = "repo";
/// GitLab's equivalent of `repo`. `write_repository` is deliberately absent:
/// pushing through the account is Phase 5's switch, and asking for it here
/// would widen every sign-in for a feature that is off.
const GITLAB_SCOPE: &str = "api";

pub const ACCESS_DENIED: &str = "access_denied";
pub const EXPIRED_TOKEN: &str = "expired_token";

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

/// Where one provider's device flow lives, and what it asks for.
///
/// Both forges implement RFC 8628, so the two steps and every error string are
/// shared; what differs is the origin and the scope. GitLab's endpoints hang off
/// the instance's own base URL, which is what makes a self-managed server the
/// same flow at a different address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub code_url: String,
    pub token_url: String,
    pub scope: &'static str,
}

pub fn github_endpoints() -> Endpoints {
    Endpoints {
        code_url: DEVICE_CODE_URL.to_string(),
        token_url: ACCESS_TOKEN_URL.to_string(),
        scope: SCOPE,
    }
}

pub fn gitlab_endpoints(base_url: &str) -> Endpoints {
    let base = base_url.trim_end_matches('/');
    Endpoints {
        code_url: format!("{base}/oauth/authorize_device"),
        token_url: format!("{base}/oauth/token"),
        scope: GITLAB_SCOPE,
    }
}

/// The floor for the poll interval when the server does not name one. GitHub's
/// documented default is 5 seconds.
const DEFAULT_INTERVAL_SECS: u64 = 5;
/// What a `slow_down` adds when the response carries no new interval. The RFC
/// requires the client to increase the interval by 5 seconds on this signal.
const SLOW_DOWN_BUMP_SECS: u64 = 5;

pub fn is_configured() -> bool {
    !CLIENT_ID.is_empty()
}

/// What the frontend is allowed to see after step 1.
///
/// No `device_code` field, on purpose: see the module docs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePrompt {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in_secs: u64,
    pub interval_secs: u64,
}

/// The secret half of step 1, kept in Rust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingFlow {
    pub device_code: String,
    pub interval_secs: u64,
}

/// What a successful exchange hands back.
///
/// The refresh token and the deadline travel with the access token because
/// GitLab's tokens expire in two hours and a refresh invalidates both halves at
/// once: a pair split across two reads is a pair that can be half-stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    // Seconds from now, as the server sends it; the caller turns it into a
    // deadline against its own clock.
    pub expires_in_secs: Option<u64>,
}

fn token_set(v: &Value) -> Option<TokenSet> {
    let access = v.get("access_token")?.as_str()?;
    if access.is_empty() {
        return None;
    }
    Some(TokenSet {
        access_token: access.to_string(),
        refresh_token: v.get("refresh_token").and_then(|t| t.as_str()).map(|s| s.to_string()),
        expires_in_secs: v.get("expires_in").and_then(|e| e.as_u64()),
    })
}

/// Every way a poll can end.
///
/// `Pending` and `SlowDown` both carry the interval to use next, so the caller
/// never has to know which one changes it. Collapsing them into one "keep
/// waiting" would lose the backoff and earn a harder throttle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    Authorized { token: TokenSet },
    Pending { next_interval_secs: u64 },
    SlowDown { next_interval_secs: u64 },
    /// The user pressed cancel on GitHub's page.
    Denied,
    /// The device code aged out; the flow has to start over.
    Expired,
}

/// Reads one poll response.
///
/// Pure, because this is where the flow is actually decided and every branch
/// needs to be exercised without a network. `current_interval` is threaded
/// through so a `slow_down` can be applied to whatever the caller is using now,
/// rather than to a constant.
pub fn classify_poll(body: &str, current_interval_secs: u64) -> Result<PollOutcome, ForgeError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| ForgeError::Malformed { message: format!("device poll: {e}") })?;

    if v.get("access_token").is_some() {
        return match token_set(&v) {
            Some(set) => Ok(PollOutcome::Authorized { token: set }),
            None => Err(ForgeError::Malformed { message: "empty access_token".into() }),
        };
    }

    // A server-supplied interval wins over arithmetic: it is the number the
    // server will actually enforce.
    let named = v.get("interval").and_then(|i| i.as_u64());
    match v.get("error").and_then(|e| e.as_str()) {
        Some("authorization_pending") => Ok(PollOutcome::Pending {
            next_interval_secs: named.unwrap_or(current_interval_secs),
        }),
        Some("slow_down") => Ok(PollOutcome::SlowDown {
            next_interval_secs: named.unwrap_or(current_interval_secs + SLOW_DOWN_BUMP_SECS),
        }),
        Some(ACCESS_DENIED) => Ok(PollOutcome::Denied),
        Some(EXPIRED_TOKEN) => Ok(PollOutcome::Expired),
        // An unknown error must not read as "keep waiting": that would spin
        // until the code expired with nothing to show for it.
        Some(other) => Err(ForgeError::Api {
            status: 200,
            message: v
                .get("error_description")
                .and_then(|d| d.as_str())
                .map(|d| d.to_string())
                .unwrap_or_else(|| other.to_string()),
        }),
        None => Err(ForgeError::Malformed {
            message: "device poll had neither access_token nor error".into(),
        }),
    }
}

/// Reads the response to step 1.
pub fn parse_device_code(body: &str) -> Result<(DevicePrompt, PendingFlow), ForgeError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| ForgeError::Malformed { message: format!("device code: {e}") })?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(ForgeError::Api { status: 200, message: err.to_string() });
    }
    let field = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| ForgeError::Malformed { message: format!("device code: no {k}") })
    };
    let interval_secs = v.get("interval").and_then(|i| i.as_u64()).unwrap_or(DEFAULT_INTERVAL_SECS);
    Ok((
        DevicePrompt {
            user_code: field("user_code")?,
            verification_uri: field("verification_uri")?,
            expires_in_secs: v.get("expires_in").and_then(|e| e.as_u64()).unwrap_or(900),
            interval_secs,
        },
        PendingFlow { device_code: field("device_code")?, interval_secs },
    ))
}

fn form_post(url: &str, body: String) -> HttpRequest {
    HttpRequest {
        method: "POST",
        url: url.to_string(),
        headers: vec![
            // Without this GitHub answers form-encoded. Asking for JSON keeps
            // one parser in this module rather than two.
            ("Accept".into(), "application/json".into()),
            ("Content-Type".into(), "application/x-www-form-urlencoded".into()),
            ("User-Agent".into(), "sway".into()),
        ],
        body: Some(body),
    }
}

// The two request-shaping functions take the client id explicitly rather than
// reading the constant. Built while `CLIENT_ID` was still empty, a version that
// guarded on the constant would have bailed before shaping anything, so the form
// encoding, the URLs and the `grant_type` would have run for real for the first
// time on the day the app was registered. Passing the id in meant they were
// exercised before that, and registration changed a value rather than a code
// path. It still buys the tests a stand-in id instead of the live one.

/// Step 1: ask for a device code.
pub fn start_with(
    transport: &dyn Transport,
    client_id: &str,
    endpoints: &Endpoints,
) -> Result<(DevicePrompt, PendingFlow), ForgeError> {
    if client_id.is_empty() {
        return Err(ForgeError::NotAuthenticated);
    }
    let resp = transport.send(form_post(
        &endpoints.code_url,
        format!("client_id={client_id}&scope={}", endpoints.scope),
    ))?;
    if let Some(err) = super::http::classify(&resp) {
        return Err(err);
    }
    parse_device_code(&resp.body)
}

/// One turn of step 2. The caller owns the waiting, so the sleep is testable by
/// not existing here.
pub fn poll_once_with(
    transport: &dyn Transport,
    client_id: &str,
    endpoints: &Endpoints,
    flow: &PendingFlow,
) -> Result<PollOutcome, ForgeError> {
    if client_id.is_empty() {
        return Err(ForgeError::NotAuthenticated);
    }
    let resp = transport.send(form_post(
        &endpoints.token_url,
        format!(
            "client_id={client_id}&device_code={}&grant_type=urn:ietf:params:oauth:grant-type:device_code",
            flow.device_code
        ),
    ))?;
    // A device poll answers 200 with an `error` field for the ordinary waiting
    // cases, so the body is the signal, not the status. Only a genuinely
    // non-2xx response is an error here.
    if resp.status >= 400 {
        if let Some(err) = super::http::classify(&resp) {
            return Err(err);
        }
    }
    classify_poll(&resp.body, flow.interval_secs)
}

/// Exchanges a refresh token for a new pair.
///
/// GitLab invalidates **both** halves of the old pair on every refresh, so
/// whatever comes back here is the only credential that still works: it has to
/// reach the keychain before any caller is handed it, or a crash in between
/// signs the account out for good with no way back but a fresh sign-in.
pub fn refresh_with(
    transport: &dyn Transport,
    client_id: &str,
    endpoints: &Endpoints,
    refresh_token: &str,
) -> Result<TokenSet, ForgeError> {
    if client_id.is_empty() {
        return Err(ForgeError::NotAuthenticated);
    }
    let resp = transport.send(form_post(
        &endpoints.token_url,
        format!("client_id={client_id}&refresh_token={refresh_token}&grant_type=refresh_token"),
    ))?;
    if let Some(err) = super::http::classify(&resp) {
        return Err(err);
    }
    let v: Value = serde_json::from_str(&resp.body)
        .map_err(|e| ForgeError::Malformed { message: format!("refresh: {e}") })?;
    token_set(&v)
        .ok_or_else(|| ForgeError::Malformed { message: "refresh returned no token".into() })
}

// --- thin wrappers over the registered client id ---

pub fn start(transport: &dyn Transport) -> Result<(DevicePrompt, PendingFlow), ForgeError> {
    start_with(transport, CLIENT_ID, &github_endpoints())
}

pub fn poll_once(transport: &dyn Transport, flow: &PendingFlow) -> Result<PollOutcome, ForgeError> {
    poll_once_with(transport, CLIENT_ID, &github_endpoints(), flow)
}

#[cfg(test)]
mod tests {
    use super::super::http::test_support::StubTransport;
    use super::*;

    fn authorized(access: &str) -> PollOutcome {
        PollOutcome::Authorized {
            token: TokenSet {
                access_token: access.into(),
                refresh_token: None,
                expires_in_secs: None,
            },
        }
    }

    #[test]
    fn an_authorized_poll_yields_the_token() {
        let out = classify_poll(r#"{"access_token":"gho_x","token_type":"bearer"}"#, 5).unwrap();
        assert_eq!(out, authorized("gho_x"));
    }

    #[test]
    fn a_refreshable_token_carries_its_pair_and_its_deadline() {
        // GitLab answers with all three, and dropping either the refresh token
        // or the expiry leaves an account that simply stops working in two
        // hours with nothing able to renew it.
        let out = classify_poll(
            r#"{"access_token":"glpat_a","refresh_token":"glrt_r","expires_in":7200}"#,
            5,
        )
        .unwrap();
        assert_eq!(
            out,
            PollOutcome::Authorized {
                token: TokenSet {
                    access_token: "glpat_a".into(),
                    refresh_token: Some("glrt_r".into()),
                    expires_in_secs: Some(7200),
                },
            }
        );
    }

    #[test]
    fn a_refresh_exchanges_the_pair_for_a_new_one() {
        // The old pair stops working the moment this answers, so the new one is
        // the only credential left: it is read whole, or the call fails.
        let t = StubTransport::new(vec![StubTransport::json(
            200,
            r#"{"access_token":"glpat_b","refresh_token":"glrt_s","expires_in":7200}"#,
        )]);
        let set = refresh_with(&t, "app-id", &gitlab_endpoints("https://git.acme.test"), "glrt_r")
            .unwrap();
        assert_eq!(set.access_token, "glpat_b");
        assert_eq!(set.refresh_token.as_deref(), Some("glrt_s"));
        assert_eq!(set.expires_in_secs, Some(7200));

        let body = t.requests()[0].body.clone().unwrap();
        assert!(body.contains("grant_type=refresh_token"));
        assert!(body.contains("refresh_token=glrt_r"));

        // A refused refresh is an error rather than a half-applied change: the
        // caller is what decides the account is suspect.
        let refused = StubTransport::new(vec![StubTransport::json(
            401,
            r#"{"error":"invalid_grant"}"#,
        )]);
        assert!(refresh_with(
            &refused,
            "app-id",
            &gitlab_endpoints("https://git.acme.test"),
            "glrt_r"
        )
        .is_err());
    }

    #[test]
    fn a_pending_poll_keeps_the_current_interval() {
        assert_eq!(
            classify_poll(r#"{"error":"authorization_pending"}"#, 5).unwrap(),
            PollOutcome::Pending { next_interval_secs: 5 }
        );
        // Unless the server names one, which is the number it will enforce.
        assert_eq!(
            classify_poll(r#"{"error":"authorization_pending","interval":7}"#, 5).unwrap(),
            PollOutcome::Pending { next_interval_secs: 7 }
        );
    }

    #[test]
    fn slow_down_backs_off_and_compounds() {
        // The RFC requires +5s on this signal. Getting it wrong is what turns a
        // throttle into a longer throttle.
        assert_eq!(
            classify_poll(r#"{"error":"slow_down"}"#, 5).unwrap(),
            PollOutcome::SlowDown { next_interval_secs: 10 }
        );
        // Applied to the *current* interval, not a constant, so repeated
        // slow_downs keep climbing instead of pinning at 10.
        assert_eq!(
            classify_poll(r#"{"error":"slow_down"}"#, 10).unwrap(),
            PollOutcome::SlowDown { next_interval_secs: 15 }
        );
        // A server-named interval still wins.
        assert_eq!(
            classify_poll(r#"{"error":"slow_down","interval":30}"#, 10).unwrap(),
            PollOutcome::SlowDown { next_interval_secs: 30 }
        );
    }

    #[test]
    fn denial_and_expiry_are_distinct_endings() {
        // The user cancelling and the code ageing out need different wording:
        // one is "you said no", the other is "start again".
        assert_eq!(classify_poll(r#"{"error":"access_denied"}"#, 5).unwrap(), PollOutcome::Denied);
        assert_eq!(classify_poll(r#"{"error":"expired_token"}"#, 5).unwrap(), PollOutcome::Expired);
    }

    #[test]
    fn an_unknown_error_stops_rather_than_waiting_forever() {
        // Reading an unrecognised error as "keep waiting" would spin until the
        // code expired and then report expiry, hiding the real cause.
        let err = classify_poll(
            r#"{"error":"unsupported_grant_type","error_description":"bad grant"}"#,
            5,
        )
        .unwrap_err();
        assert_eq!(err, ForgeError::Api { status: 200, message: "bad grant".into() });

        // A body with neither field is malformed, not pending.
        assert!(matches!(
            classify_poll(r#"{"token_type":"bearer"}"#, 5).unwrap_err(),
            ForgeError::Malformed { .. }
        ));
    }

    #[test]
    fn an_empty_token_is_not_an_authorization() {
        assert!(matches!(
            classify_poll(r#"{"access_token":""}"#, 5).unwrap_err(),
            ForgeError::Malformed { .. }
        ));
    }

    #[test]
    fn step_one_splits_what_the_user_sees_from_what_stays_in_rust() {
        let (prompt, flow) = parse_device_code(
            r#"{"device_code":"dc_secret","user_code":"WDJB-MJHT",
                "verification_uri":"https://github.com/login/device",
                "expires_in":900,"interval":5}"#,
        )
        .unwrap();
        assert_eq!(prompt.user_code, "WDJB-MJHT");
        assert_eq!(prompt.interval_secs, 5);
        assert_eq!(flow.device_code, "dc_secret");

        // The prompt is what crosses to the frontend, and it must not carry the
        // device code: whoever holds one can finish the exchange.
        let json = serde_json::to_string(&prompt).unwrap();
        assert!(!json.contains("dc_secret"), "device code leaked to the frontend: {json}");
        assert!(json.contains("WDJB-MJHT"));
    }

    #[test]
    fn step_one_defaults_the_interval_when_the_server_omits_it() {
        let (prompt, flow) = parse_device_code(
            r#"{"device_code":"d","user_code":"U","verification_uri":"https://x"}"#,
        )
        .unwrap();
        assert_eq!(prompt.interval_secs, DEFAULT_INTERVAL_SECS);
        assert_eq!(flow.interval_secs, DEFAULT_INTERVAL_SECS);
    }

    #[test]
    fn an_unregistered_build_refuses_to_start_a_flow_it_cannot_finish() {
        // Without an id, starting anyway would send GitHub a request guaranteed
        // to fail and report it as a server problem rather than a missing
        // registration. The guard lives in the shaping functions rather than in
        // `start`, so it stays reachable from a test now that the real constant
        // is filled in.
        let t = StubTransport::new(vec![]);
        let gh = github_endpoints();
        assert_eq!(start_with(&t, "", &gh).unwrap_err(), ForgeError::NotAuthenticated);
        let flow = PendingFlow { device_code: "d".into(), interval_secs: 5 };
        assert_eq!(poll_once_with(&t, "", &gh, &flow).unwrap_err(), ForgeError::NotAuthenticated);
        assert_eq!(t.request_count(), 0, "nothing reached the wire");
    }

    #[test]
    fn the_registered_client_id_is_the_one_the_flow_uses() {
        // The gate this phase was blocked on. An empty constant would leave
        // every sign-in attempt failing as `NotAuthenticated` with nothing on
        // the wire, which looks identical to a rejected credential.
        assert!(is_configured(), "the OAuth app's client id is committed");

        let t = StubTransport::new(vec![StubTransport::json(
            200,
            r#"{"device_code":"d","user_code":"U","verification_uri":"https://x","interval":5}"#,
        )]);
        start(&t).unwrap();
        assert!(
            t.bodies()[0].contains(&format!("client_id={CLIENT_ID}")),
            "the wrapper sends the registered id, not a stand-in"
        );
    }

    #[test]
    fn step_one_sends_the_form_github_expects() {
        // Exercised with a stand-in id, so the assertion is about the shape of
        // the request rather than about which app it names.
        let t = StubTransport::new(vec![StubTransport::json(
            200,
            r#"{"device_code":"d","user_code":"U","verification_uri":"https://x","interval":5}"#,
        )]);
        start_with(&t, "Iv1.test", &github_endpoints()).unwrap();

        let req = &t.requests()[0];
        assert_eq!(req.method, "POST");
        assert_eq!(req.url, DEVICE_CODE_URL);
        let body = req.body.clone().unwrap();
        assert!(body.contains("client_id=Iv1.test"));
        assert!(body.contains(&format!("scope={SCOPE}")), "asks for repo and nothing wider");
        // Without an explicit Accept, GitHub answers form-encoded and the JSON
        // parser above would have nothing to read.
        assert!(req.headers.iter().any(|(k, v)| k == "Accept" && v == "application/json"));
    }

    #[test]
    fn the_poll_sends_the_device_grant_type() {
        let t = StubTransport::new(vec![StubTransport::json(200, r#"{"access_token":"gho_x"}"#)]);
        let flow = PendingFlow { device_code: "dc".into(), interval_secs: 5 };
        let out = poll_once_with(&t, "Iv1.test", &github_endpoints(), &flow).unwrap();
        assert_eq!(out, authorized("gho_x"));

        let body = t.requests()[0].body.clone().unwrap();
        assert!(body.contains("device_code=dc"));
        assert!(
            body.contains("grant_type=urn:ietf:params:oauth:grant-type:device_code"),
            "the device grant is what distinguishes this from a web exchange"
        );
    }

    #[test]
    fn a_pending_poll_is_read_from_the_body_not_the_status() {
        // GitHub answers 200 while waiting, so a status-first reading would
        // treat every wait as success and every success as indistinguishable.
        let t = StubTransport::new(vec![StubTransport::json(
            200,
            r#"{"error":"authorization_pending"}"#,
        )]);
        let flow = PendingFlow { device_code: "dc".into(), interval_secs: 5 };
        assert_eq!(
            poll_once_with(&t, "Iv1.test", &github_endpoints(), &flow).unwrap(),
            PollOutcome::Pending { next_interval_secs: 5 }
        );
    }

    #[test]
    fn a_gitlab_instance_runs_the_same_flow_at_its_own_origin() {
        // The reason the endpoints are a parameter: a self-managed server is
        // this flow at a different address, and hardcoding gitlab.com would send
        // a company's sign-in to the public instance.
        let t = StubTransport::new(vec![
            StubTransport::json(
                200,
                r#"{"device_code":"d","user_code":"U","verification_uri":"https://git.acme.test/oauth/device","interval":5}"#,
            ),
            StubTransport::json(200, r#"{"access_token":"glpat_x"}"#),
        ]);
        let acme = gitlab_endpoints("https://git.acme.test/");
        let (_, flow) = start_with(&t, "app-id", &acme).unwrap();
        poll_once_with(&t, "app-id", &acme, &flow).unwrap();

        let sent = t.requests();
        assert_eq!(sent[0].url, "https://git.acme.test/oauth/authorize_device");
        assert_eq!(sent[1].url, "https://git.acme.test/oauth/token");
        assert!(sent[0].body.clone().unwrap().contains("scope=api"), "api, and nothing wider");
    }

    #[test]
    fn the_poll_request_never_puts_the_device_code_in_a_debug_string() {
        // `StubTransport` records requests and a failing assertion prints them,
        // so the flow's secret must be redacted there like any other.
        let req = form_post(ACCESS_TOKEN_URL, "device_code=dc_secret&client_id=pub".into());
        let debugged = format!("{req:?}");
        assert!(!debugged.contains("dc_secret"), "device code leaked: {debugged}");
        assert!(debugged.contains("client_id=pub"), "the public half stays readable");
    }
}
