//! Claude's model-scoped quota, read from the account's own OAuth token.
//!
//! The `token` rung of [[adr_usage_source_ladder]], and the one exception to
//! [[adr_credential_custody]]. `auth.rs`'s custody scan names this file as its
//! single exemption, because reading the item means naming the service. What
//! the exemption costs is paid back by `the_setting_is_the_gate` below: it
//! counts vault lookups and requires zero of them while the opt-in is off,
//! which is the claim a static scan cannot make.
//!
//! The token is held for the length of one request. Nothing here writes it,
//! logs it, or hands it to anything but the endpoint that issued it, and
//! `no_file_under_the_data_dir_holds_the_token` drives a real read and then
//! searches the store for it.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::sessions::parse_rfc3339_secs;
use crate::settings::UsageSource;
use crate::usage_probe::ProbeWindow;

/// The item `claude` writes for the login the user already had. A non-default
/// `CLAUDE_CONFIG_DIR` gets its own item, suffixed with a hash of the raw
/// directory string (measured in Phase 0, see `accounts::canonicalize_home`).
const SERVICE: &str = "Claude Code-credentials";

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// The endpoint refuses an OAuth bearer without this. Measured 2026-09-06.
const OAUTH_BETA: &str = "oauth-2025-04-20";

/// Which item holds this profile's login.
pub fn service_for(home: Option<&str>) -> String {
    match home {
        None => SERVICE.to_string(),
        Some(dir) => {
            let digest = Sha256::digest(dir.as_bytes());
            let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("{SERVICE}-{hex}")
        }
    }
}

/// Why there is no reading. Every variant is a sentence the card shows beside
/// the windows a cheaper rung already filled, never a replacement for them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenFailure {
    /// The gate. Returned before anything is looked up.
    OptedOut,
    NoItem,
    /// The item is there but holds no Claude login. `claude` also stores
    /// MCP server credentials under its own names, and an install that has only
    /// ever used those has an item with nothing to read.
    NotALogin,
    Expired,
    Refused(u16),
    Transport(String),
}

impl TokenFailure {
    pub fn reason(&self) -> String {
        match self {
            Self::OptedOut => "the account token source is off".to_string(),
            Self::NoItem => "no Claude login in the Keychain for this account".to_string(),
            Self::NotALogin => "the Keychain item holds no Claude login".to_string(),
            Self::Expired => "the stored token has expired, run a turn to refresh it".to_string(),
            Self::Refused(401 | 403) => "Claude refused the token".to_string(),
            // The endpoint's own floor, not a fault in the token. Said as such,
            // and the poll's backoff is what honours it.
            Self::Refused(429) => "Claude is rate limiting usage reads, trying again later".to_string(),
            Self::Refused(code) => format!("Claude answered {code}"),
            Self::Transport(e) => e.clone(),
        }
    }
}

/// Anything that can hand over a stored secret.
///
/// A trait so the gate is provable: the test's recorder counts lookups, and the
/// count with the setting off has to be zero. A concrete keychain call could
/// only be shown not to happen by not running the test.
pub trait Vault {
    fn secret(&self, service: &str, account: &str) -> Result<Option<String>, String>;
}

pub trait UsageApi {
    fn get(&self, token: &str) -> Result<String, TokenFailure>;
}

/// The account's windows, in the shape every other rung reports.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenReading {
    pub windows: Vec<ProbeWindow>,
}

/// The access token, or why there is not one.
///
/// `expiresAt` is epoch **milliseconds** here, unlike `resetsAt` everywhere
/// else in this ticket. Checked rather than trusted to the endpoint, so an
/// expired token is a sentence about the login instead of a bare 401.
pub fn access_token(secret: &str, now_ms: u64) -> Result<String, TokenFailure> {
    let v: serde_json::Value = serde_json::from_str(secret).map_err(|_| TokenFailure::NotALogin)?;
    let oauth = v.get("claudeAiOauth").ok_or(TokenFailure::NotALogin)?;
    let token = oauth
        .get("accessToken")
        .and_then(|t| t.as_str())
        .ok_or(TokenFailure::NotALogin)?;
    if oauth
        .get("expiresAt")
        .and_then(|e| e.as_u64())
        .is_some_and(|at| at <= now_ms)
    {
        return Err(TokenFailure::Expired);
    }
    Ok(token.to_string())
}

fn window(kind: &str, v: &serde_json::Value) -> Option<ProbeWindow> {
    let w = v.as_object()?;
    Some(ProbeWindow {
        kind: kind.to_string(),
        // The endpoint sends 0 to 100 and every reader here speaks 0 to 1, the
        // same conversion Codex's rung makes for `usedPercent`.
        utilization: w.get("utilization").and_then(|u| u.as_f64()).map(|u| u / 100.0),
        resets_at: w.get("resets_at").and_then(|r| r.as_str()).and_then(parse_rfc3339_secs),
        status: None,
        // A locked window is the endpoint saying it refused, which outranks the
        // level by the same rule a Codex `rateLimitReachedType` does.
        reached_type: w.get("locked_reason").and_then(|r| r.as_str()).map(str::to_string),
    })
}

/// A model's display name as a window kind, so the scoped weekly window sorts
/// beside the plain one and `limitTypeLabel` can render it as "7-day (Fable)".
fn scoped_kind(display_name: &str) -> String {
    let slug: String = display_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("seven_day_{slug}")
}

/// Every window the endpoint reported.
///
/// Two shapes carry the model-scoped weekly window and they are both read. The
/// top-level `seven_day_*` keys are the older, fixed set (all null on a Max
/// account measured 2026-09-06); `limits[]` carries the live one with the
/// model's display name on it. They converge on one kind by construction, so a
/// window described twice is stored once rather than shown twice.
pub fn parse_usage(body: &str) -> TokenReading {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return TokenReading::default();
    };
    let mut windows = Vec::new();

    if let Some(obj) = v.as_object() {
        for (key, value) in obj {
            if key == "five_hour" || key == "seven_day" || key.starts_with("seven_day_") {
                windows.extend(window(key, value));
            }
        }
    }

    for limit in v.get("limits").and_then(|l| l.as_array()).into_iter().flatten() {
        let Some(name) = limit
            .get("scope")
            .and_then(|s| s.get("model"))
            .and_then(|m| m.get("display_name"))
            .and_then(|n| n.as_str())
        else {
            continue;
        };
        let kind = scoped_kind(name);
        windows.retain(|w: &ProbeWindow| w.kind != kind);
        windows.push(ProbeWindow {
            kind,
            utilization: limit.get("percent").and_then(|p| p.as_f64()).map(|p| p / 100.0),
            resets_at: limit
                .get("resets_at")
                .and_then(|r| r.as_str())
                .and_then(parse_rfc3339_secs),
            status: None,
            reached_type: None,
        });
    }

    // Extra usage is an allowance rather than a rate window, and it has no
    // reset. Reported only once it is switched on and has a level, since a
    // disabled one is a row saying nothing on every account that never bought
    // credits.
    if let Some(extra) = v.get("extra_usage") {
        let on = extra.get("is_enabled").and_then(|e| e.as_bool()).unwrap_or(false);
        if let (true, Some(level)) = (on, extra.get("utilization").and_then(|u| u.as_f64())) {
            windows.push(ProbeWindow {
                kind: "extra_usage".to_string(),
                utilization: Some(level / 100.0),
                resets_at: None,
                status: None,
                reached_type: extra
                    .get("spend_limit_reached")
                    .and_then(|r| r.as_bool())
                    .and_then(|hit| hit.then(|| "spend_limit_reached".to_string())),
            });
        }
    }

    windows.sort_by(|a, b| a.kind.cmp(&b.kind));
    TokenReading { windows }
}

/// One read of one account's windows.
///
/// **The first line is the gate.** `source` is the user's stored answer, and
/// anything other than `Token` returns before `vault` is touched at all. That
/// ordering is the whole of what the custody exemption rests on, so it is the
/// first statement in the function and has its own test.
pub fn read_usage(
    source: UsageSource,
    home: Option<&str>,
    account: &str,
    vault: &dyn Vault,
    api: &dyn UsageApi,
    now_ms: u64,
) -> Result<TokenReading, TokenFailure> {
    if source != UsageSource::Token {
        return Err(TokenFailure::OptedOut);
    }
    let secret = vault
        .secret(&service_for(home), account)
        .map_err(TokenFailure::Transport)?
        .ok_or(TokenFailure::NoItem)?;
    let token = access_token(&secret, now_ms)?;
    Ok(parse_usage(&api.get(&token)?))
}

// --- the real vault and the real endpoint ---

/// Read through `/usr/bin/security`, the tool `claude` writes the item with, so
/// the item already trusts it. Read in process, every Tori build needs its own
/// "Always Allow", and a dev build's signature changes on every rebuild.
pub struct Keychain;

const ITEM_NOT_FOUND: i32 = 44;

impl Vault for Keychain {
    fn secret(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let mut cmd = crate::platform::process::command("/usr/bin/security");
        cmd.args(["find-generic-password", "-a", account, "-s", service, "-w"]);
        let out = crate::env::output_with_timeout(&mut cmd).ok_or_else(|| "the keychain did not answer".to_string())?;
        match out.status.code() {
            Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())),
            Some(ITEM_NOT_FOUND) => Ok(None),
            _ => Err(format!("keychain: {}", String::from_utf8_lossy(&out.stderr).trim())),
        }
    }
}

pub struct Anthropic;

impl UsageApi for Anthropic {
    fn get(&self, token: &str) -> Result<String, TokenFailure> {
        match ureq::get(USAGE_URL)
            .set("Authorization", &format!("Bearer {token}"))
            .set("anthropic-beta", OAUTH_BETA)
            .call()
        {
            Ok(r) => r.into_string().map_err(|e| TokenFailure::Transport(e.to_string())),
            Err(ureq::Error::Status(code, _)) => Err(TokenFailure::Refused(code)),
            Err(e) => Err(TokenFailure::Transport(e.to_string())),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The account `claude` filed the item under: the OS user name.
///
/// From the home directory rather than `$USER`. A `.app` launched from Finder
/// inherits launchd's environment, not a shell's, so reading the variable works
/// in every test and can come back empty in the one place that matters.
pub fn os_account() -> String {
    dirs::home_dir()
        .and_then(|h| h.file_name().map(|n| n.to_string_lossy().into_owned()))
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_default()
}

/// The profile's home, or `None` for the default account, which is the whole
/// mechanism of the default profile: no `CLAUDE_CONFIG_DIR`, so the plain item.
fn home_of(profile_id: &str) -> Option<String> {
    if profile_id == crate::accounts::DEFAULT_PROFILE_ID {
        return None;
    }
    crate::accounts::profile(&crate::accounts::load(), "claude", profile_id).and_then(|p| p.home)
}

#[tauri::command]
pub async fn usage_token_claude(profile: Option<String>) -> Result<TokenReading, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = profile.unwrap_or_else(|| crate::accounts::DEFAULT_PROFILE_ID.to_string());
        // The chip is the opt-in, so the gate is whether this account asked for
        // the window only this read can answer. Anything else is `Off`, which
        // returns before the vault is touched.
        let source = if crate::settings::wants_token_window("claude", &id) {
            UsageSource::Token
        } else {
            UsageSource::Off
        };
        read_usage(
            source,
            home_of(&id).as_deref(),
            &os_account(),
            &Keychain,
            &Anthropic,
            now_ms(),
        )
        .map_err(|e| e.reason())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    /// A vault that answers, and counts how many times it was asked.
    #[derive(Default)]
    struct Recorder {
        lookups: RefCell<Vec<(String, String)>>,
        secret: Option<String>,
    }

    impl Vault for Recorder {
        fn secret(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            self.lookups
                .borrow_mut()
                .push((service.to_string(), account.to_string()));
            Ok(self.secret.clone())
        }
    }

    struct Canned(Result<String, TokenFailure>);

    impl UsageApi for Canned {
        fn get(&self, _token: &str) -> Result<String, TokenFailure> {
            self.0.clone()
        }
    }

    const TOKEN: &str = "sk-ant-oat01-THIS-IS-THE-SENTINEL-TOKEN";

    fn login(expires_at: u64) -> String {
        serde_json::json!({
            "claudeAiOauth": {
                "accessToken": TOKEN,
                "expiresAt": expires_at,
                "refreshToken": "sk-ant-ort01-refresh",
                "subscriptionType": "max",
            }
        })
        .to_string()
    }

    fn fixture() -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/usage/claude-oauth-usage.json");
        std::fs::read_to_string(&path).expect("the committed capture")
    }

    const NOW: u64 = 1_788_600_000_000;

    /// **The exemption's price, paid.** The custody scan lets this file name the
    /// service; what it cannot say is that nothing reads it while the opt-in is
    /// off. This can: the vault is asked zero times for every source but
    /// `Token`, and exactly once for that one.
    #[test]
    fn the_setting_is_the_gate() {
        for off in [UsageSource::Off, UsageSource::Sessions, UsageSource::Cli] {
            let vault = Recorder {
                secret: Some(login(NOW + 1)),
                ..Default::default()
            };
            let api = Canned(Ok(fixture()));
            let answer = read_usage(off, None, "me", &vault, &api, NOW);

            assert_eq!(answer, Err(TokenFailure::OptedOut), "{off:?}");
            assert!(vault.lookups.borrow().is_empty(), "{off:?} looked the credential up");
        }

        let vault = Recorder {
            secret: Some(login(NOW + 1)),
            ..Default::default()
        };
        let api = Canned(Ok(fixture()));
        read_usage(UsageSource::Token, None, "me", &vault, &api, NOW).expect("a reading");
        assert_eq!(vault.lookups.borrow().len(), 1, "on, and asked exactly once");
    }

    /// The one place a `CLAUDE_CONFIG_DIR` changes anything. The digest is of the
    /// raw string `claude` was given, which is why `accounts::canonicalize_home`
    /// exists.
    #[test]
    fn a_profile_home_names_its_own_item() {
        assert_eq!(service_for(None), "Claude Code-credentials");
        let named = service_for(Some("/Users/me/Library/Application Support/tori/profiles/claude/work"));
        assert!(named.starts_with("Claude Code-credentials-"), "{named}");
        assert_eq!(
            named.len(),
            "Claude Code-credentials-".len() + 8,
            "eight hex characters"
        );
        assert_ne!(named, service_for(Some("/Users/me/other")), "one directory, one item");
    }

    /// The account name has to survive a launchd environment, which is the one
    /// Tori actually ships into and the one no test process ever has.
    #[test]
    fn the_os_account_does_not_depend_on_an_environment_variable() {
        let from_home = dirs::home_dir().expect("a home directory");
        assert_eq!(os_account(), from_home.file_name().unwrap().to_string_lossy());
        assert!(!os_account().is_empty());
    }

    #[test]
    fn the_captured_answer_maps_every_window_it_reported() {
        let reading = parse_usage(&fixture());
        let kinds: Vec<&str> = reading.windows.iter().map(|w| w.kind.as_str()).collect();

        assert!(kinds.contains(&"five_hour"), "{kinds:?}");
        assert!(kinds.contains(&"seven_day"), "{kinds:?}");
        // The model-scoped weekly window, which is the whole reason this rung
        // exists: no passive frame carries it.
        assert!(kinds.contains(&"seven_day_fable"), "{kinds:?}");

        let five = reading.windows.iter().find(|w| w.kind == "five_hour").unwrap();
        // 7.0 on the wire, 0.07 here, the same conversion Codex's rung makes.
        assert_eq!(five.utilization, Some(0.07));
        // "2026-09-06T09:09:59.694749+00:00" as epoch seconds, not 1970.
        assert_eq!(five.resets_at, Some(1_788_685_799));
        assert!(
            reading.windows.iter().all(|w| w.reached_type.is_none()),
            "nothing was locked"
        );
    }

    /// A null window is absent, not zero. A Pro account has no Opus window and
    /// must not show an empty bar for one.
    #[test]
    fn a_window_the_endpoint_reported_as_null_is_absent() {
        let reading = parse_usage(&fixture());
        let kinds: Vec<&str> = reading.windows.iter().map(|w| w.kind.as_str()).collect();
        assert!(!kinds.contains(&"seven_day_opus"), "null in the capture: {kinds:?}");
        assert!(!kinds.contains(&"extra_usage"), "disabled in the capture: {kinds:?}");
    }

    /// Both shapes for the scoped window converge on one kind, so an account
    /// where the endpoint fills the old key and the new array reports one row.
    #[test]
    fn a_window_described_twice_is_stored_once() {
        let body = serde_json::json!({
            "seven_day_opus": { "utilization": 10.0, "resets_at": null },
            "limits": [{
                "kind": "weekly_scoped", "percent": 26, "resets_at": null,
                "scope": { "model": { "display_name": "Opus" } },
            }],
        })
        .to_string();
        let reading = parse_usage(&body);

        assert_eq!(reading.windows.len(), 1, "{:?}", reading.windows);
        assert_eq!(reading.windows[0].kind, "seven_day_opus");
        // The array wins: it is the shape that carries the display name.
        assert_eq!(reading.windows[0].utilization, Some(0.26));
    }

    #[test]
    fn extra_usage_reports_only_once_it_is_switched_on() {
        let off = parse_usage(
            &serde_json::json!({ "extra_usage": { "is_enabled": false, "utilization": 40.0 } }).to_string(),
        );
        assert!(off.windows.is_empty(), "{:?}", off.windows);

        let on = parse_usage(
            &serde_json::json!({ "extra_usage": { "is_enabled": true, "utilization": 40.0, "spend_limit_reached": true } })
                .to_string(),
        );
        assert_eq!(on.windows.len(), 1);
        assert_eq!(on.windows[0].utilization, Some(0.4));
        assert_eq!(on.windows[0].resets_at, None, "an allowance has no reset");
        assert_eq!(on.windows[0].reached_type.as_deref(), Some("spend_limit_reached"));
    }

    /// Four failures, four sentences. Each one names something the user can act
    /// on, which is the difference between a reason and an error code.
    #[test]
    fn every_failure_says_which_one_it_was() {
        let api = || Canned(Ok(fixture()));

        let empty = Recorder {
            secret: None,
            ..Default::default()
        };
        assert_eq!(
            read_usage(UsageSource::Token, None, "me", &empty, &api(), NOW),
            Err(TokenFailure::NoItem)
        );

        let mcp = Recorder {
            secret: Some("{\"mcpOAuth\":{}}".into()),
            ..Default::default()
        };
        assert_eq!(
            read_usage(UsageSource::Token, None, "me", &mcp, &api(), NOW),
            Err(TokenFailure::NotALogin)
        );

        let stale = Recorder {
            secret: Some(login(NOW - 1)),
            ..Default::default()
        };
        assert_eq!(
            read_usage(UsageSource::Token, None, "me", &stale, &api(), NOW),
            Err(TokenFailure::Expired)
        );

        let good = Recorder {
            secret: Some(login(NOW + 1)),
            ..Default::default()
        };
        let refused = Canned(Err(TokenFailure::Refused(401)));
        let answer = read_usage(UsageSource::Token, None, "me", &good, &refused, NOW);
        assert_eq!(answer, Err(TokenFailure::Refused(401)));
        assert!(answer.unwrap_err().reason().contains("refused"));
    }

    /// The custody claim that outlives the process: a reading is windows and
    /// nothing else, so a token cannot reach the snapshot the strip restores
    /// from. Driven rather than reasoned about.
    #[test]
    fn no_file_under_the_data_dir_holds_the_token() {
        let vault = Recorder {
            secret: Some(login(NOW + 1)),
            ..Default::default()
        };
        let api = Canned(Ok(fixture()));
        let reading = read_usage(UsageSource::Token, None, "me", &vault, &api, NOW).expect("a reading");

        let root = std::env::temp_dir().join(format!(
            "tori-token-custody-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let snapshot = crate::usage_snapshot::UsageSnapshot {
            readings: [(
                "claude\u{0}default".to_string(),
                reading
                    .windows
                    .iter()
                    .map(|w| {
                        (
                            w.kind.clone(),
                            crate::usage_snapshot::WindowReading {
                                kind: w.kind.clone(),
                                utilization: w.utilization,
                                resets_at: w.resets_at,
                                status: w.status.clone(),
                                reached_type: w.reached_type.clone(),
                                sampled_at: NOW,
                                source: "token".to_string(),
                            },
                        )
                    })
                    .collect(),
            )]
            .into_iter()
            .collect(),
            fired: Default::default(),
        };
        crate::usage_snapshot::save_to(&root, snapshot, NOW).expect("saved");

        let mut checked = 0;
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("the store is readable").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                assert!(!text.contains(TOKEN), "{} holds the token", path.display());
                assert!(!text.contains("refresh"), "{} holds the refresh token", path.display());
                checked += 1;
            }
        }
        assert!(checked > 0, "the store wrote something to search");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Re-measures the whole rung against this machine: the real item, the real
    /// endpoint, the real shapes. Run by hand, since it reads a live login.
    #[test]
    #[ignore = "reads the real Keychain item and calls the usage endpoint"]
    fn the_real_account_answers_with_its_scoped_window() {
        let reading = read_usage(UsageSource::Token, None, &os_account(), &Keychain, &Anthropic, now_ms())
            .expect("a signed-in claude answers");

        let kinds: Vec<&str> = reading.windows.iter().map(|w| w.kind.as_str()).collect();
        assert!(kinds.contains(&"five_hour"), "{kinds:?}");
        assert!(kinds.contains(&"seven_day"), "{kinds:?}");
        assert!(
            kinds.iter().any(|k| k.starts_with("seven_day_")),
            "the model-scoped window is the reason this rung exists: {kinds:?}"
        );
        assert!(reading
            .windows
            .iter()
            .all(|w| w.utilization.is_some_and(|u| (0.0..=1.0).contains(&u))));
    }
}
