//! Codex's quota, read from `codex app-server` on Tori's own schedule.
//!
//! The `cli` rung of [[adr_usage_source_ladder]]. Codex forwards no rate limits
//! over ACP (measured in `acp_transport::tests::codex_forwards_no_rate_limits_over_acp`),
//! so unlike Claude there is nothing passive to merge and a reading exists only
//! because Tori asked for one.
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A ceiling on the whole exchange: spawn, handshake, two reads.
pub const PROBE_DEADLINE: Duration = Duration::from_secs(20);

/// How long a child gets to honour SIGTERM before SIGKILL. It is a JSON-RPC
/// server with nothing to flush, so this is politeness, not a save window.
const TERM_GRACE: Duration = Duration::from_millis(500);

/// The window durations Codex ships today, in minutes. Recorded as numbers
/// rather than assumed from the field order: `primary` is only the shorter
/// window by convention, and a swap would silently relabel both.
const FIVE_HOUR_MINS: i64 = 300;
const SEVEN_DAY_MINS: i64 = 10080;

/// One window, in the shape `QuotaReading` reads on the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeWindow {
    pub kind: String,
    pub utilization: Option<f64>,
    /// Epoch **seconds**, as every source sends it.
    pub resets_at: Option<u64>,
    pub status: Option<String>,
    pub reached_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

/// What one probe learned. Identity travels with the windows because it comes
/// from the same exchange: Codex's `login status` names no account, so this is
/// the only place an email for it exists.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProbe {
    pub windows: Vec<ProbeWindow>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub credits: Option<ProbeCredits>,
    pub reached_type: Option<String>,
}

/// Codex's window name for a duration, or a label built from it.
///
/// The two known durations take the wire kinds Claude already uses, so one
/// account's five-hour window is one row whichever source filled it. Anything
/// else gets a label rather than a passthrough of the raw minutes, since
/// `limitTypeLabel` shows an unknown kind exactly as it arrives.
pub fn window_kind(mins: Option<i64>) -> String {
    match mins {
        Some(FIVE_HOUR_MINS) => "five_hour".to_string(),
        Some(SEVEN_DAY_MINS) => "seven_day".to_string(),
        None => "limit".to_string(),
        Some(m) if m % (24 * 60) == 0 => format!("{}-day", m / (24 * 60)),
        Some(m) if m % 60 == 0 => format!("{}-hour", m / 60),
        Some(m) => format!("{m}-minute"),
    }
}

fn window_from(v: &Value, reached_type: Option<&str>) -> Option<ProbeWindow> {
    let w = v.as_object()?;
    Some(ProbeWindow {
        kind: window_kind(w.get("windowDurationMins").and_then(Value::as_i64)),
        // `usedPercent` is 0 to 100 and every other source speaks 0 to 1. The
        // conversion happens once, here, for the same reason `resetsAt` is
        // converted once: two scales that both look plausible in a fixture.
        utilization: w.get("usedPercent").and_then(Value::as_f64).map(|p| p / 100.0),
        resets_at: w.get("resetsAt").and_then(Value::as_u64),
        status: None,
        reached_type: reached_type.map(str::to_string),
    })
}

/// Fold the two answers into one reading.
///
/// `rateLimitReachedType` names *why* the account is refused, never which
/// window, so it rides on all of them: none of the levels can be spent while it
/// is set. Each window still clears on its own reset, because `quotaState`
/// resolves expiry before it looks at this.
pub fn parse(account: Option<&Value>, limits: Option<&Value>) -> UsageProbe {
    let mut out = UsageProbe::default();

    if let Some(a) = account.and_then(|a| a.get("account")).and_then(Value::as_object) {
        out.email = a.get("email").and_then(Value::as_str).map(str::to_string);
        out.plan_type = a.get("planType").and_then(Value::as_str).map(str::to_string);
    }

    let Some(rl) = limits.and_then(|l| l.get("rateLimits")) else {
        return out;
    };
    out.reached_type = rl
        .get("rateLimitReachedType")
        .and_then(Value::as_str)
        .map(str::to_string);
    if out.plan_type.is_none() {
        out.plan_type = rl.get("planType").and_then(Value::as_str).map(str::to_string);
    }
    out.credits = rl.get("credits").and_then(Value::as_object).map(|c| ProbeCredits {
        has_credits: c.get("hasCredits").and_then(Value::as_bool).unwrap_or(false),
        unlimited: c.get("unlimited").and_then(Value::as_bool).unwrap_or(false),
        balance: c.get("balance").and_then(Value::as_str).map(str::to_string),
    });
    for slot in ["primary", "secondary"] {
        if let Some(w) = rl.get(slot).and_then(|w| window_from(w, out.reached_type.as_deref())) {
            out.windows.push(w);
        }
    }
    out
}

// --- driving the server ---

/// End a child we are about to stop holding a handle to: ask, then insist.
///
/// The `wait` is not optional. Rust's `Child` does not kill on drop, and a kill
/// without a reap leaves a zombie.
fn end_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
    let deadline = std::time::Instant::now() + TERM_GRACE;
    while std::time::Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// How much of a failed probe's stderr to keep, matching the catalogue probe's
/// own tail. Enough for an auth message, bounded so a chatty child cannot grow
/// an error string without limit.
const STDERR_TAIL: usize = 4096;

/// The child's stderr, collected on its own thread. A server that dies before
/// answering explains itself here and nowhere else.
#[derive(Default)]
struct Stderr(Option<thread::JoinHandle<String>>);

fn tail_stderr(stderr: impl std::io::Read + Send + 'static) -> Stderr {
    Stderr(Some(thread::spawn(move || {
        let mut text = String::new();
        let mut stderr = stderr;
        let _ = std::io::Read::read_to_string(&mut stderr, &mut text);
        // Cut on a character boundary: an agent that writes a banner puts
        // multi-byte characters in the buffer, and slicing mid character panics.
        let cut = (text.len().saturating_sub(STDERR_TAIL)..=text.len())
            .find(|i| text.is_char_boundary(*i))
            .unwrap_or(0);
        text[cut..].trim().to_string()
    })))
}

/// Joined rather than polled: the read only ends when the child's pipe closes,
/// so this is called after the kill and returns at once.
fn quoting(error: String, said: Stderr) -> String {
    match said.0.and_then(|h| h.join().ok()).unwrap_or_default() {
        tail if tail.is_empty() => error,
        tail => format!("{error} ({tail})"),
    }
}

/// The client half of one JSON-RPC session, to the point of both answers.
fn exchange(mut stdin: impl Write, stdout: impl BufRead, methods: &[&str]) -> Result<Vec<Value>, String> {
    let mut lines = stdout.lines();
    let mut send = |v: Value| -> Result<(), String> {
        writeln!(stdin, "{v}").map_err(|e| format!("codex app-server closed its input: {e}"))?;
        stdin.flush().map_err(|e| e.to_string())
    };

    /// Read until the response to `id`, refusing anything the server asks of us.
    /// An unanswered server request stalls the server, and this client serves
    /// none of them.
    fn await_id(
        lines: &mut impl Iterator<Item = std::io::Result<String>>,
        send: &mut impl FnMut(Value) -> Result<(), String>,
        id: u64,
    ) -> Result<Value, String> {
        for line in lines.by_ref() {
            let line = line.map_err(|e| format!("codex app-server went away: {e}"))?;
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if msg.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(err) = msg.get("error") {
                    return Err(format!("codex app-server refused: {err}"));
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
            if let (Some(rid), true) = (msg.get("id").cloned(), msg.get("method").is_some()) {
                send(json!({
                    "jsonrpc": "2.0", "id": rid,
                    "error": { "code": -32601, "message": "not served by this probe" },
                }))?;
            }
        }
        Err("codex app-server ended without answering".to_string())
    }

    send(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "clientInfo": { "name": "tori", "title": null, "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true, "requestAttestation": false },
        },
    }))?;
    await_id(&mut lines, &mut send, 1)?;
    // The server answers nothing else until it has this.
    send(json!({ "jsonrpc": "2.0", "method": "initialized" }))?;

    let mut out = Vec::new();
    for (i, method) in methods.iter().enumerate() {
        let id = i as u64 + 2;
        send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": {} }))?;
        out.push(await_id(&mut lines, &mut send, id)?);
    }
    Ok(out)
}

/// Run one probe against the given command, bounded by `deadline`.
///
/// The program is a parameter so the tests can point it at a scripted fake, and
/// so a hung child can be driven on a deadline nobody would sit through.
pub fn probe_with(program: &str, args: &[String], deadline: Duration) -> Result<UsageProbe, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {program}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin on the probe child")?;
    let stdout = child.stdout.take().ok_or("no stdout on the probe child")?;
    let said = child.stderr.take().map(tail_stderr).unwrap_or_default();

    let (tx, rx) = mpsc::channel();
    // Detached: on a timeout this thread is blocked in a read that only ends
    // when the kill below closes the pipe, so joining it would wait out the
    // hang the deadline exists to cut short.
    thread::spawn(move || {
        let answers = exchange(
            stdin,
            BufReader::new(stdout),
            &["account/read", "account/rateLimits/read"],
        );
        let _ = tx.send(answers);
    });

    let answered = rx.recv_timeout(deadline);
    end_child(&mut child);
    match answered {
        Ok(Ok(answers)) => Ok(parse(answers.first(), answers.get(1))),
        Ok(Err(e)) => Err(quoting(e, said)),
        Err(_) => Err(format!(
            "codex app-server did not answer within {}s",
            deadline.as_secs()
        )),
    }
}

/// The real thing. `-s read-only -a never` because a server Tori only reads
/// from must not be able to edit or ask.
pub fn probe_codex() -> Result<UsageProbe, String> {
    let args: Vec<String> = ["-s", "read-only", "-a", "never", "app-server"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    probe_with("codex", &args, PROBE_DEADLINE)
}

#[tauri::command]
pub async fn usage_probe_codex() -> Result<UsageProbe, String> {
    tauri::async_runtime::spawn_blocking(probe_codex)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev/fixtures/usage/codex-app-server.json");
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the committed capture")).unwrap()
    }

    fn sh(script: &str) -> Vec<String> {
        vec!["-c".to_string(), script.to_string()]
    }

    #[test]
    fn the_captured_answer_maps_to_two_named_windows() {
        let f = fixture();
        let probe = parse(f.get("account/read"), f.get("account/rateLimits/read"));

        let kinds: Vec<&str> = probe.windows.iter().map(|w| w.kind.as_str()).collect();
        assert_eq!(kinds, ["five_hour", "seven_day"], "by duration, not by slot order");
        // 3 on the wire, 0.03 everywhere else. The one conversion this mapping
        // has to get right, pinned against the captured magnitude.
        assert_eq!(probe.windows[0].utilization, Some(0.03));
        assert_eq!(probe.windows[0].resets_at, Some(1_788_665_968));
        assert_eq!(probe.windows[1].resets_at, Some(1_788_955_629));
        assert!(
            probe.windows.iter().all(|w| w.reached_type.is_none()),
            "nothing was hit"
        );
    }

    #[test]
    fn identity_and_credits_come_off_the_same_exchange() {
        let f = fixture();
        let probe = parse(f.get("account/read"), f.get("account/rateLimits/read"));

        assert_eq!(probe.email.as_deref(), Some("codex-user@example.com"));
        assert_eq!(probe.plan_type.as_deref(), Some("plus"));
        let credits = probe.credits.expect("the snapshot carries them");
        assert!(!credits.has_credits && !credits.unlimited);
        assert_eq!(credits.balance.as_deref(), Some("0"));
    }

    /// `rateLimitReachedType` says why the account is refused, not which window,
    /// so every window carries it and the card cannot show a spendable level
    /// beside a limit that is in force.
    #[test]
    fn a_reached_account_marks_every_window() {
        let limits = json!({ "rateLimits": {
            "primary": { "usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1 },
            "secondary": { "usedPercent": 99, "windowDurationMins": 10080, "resetsAt": 2 },
            "rateLimitReachedType": "workspace_owner_credits_depleted",
        }});
        let probe = parse(None, Some(&limits));

        assert_eq!(probe.reached_type.as_deref(), Some("workspace_owner_credits_depleted"));
        assert!(
            probe.windows.iter().all(|w| w.reached_type.is_some()),
            "{:?}",
            probe.windows
        );
    }

    #[test]
    fn a_duration_codex_has_not_shipped_yet_is_labelled_rather_than_dropped() {
        assert_eq!(window_kind(Some(300)), "five_hour");
        assert_eq!(window_kind(Some(10080)), "seven_day");
        assert_eq!(window_kind(Some(1440)), "1-day");
        assert_eq!(window_kind(Some(60)), "1-hour");
        assert_eq!(window_kind(Some(90)), "90-minute");
        assert_eq!(window_kind(None), "limit");
    }

    /// A signed-out server answers `account: null` and refuses the limits. The
    /// refusal is the reason the card shows, so it must survive as text.
    #[test]
    fn a_refusal_comes_back_as_its_own_sentence() {
        let script = r#"
            read -r _init
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}'
            read -r _initialized
            read -r _account
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
            read -r _limits
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"error":{"code":401,"message":"not logged in"}}'
        "#;
        let err =
            probe_with("/bin/sh", &sh(script), Duration::from_secs(5)).expect_err("a refused read is not a reading");
        assert!(err.contains("not logged in"), "{err}");
    }

    /// The scripted fake, answering the way the real server does.
    #[test]
    fn a_scripted_server_is_driven_end_to_end() {
        let script = r#"
            read -r _init
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}'
            printf '%s\n' '{"jsonrpc":"2.0","method":"account/rateLimits/updated","params":{}}'
            read -r _initialized
            read -r _account
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"account":{"type":"chatgpt","email":"a@b.c","planType":"pro"}}}'
            read -r _limits
            printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"rateLimits":{"primary":{"usedPercent":50,"windowDurationMins":300,"resetsAt":9}}}}'
        "#;
        let probe = probe_with("/bin/sh", &sh(script), Duration::from_secs(5)).expect("answered");

        assert_eq!(probe.email.as_deref(), Some("a@b.c"));
        assert_eq!(probe.plan_type.as_deref(), Some("pro"));
        assert_eq!(probe.windows.len(), 1);
        assert_eq!(probe.windows[0].utilization, Some(0.5));
    }

    /// The deadline is what stops a hung server from wedging the poll, so it is
    /// driven rather than trusted. The child holds its stdout open and answers
    /// nothing, which is exactly the hang shape.
    #[test]
    fn a_silent_server_is_killed_on_the_deadline() {
        let started = std::time::Instant::now();
        let err = probe_with("/bin/sh", &sh("sleep 30"), Duration::from_millis(300))
            .expect_err("a server that never answers has said nothing");

        assert!(err.contains("did not answer"), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "it returned on its own deadline"
        );
    }

    /// A server that dies before answering explains itself on stderr and
    /// nowhere else, so the reason has to survive into the error.
    #[test]
    fn a_server_that_dies_quotes_what_it_said() {
        let err = probe_with(
            "/bin/sh",
            &sh("echo 'not logged in, run codex login' >&2; exit 1"),
            Duration::from_secs(5),
        )
        .expect_err("nothing was answered");
        assert!(err.contains("codex login"), "{err}");
    }

    #[test]
    fn a_server_that_is_not_there_says_so() {
        let err = probe_with("/nonexistent/codex", &[], Duration::from_secs(1)).expect_err("no binary");
        assert!(err.contains("could not start"), "{err}");
    }

    /// Re-measures the two durations the mapping is built on, against a real
    /// server. If Codex ever renames or re-lengths a window, the committed
    /// capture goes stale silently and only this says so.
    #[test]
    #[ignore = "drives the real `codex app-server` and needs a signed-in account"]
    fn the_real_codex_still_reports_the_captured_window_durations() {
        let probe = probe_codex().expect("a signed-in codex answers");

        let kinds: Vec<&str> = probe.windows.iter().map(|w| w.kind.as_str()).collect();
        assert_eq!(
            kinds,
            ["five_hour", "seven_day"],
            "the committed capture in dev/fixtures/usage/ names 300 and 10080 minutes: {probe:?}"
        );
        assert!(probe
            .windows
            .iter()
            .all(|w| w.utilization.is_some_and(|u| (0.0..=1.0).contains(&u))));
        assert!(
            probe.plan_type.is_some(),
            "the plan rides on the same exchange: {probe:?}"
        );
    }
}
