//! Asking a agent who is signed in, and reading the three different answers
//! back.
//!
//! **Unknown is a first-class outcome, and it is never spelled "signed out".**
//! Everything in this module leans that way: a probe that times out, a binary
//! that is not there, output nothing here knows how to read - all of it is
//! [`SignIn::Unknown`]. The asymmetry is the whole argument. A wrong "signed
//! out" tells a user their working account is broken and hides the agent from
//! the picker; a wrong "unknown" renders one line of neutral text. Same shape as
//! [`crate::health`]'s `VersionUnknown`, for the same reason.
//!
//! **Probes are bounded and never interactive.** They run through
//! [`crate::env::output_with_timeout`], which nulls stdin so a CLI that decides
//! to prompt hits EOF instead of waiting on a terminal nothing will ever type
//! into, and kills the child after the probe timeout. Phase 0 measured that
//! `claude auth login` is browser OAuth with no non-interactive variant, so
//! nothing here may ever be pointed at a login: this module runs `whoami_args`
//! and `logout_args`, both measured non-interactive, and the login itself goes
//! to a real PTY tab.
//!
//! The parsing is pure and the spawning is a thin shell around it, per
//! [[lesson_pure_core_for_global_stores]], so all three answer shapes are tested
//! against captured output rather than against whatever this machine happens to
//! have installed.

use serde::Serialize;

use crate::agents::{AccountsConfig, WhoamiKind};

/// Hint to a CLI that it must not open a browser.
///
/// Belt and braces rather than a measured control: none of the three probes
/// opens one (they are status subcommands), and the real guard is that
/// `output_with_timeout` gives the child no stdin and kills it on the timeout.
/// This is here so that a agent which *does* honour the convention has been
/// told, and so a future adapter pointing `whoami_args` at something chattier
/// starts from the quiet default.
const NO_BROWSER: (&str, &str) = ("NO_BROWSER", "1");

/// Whether a agent says somebody is signed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SignIn {
    /// Nobody asked, nothing answered, or the answer was not one this build
    /// knows how to read. Renders neutral and never blocks anything.
    ///
    /// The `Default`, and that is load-bearing rather than alphabetical: every
    /// path that gives up - no probe declared, no binary, a timeout - lands
    /// here, and any other default would turn giving up into an accusation.
    #[default]
    Unknown,
    SignedIn,
    SignedOut,
}

/// What one `whoami` probe learned.
///
/// `email` and `api_key_source` are `None` for every agent that does not
/// volunteer them, which is two of the three measured: Codex prints no identity
/// at all, and OpenCode counts providers rather than naming an account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Whoami {
    pub state: SignIn,
    pub email: Option<String>,
    /// The environment variable the agent says it is taking an API key from.
    ///
    /// Measured on `claude auth status`: with `ANTHROPIC_API_KEY` inherited it
    /// reports `apiKeySource: "ANTHROPIC_API_KEY"` and blanks `email`,
    /// `orgName` and `subscriptionType`. That is the agent's own statement
    /// about which credential it will bill against, which is a far better source
    /// for the warning than Sway reading its own environment and guessing which
    /// variables matter to which agent.
    pub api_key_source: Option<String>,
}

impl Whoami {
    fn state(state: SignIn) -> Self {
        Self { state, ..Self::default() }
    }
}

/// Read a completed probe's output.
///
/// Pure: it sees a run that finished, so "the process never ran" is the
/// caller's problem and is [`SignIn::Unknown`] there. Each arm was measured both
/// ways on 2026-08-14; see the `[accounts]` comment in each adapter's TOML.
pub fn parse_whoami(kind: WhoamiKind, exit_ok: bool, stdout: &str, stderr: &str) -> Whoami {
    match kind {
        WhoamiKind::ClaudeJson => parse_claude_json(stdout),
        // The exit code is the entire answer here, which is only true because
        // it was measured to be: Codex exits 0 signed in and 1 signed out, and
        // says so in prose on stderr that nothing parses.
        WhoamiKind::ExitCode => {
            let _ = stderr;
            Whoami::state(if exit_ok { SignIn::SignedIn } else { SignIn::SignedOut })
        }
        WhoamiKind::OpencodeCredentials => parse_opencode_credentials(stdout),
    }
}

/// `claude auth status`: a JSON object on stdout.
///
/// The exit code agrees with `loggedIn` (0 and 1 respectively) but is not what
/// is read, because it cannot carry the other two fields and a future non-zero
/// exit for some unrelated reason would flip the answer. Anything that is not
/// the expected object is unknown rather than signed out.
fn parse_claude_json(stdout: &str) -> Whoami {
    let Some(value) = first_json_object(stdout) else {
        return Whoami::state(SignIn::Unknown);
    };
    let state = match value.get("loggedIn").and_then(|v| v.as_bool()) {
        Some(true) => SignIn::SignedIn,
        Some(false) => SignIn::SignedOut,
        None => SignIn::Unknown,
    };
    let string = |key: &str| {
        value.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    };
    Whoami { state, email: string("email"), api_key_source: string("apiKeySource") }
}

/// The first `{...}` in the output, so a CLI that prefixes a line of its own
/// does not make the answer unreadable.
fn first_json_object(text: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end < start {
        return None;
    }
    match serde_json::from_str(&text[start..=end]) {
        Ok(serde_json::Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `opencode auth list`: a box-drawn table whose last line counts credentials.
///
/// The count is read rather than the exit status because **the exit status is
/// zero either way** (measured). An adapter that read the code would report
/// OpenCode signed in while its `auth.json` held nothing, which is the confident
/// false positive [`WhoamiKind`] exists to prevent.
///
/// A count of zero is a real signed-out answer; *no* count line at all is
/// unknown, since a reworded table is Sway failing to read rather than the user
/// failing to sign in.
fn parse_opencode_credentials(stdout: &str) -> Whoami {
    let count = stdout.lines().find_map(|line| {
        let mut previous: Option<u32> = None;
        for token in strip_ansi(line).split_whitespace() {
            if token == "credentials" || token == "credential" {
                return previous;
            }
            previous = token.parse().ok();
        }
        None
    });
    Whoami::state(match count {
        Some(0) => SignIn::SignedOut,
        Some(_) => SignIn::SignedIn,
        None => SignIn::Unknown,
    })
}

/// Drop CSI escape sequences so a coloured table parses as the text it renders
/// as. OpenCode writes its dim colour inline (`[90m`), and a token carrying one
/// would not parse as a number.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Build the command for any captured account probe.
///
/// One constructor for every one of them, so "the probe environment" is a
/// single thing with a single test rather than a rule each caller re-implements.
/// `home` is the adapter's own variable and the profile's canonical path, from
/// [`crate::accounts::spawn_env`]; the default profile passes `None` and so
/// inherits whatever login the user already had.
pub fn probe_command(
    path: &std::path::Path,
    args: &[String],
    home: Option<&(String, String)>,
) -> std::process::Command {
    let mut cmd = std::process::Command::new(path);
    cmd.args(args);
    cmd.env(NO_BROWSER.0, NO_BROWSER.1);
    if let Some((var, value)) = home {
        cmd.env(var, value);
    }
    cmd
}

/// Ask one agent who is signed in, bounded.
///
/// `None` args means the adapter declares no probe, which is unknown rather
/// than signed out: plenty of agents have no way to say, and reporting them
/// signed out would hide a working install behind a sign-in prompt it cannot
/// satisfy.
pub fn whoami(
    path: &std::path::Path,
    accounts: &AccountsConfig,
    home: Option<&(String, String)>,
) -> Whoami {
    let Some(kind) = accounts.whoami_kind else {
        return Whoami::state(SignIn::Unknown);
    };
    let mut cmd = probe_command(path, &accounts.whoami_args, home);
    let Some(out) = crate::env::output_with_timeout(&mut cmd) else {
        // A probe that timed out or could not spawn says nothing about the
        // account. It is the machine being slow, not the user being signed out.
        return Whoami::state(SignIn::Unknown);
    };
    parse_whoami(
        kind,
        out.status.success(),
        &String::from_utf8_lossy(&out.stdout),
        &String::from_utf8_lossy(&out.stderr),
    )
}

/// Sign a profile out, bounded.
///
/// `Err` carries whatever the agent said, because the removal flow reports a
/// failed logout rather than deleting the profile behind it: a profile forgotten
/// while its tokens are still live is a credential Sway has abandoned rather
/// than revoked.
///
/// An adapter with no `logout_args` never reaches this - that case is a question
/// for the user, not a command to run - and the caller checks first.
pub fn logout(
    path: &std::path::Path,
    accounts: &AccountsConfig,
    home: Option<&(String, String)>,
) -> Result<(), String> {
    if accounts.logout_args.is_empty() {
        return Err("this agent offers no logout command".into());
    }
    let mut cmd = probe_command(path, &accounts.logout_args, home);
    let out = crate::env::output_with_timeout(&mut cmd)
        .ok_or_else(|| "the logout command did not finish".to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let said = [&out.stderr, &out.stdout]
        .into_iter()
        .map(|s| String::from_utf8_lossy(s).trim().to_string())
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| format!("exit {:?}", out.status.code()));
    Err(said)
}

/// Where ADAPTERS.md documents what an adapter has to declare to get a sign-in
/// flow, which is the honest destination for a agent that declares none.
const ADAPTER_DOCS: &str = "https://github.com/skarif2/sway/blob/main/ADAPTERS.md";

/// How this agent can be signed in to, given what it declares.
///
/// Three rungs, and the ladder **degrades** rather than failing: every adapter
/// resolves to one of them, so no agent renders a sign-in card with nothing
/// on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LoginRoute {
    /// Run these args in a real PTY tab. Phase 0 measured that `claude auth
    /// login` is browser OAuth with no non-interactive variant and that
    /// `setup-token` is interactive too, so this rung is a terminal or nothing:
    /// a captured login would hang rather than fail.
    Terminal { program: String, args: Vec<String>, home: Option<(String, String)> },
    /// The agent states its own method, in its own words, and Sway relays it.
    ///
    /// Not a stub: this is already what happens. An ACP agent refusing
    /// `session/new` with `AuthRequired` carries its `authMethods`, and
    /// `chat::acp_transport::describe_session_failure` puts their description
    /// text in front of the user. Both measured agents put a literal command
    /// there ("Run `opencode auth login` in the terminal"), so relaying it beats
    /// anything Sway could invent.
    AgentStates,
    /// Nothing declared, nothing to relay. The link goes to what an adapter has
    /// to declare, because "no sign-in button" is a fact about the adapter file
    /// rather than about the agent.
    Docs { url: String },
}

/// Pick the rung for one adapter and profile.
///
/// **`login_args` outranks the ACP rung**, which inverts the order the phase
/// plan lists the three in, and deliberately. OpenCode is both: it speaks ACP
/// *and* declares `auth login`. Its own `authMethods` description says to run
/// that very command in a terminal, so preferring the ACP rung would replace a
/// button that signs the user in with a sentence telling them to do it
/// themselves. The ACP rung is the fallback for an agent Sway has no login
/// command for, which is what it was always doing.
pub fn login_route(
    adapter: &crate::agents::AgentAdapter,
    home: Option<(String, String)>,
) -> LoginRoute {
    let args = adapter.accounts.as_ref().map(|a| a.login_args.clone()).unwrap_or_default();
    if !args.is_empty() {
        return LoginRoute::Terminal { program: adapter.program.clone(), args, home };
    }
    if adapter.chat.as_ref().is_some_and(|c| {
        matches!(c.transport, crate::agents::ChatTransport::Acp)
    }) {
        return LoginRoute::AgentStates;
    }
    LoginRoute::Docs { url: ADAPTER_DOCS.to_string() }
}

/// The default profile's login route, for the setup steps on an agent's page.
///
/// `agent_accounts` answers this too, but only for an adapter that declares
/// `[accounts]` and at the price of one `whoami` probe per profile. The setup
/// page needs the route for *any* signed-out agent - the ladder degrades
/// rather than failing - and needs no probe to get it, so this is a plain read
/// of the adapter. Home is `None` because the default profile is the login the
/// user already has: no variable set is what resolves it.
#[tauri::command]
pub fn agent_login_route(adapter_id: String) -> Result<LoginRoute, String> {
    let adapter = crate::agents::find(&adapter_id)
        .cloned()
        .ok_or_else(|| format!("no agent adapter `{adapter_id}`"))?;
    Ok(login_route(&adapter, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(kind: Option<WhoamiKind>) -> AccountsConfig {
        AccountsConfig {
            home_env: Some("X_HOME".into()),
            home_default: None,
            login_args: vec![],
            logout_args: vec!["logout".into()],
            whoami_args: vec!["status".into()],
            whoami_kind: kind,
            supports_isolation: true,
        }
    }

    // --- claude: JSON, captured from the real CLI both ways ---

    const CLAUDE_IN: &str = r#"{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "skarif2@gmail.com",
  "orgId": "e065b006-25be-40a7-96cb-b55881e1b0a0",
  "orgName": "skarif2@gmail.com's Organization",
  "subscriptionType": "max"
}"#;

    const CLAUDE_OUT: &str = r#"{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}"#;

    /// With an API key inherited the CLI still reports `loggedIn: true` while
    /// blanking the account: same run, captured with `ANTHROPIC_API_KEY` set.
    const CLAUDE_WITH_KEY: &str = r#"{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "apiKeySource": "ANTHROPIC_API_KEY",
  "email": null,
  "orgId": null,
  "orgName": null,
  "subscriptionType": null
}"#;

    #[test]
    fn claude_reports_its_account_from_json() {
        let answer = parse_whoami(WhoamiKind::ClaudeJson, true, CLAUDE_IN, "");
        assert_eq!(answer.state, SignIn::SignedIn);
        assert_eq!(answer.email.as_deref(), Some("skarif2@gmail.com"));
        assert_eq!(answer.api_key_source, None);
    }

    #[test]
    fn claude_reports_signed_out_from_json() {
        let answer = parse_whoami(WhoamiKind::ClaudeJson, false, CLAUDE_OUT, "");
        assert_eq!(answer.state, SignIn::SignedOut);
        assert_eq!(answer.email, None);
    }

    /// The billing-override warning's actual producer. The agent names the
    /// variable itself, so the warning does not depend on Sway knowing which
    /// environment variables matter to which agent.
    #[test]
    fn an_inherited_api_key_is_reported_by_the_agent_not_guessed() {
        let answer = parse_whoami(WhoamiKind::ClaudeJson, true, CLAUDE_WITH_KEY, "");
        assert_eq!(answer.api_key_source.as_deref(), Some("ANTHROPIC_API_KEY"));
        // Still signed in, so the warning is a notice beside a working session
        // rather than a reason to withhold one.
        assert_eq!(answer.state, SignIn::SignedIn);
        // And the account name is gone, which is why duplicate detection cannot
        // work while a key is inherited.
        assert_eq!(answer.email, None);
    }

    /// A reworded or broken answer must not read as signed out.
    #[test]
    fn unreadable_claude_output_is_unknown_rather_than_signed_out() {
        for text in ["", "not json at all", "{}", r#"{"loggedIn":"yes"}"#] {
            assert_eq!(
                parse_whoami(WhoamiKind::ClaudeJson, false, text, "").state,
                SignIn::Unknown,
                "{text:?} should be unknown"
            );
        }
    }

    #[test]
    fn a_json_object_after_a_line_of_noise_still_parses() {
        let text = format!("warning: something\n{CLAUDE_IN}");
        assert_eq!(parse_whoami(WhoamiKind::ClaudeJson, true, &text, "").state, SignIn::SignedIn);
    }

    // --- codex: the exit code is the whole answer ---

    #[test]
    fn codex_reads_its_exit_code() {
        assert_eq!(
            parse_whoami(WhoamiKind::ExitCode, true, "", "Logged in using ChatGPT\n").state,
            SignIn::SignedIn
        );
        assert_eq!(
            parse_whoami(WhoamiKind::ExitCode, false, "", "Not logged in\n").state,
            SignIn::SignedOut
        );
    }

    /// Codex prints no account name, and inventing a parse of its prose would be
    /// a guess about a sentence nobody promised to keep.
    #[test]
    fn codex_reports_no_account_name() {
        let answer = parse_whoami(WhoamiKind::ExitCode, true, "", "Logged in using ChatGPT\n");
        assert_eq!(answer.email, None);
        assert_eq!(answer.api_key_source, None);
    }

    // --- opencode: a count, from output that exits 0 either way ---

    const OPENCODE_IN: &str =
        "\u{250c}  Credentials \u{1b}[90m~/.local/share/opencode/auth.json\n\
         \u{2502}\n\
         \u{25cf}  GitHub Copilot \u{1b}[90moauth\n\
         \u{2502}\n\
         \u{2514}  1 credentials\n";

    const OPENCODE_OUT: &str = "\u{250c}  Credentials \u{1b}[90m/tmp/x/opencode/auth.json\n\
         \u{2502}\n\
         \u{2514}  0 credentials\n";

    /// The reason `whoami_kind` exists. Both of these exit 0, so an adapter
    /// reading the exit status would call the second one signed in.
    #[test]
    fn opencode_reads_its_credential_count_because_the_exit_code_says_nothing() {
        assert_eq!(
            parse_whoami(WhoamiKind::OpencodeCredentials, true, OPENCODE_IN, "").state,
            SignIn::SignedIn
        );
        assert_eq!(
            parse_whoami(WhoamiKind::OpencodeCredentials, true, OPENCODE_OUT, "").state,
            SignIn::SignedOut
        );
        assert_eq!(
            parse_whoami(WhoamiKind::ExitCode, true, OPENCODE_OUT, "").state,
            SignIn::SignedIn,
            "which is exactly the false positive the kind prevents"
        );
    }

    /// The `Credentials` header carries no count and must not be mistaken for
    /// the total, and a reworded table is unknown rather than signed out.
    #[test]
    fn an_unreadable_opencode_table_is_unknown() {
        assert_eq!(
            parse_whoami(WhoamiKind::OpencodeCredentials, true, "\u{250c}  Credentials /tmp/a\n", "")
                .state,
            SignIn::Unknown
        );
        assert_eq!(
            parse_whoami(WhoamiKind::OpencodeCredentials, true, "providers: none\n", "").state,
            SignIn::Unknown
        );
    }

    // --- the probe environment, asserted once for every probe ---

    /// `NO_BROWSER` on every captured probe, not on the one that happened to be
    /// written first. Both callers build their command here, so this covers
    /// `whoami` and `logout` together.
    #[test]
    fn every_probe_runs_with_no_browser_set() {
        let path = std::path::Path::new("/bin/true");
        let cfg = config(Some(WhoamiKind::ClaudeJson));
        for args in [&cfg.whoami_args, &cfg.logout_args] {
            let cmd = probe_command(path, args, None);
            let found = cmd
                .get_envs()
                .any(|(k, v)| k == NO_BROWSER.0 && v == Some(std::ffi::OsStr::new(NO_BROWSER.1)));
            assert!(found, "a probe running {args:?} must be told not to open a browser");
        }
    }

    /// Every probe in this module is bounded, asserted structurally because the
    /// behavioural version costs a real timeout of wall clock per run.
    ///
    /// The bound is what stops a agent that decides to prompt from stranding
    /// the memoized health sweep and every caller queued behind it, per
    /// `gotchas#A subprocess probe inside a memoized sweep must be bounded`. It
    /// is also the other half of "non-interactive": `output_with_timeout` gives
    /// the child no stdin, so a prompt hits EOF instead of waiting forever.
    ///
    /// The needles are assembled with `concat!` for the same reason as the
    /// custody test below: a literal here would match itself.
    #[test]
    fn every_subprocess_in_this_module_goes_through_the_bounded_runner() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/auth.rs"),
        )
        .expect("this file is readable");
        let unbounded = [
            concat!(".", "output()"),
            concat!(".", "status()"),
            concat!(".", "spawn()"),
        ];
        let offenders: Vec<(usize, &str)> = source
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim_start().starts_with("//"))
            .filter(|(_, line)| unbounded.iter().any(|needle| line.contains(needle)))
            .map(|(n, line)| (n + 1, line.trim()))
            .collect();
        assert!(offenders.is_empty(), "run it through output_with_timeout: {offenders:?}");
        // The positive half is behavioural rather than counted here:
        // `a_successful_logout_is_ok` and `a_failing_logout_reports_what_the_agent_said`
        // really do run `/bin/sh`, so a probe that spawned nothing would fail
        // them. A `matches().count()` would only pin how often this file happens
        // to say the name.
    }

    #[test]
    fn a_probe_for_an_added_profile_carries_its_home() {
        let home = ("CLAUDE_CONFIG_DIR".to_string(), "/canonical/work".to_string());
        let cmd = probe_command(std::path::Path::new("/bin/true"), &["status".into()], Some(&home));
        let set: Vec<_> = cmd
            .get_envs()
            .filter(|(k, _)| *k == std::ffi::OsStr::new("CLAUDE_CONFIG_DIR"))
            .collect();
        assert_eq!(set.len(), 1);
        assert_eq!(set[0].1, Some(std::ffi::OsStr::new("/canonical/work")));
    }

    /// The default profile is the variable left unset, all the way down to the
    /// probe: setting it to anything at all would ask about a different account
    /// than the one a default session runs as.
    #[test]
    fn a_probe_for_the_default_profile_sets_no_home() {
        let cmd = probe_command(std::path::Path::new("/bin/true"), &["status".into()], None);
        assert_eq!(cmd.get_envs().count(), 1, "only NO_BROWSER");
    }

    // --- degrading rather than lying ---

    /// An adapter that declares no probe is unknown. Reporting it signed out
    /// would put a sign-in prompt in front of a agent that has no sign-in.
    #[test]
    fn an_adapter_with_no_probe_is_unknown_not_signed_out() {
        let cfg = config(None);
        let answer = whoami(std::path::Path::new("/bin/true"), &cfg, None);
        assert_eq!(answer.state, SignIn::Unknown);
    }

    /// A probe that cannot run at all is unknown too, and it must not spawn
    /// anything that hangs.
    #[test]
    fn a_probe_whose_binary_is_missing_is_unknown() {
        let cfg = config(Some(WhoamiKind::ExitCode));
        let answer = whoami(std::path::Path::new("/nonexistent/sway-probe"), &cfg, None);
        assert_eq!(answer.state, SignIn::Unknown);
    }

    /// A agent with no logout is a question for the user, never a silent
    /// success: the caller has to ask before it deletes anything.
    #[test]
    fn logout_refuses_when_the_adapter_declares_none() {
        let mut cfg = config(Some(WhoamiKind::ExitCode));
        cfg.logout_args.clear();
        assert!(logout(std::path::Path::new("/bin/true"), &cfg, None).is_err());
    }

    #[test]
    fn a_failing_logout_reports_what_the_agent_said() {
        let mut cfg = config(Some(WhoamiKind::ExitCode));
        cfg.logout_args = vec!["-c".into(), "echo could not reach the server >&2; exit 1".into()];
        let err = logout(std::path::Path::new("/bin/sh"), &cfg, None).unwrap_err();
        assert!(err.contains("could not reach the server"), "{err}");
    }

    #[test]
    fn a_successful_logout_is_ok() {
        let mut cfg = config(Some(WhoamiKind::ExitCode));
        cfg.logout_args = vec!["-c".into(), "exit 0".into()];
        assert!(logout(std::path::Path::new("/bin/sh"), &cfg, None).is_ok());
    }

    /// The custody boundary, where Phase 0 measured the secrets actually are.
    ///
    /// On darwin `claude` keeps its tokens in the login Keychain under
    /// `"Claude Code-credentials-" + sha256($CLAUDE_CONFIG_DIR)[:8]`, so
    /// inspecting a profile home proves nothing: it holds no credentials to find.
    /// What can be asserted is that Sway never goes near the place that does.
    // --- the login ladder ---

    fn bundled(id: &str) -> crate::agents::AgentAdapter {
        crate::agents::find(id).unwrap_or_else(|| panic!("{id} ships bundled")).clone()
    }

    #[test]
    fn a_agent_with_login_args_opens_a_terminal_carrying_the_profile_home() {
        let home = Some(("CLAUDE_CONFIG_DIR".to_string(), "/canonical/work".to_string()));
        match login_route(&bundled("claude"), home.clone()) {
            LoginRoute::Terminal { program, args, home: carried } => {
                assert_eq!(program, "claude");
                assert_eq!(args, ["auth", "login"]);
                assert_eq!(carried, home, "signing in to a profile must reach that profile's home");
            }
            other => panic!("claude should open a terminal, got {other:?}"),
        }
    }

    /// The default profile signs in with the variable unset, exactly as it runs.
    #[test]
    fn the_default_profile_signs_in_with_no_home_variable() {
        match login_route(&bundled("claude"), None) {
            LoginRoute::Terminal { home, .. } => assert_eq!(home, None),
            other => panic!("got {other:?}"),
        }
    }

    /// The precedence inversion, pinned: OpenCode is an ACP agent *and* declares
    /// `auth login`, and taking the ACP rung would swap a working button for a
    /// sentence telling the user to run that command themselves.
    #[test]
    fn a_login_command_outranks_relaying_the_agents_own_instructions() {
        let opencode = bundled("opencode");
        assert!(
            opencode.chat.as_ref().is_some_and(|c| matches!(
                c.transport,
                crate::agents::ChatTransport::Acp
            )),
            "this test is only meaningful while opencode speaks ACP"
        );
        assert!(matches!(login_route(&opencode, None), LoginRoute::Terminal { .. }));
    }

    #[test]
    fn an_acp_agent_with_no_login_command_relays_what_the_agent_says() {
        let mut agent = bundled("opencode");
        agent.accounts = None;
        assert_eq!(login_route(&agent, None), LoginRoute::AgentStates);
    }

    /// Neither rung. The link is to what an adapter has to declare, because the
    /// missing button is a fact about the adapter file.
    ///
    /// Built rather than taken from the bundled four, none of which lands here:
    /// all four declare `[chat]`, so the ACP rung catches gemini. The shape that
    /// does land here is the minimal adapter ADAPTERS.md documents, which is
    /// what a user dropping a four-line TOML into `~/.config/sway/agents/`
    /// writes, so the rung has a real producer even though nothing bundled is
    /// one.
    #[test]
    fn a_agent_declaring_neither_gets_a_documentation_link() {
        let minimal = crate::agents::test_adapter("some-agent");
        assert!(minimal.accounts.is_none() && minimal.chat.is_none(), "declares neither");
        match login_route(&minimal, None) {
            LoginRoute::Docs { url } => assert!(url.starts_with("https://"), "{url}"),
            other => panic!("got {other:?}"),
        }
    }

    /// Gemini is the near miss worth naming: it declares no `[accounts]`, so it
    /// has no login command, but it does speak ACP and so relays its own
    /// instructions rather than falling through to a link.
    #[test]
    fn an_acp_agent_with_no_accounts_table_still_beats_a_documentation_link() {
        let gemini = bundled("gemini");
        assert!(gemini.accounts.is_none());
        assert_eq!(login_route(&gemini, None), LoginRoute::AgentStates);
    }

    /// Every bundled adapter reaches a rung, so no card is ever a dead entry.
    #[test]
    fn every_bundled_adapter_resolves_to_a_rung() {
        for adapter in crate::agents::registry() {
            let _ = login_route(adapter, None);
        }
    }

    /// Source text rather than behaviour, because the claim is "no code path
    /// does this", which no single run can demonstrate.
    ///
    /// The file needles are the other half, kept for the agents whose tokens
    /// really are on disk: OpenCode's live in `auth.json` under its data dir,
    /// where the Keychain finding says nothing. Sway reads neither.
    ///
    /// Every needle is assembled by `concat!` so that none of them appears as a
    /// contiguous literal in this file. Otherwise the test would have to exempt
    /// its own source, and an exempted file is the one place a violation could
    /// then hide.
    #[test]
    fn sway_never_reaches_into_the_keychain() {
        let needles = [
            concat!("Command::new(\"", "security", "\")"),
            concat!("\"/usr/bin/", "security", "\""),
            concat!("Claude Code", "-credentials"),
            concat!("find-generic", "-password"),
            concat!(".creden", "tials.json"),
            concat!("\"auth", ".json\""),
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src is readable").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                for (n, line) in text.lines().enumerate() {
                    // Comments are where the measurement is written down, and
                    // writing down where a agent keeps its tokens is the
                    // opposite of reaching for them. The claim is about code.
                    if line.trim_start().starts_with("//") {
                        continue;
                    }
                    if needles.iter().any(|needle| line.contains(needle)) {
                        offenders.push(format!("{}:{}", path.display(), n + 1));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "Sway must never read the agent's credentials: {offenders:?}"
        );
    }
}
