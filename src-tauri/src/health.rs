// Adapter health: does the agent CLI this adapter launches actually exist on
// this machine, and does its version match what the adapter was captured
// against? Settings renders one card per adapter from this.
//
// Two rules drive the design, both about not lying to the user:
//
// 1. Resolution goes through the login-shell PATH (`crate::env::resolve_binary`),
//    never the GUI process PATH. An agent installed via nvm/asdf/mise is
//    invisible to a naive `which` from a Finder-launched app, and reporting it
//    "not installed" would send the user chasing a problem that isn't there.
//
// 2. Unknown is its own outcome, not a failure. An agent whose `--version`
//    prints a multi-line banner (or an adapter carrying no `verified_against`)
//    yields `VersionUnknown`, which the card renders as neutral text. Guessing
//    at drift from an unparseable banner would flag healthy setups as broken.
//
// Checks spawn subprocesses, so the command is async (Tauri runs it off the
// main thread) and the whole sweep is cached: a UI that stalls on every
// Settings open would be a far bigger cost than a slightly stale card.
//
// 3. Sign-in rides this same sweep rather than getting a cache of its own. The
//    two questions are asked at the same moments, by the same screens, and
//    invalidated by the same events (an install, a completed login), so a second
//    cache would be a second thing to remember to invalidate and a second chance
//    for the picker and the Agents cards to disagree. The cost is a second
//    bounded subprocess per adapter that declares `whoami_args`, on a sweep that
//    already runs once per app run. See `crate::auth`.
//
// The cache is invalidatable rather than lifetime-memoized, which it used to
// be. "Cached for the app's lifetime" was correct only while nothing inside
// Tori could change the answer; once a agent can be installed or signed in
// from the app, a `OnceLock` would show `NotFound` for a binary the user just
// installed until they restarted. See `HealthCache`.

use std::path::Path;

use serde::Serialize;

use crate::agents::{self, AgentAdapter};
use crate::auth::SignIn;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BinaryStatus {
    /// The launch binary does not resolve on the login PATH.
    NotFound,
    /// Found, but either the CLI's `--version` was unparseable or the adapter
    /// declares no `verified_against` to compare it with. Renders neutral.
    VersionUnknown,
    /// Found, and the version matches what the adapter was captured against.
    VersionMatch,
    /// Found, but running a different version than the adapter was captured
    /// against. The adapter probably still works; it is a warning, not an error.
    VersionDrift,
}

/// What the sweep learned about one account of one adapter.
///
/// Per profile because the send gate is per profile: a draft on the Globex
/// account must not be blocked by the personal account being signed out, and a
/// draft on the personal one must not be let through because Globex is signed in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileHealth {
    pub id: String,
    /// The user's own name for this account, so a surface can say "Globex"
    /// without a second command. Carried here rather than fetched per chat
    /// header: the sweep already reads `accounts.json` to enumerate profiles.
    pub label: String,
    pub sign_in: SignIn,
    pub account: Option<String>,
    pub api_key_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealth {
    pub id: String,
    pub label: String,
    /// The adapter's configured launch binary, e.g. `claude`.
    pub program: String,
    pub status: BinaryStatus,
    /// Whether the agent says anybody is signed in, **for the default
    /// profile**.
    ///
    /// Deliberately a separate axis from `status` rather than a fifth
    /// `BinaryStatus`: installed and signed-in are two independent facts, and
    /// collapsing them would make "installed, version 2.1.231" and "signed out"
    /// mutually exclusive when they are routinely both true. The card renders
    /// them as one sentence; the picker reads both.
    ///
    /// The default profile, because that is what a session started without
    /// choosing an account runs as. Per-profile answers come from
    /// `crate::accounts::account_status`, which is a different question asked by
    /// a different screen.
    pub sign_in: SignIn,
    /// The account the agent named, when it names one. Only Claude does, of
    /// the three measured.
    pub account: Option<String>,
    /// The environment variable the agent says it is taking an API key from.
    /// `Some` means a subscription login is being overridden by an inherited
    /// key, which is a warning and never a block.
    pub api_key_source: Option<String>,
    /// The program the chat surface runs through, when it is a different one
    /// from `program` and it does not resolve on the login PATH.
    ///
    /// Its own axis rather than a fifth `BinaryStatus`, for the same reason
    /// `sign_in` is: installed for the terminal and startable for chat are
    /// independent facts. codex and pi run their chat through `npx`, so the
    /// launch binary can be present while a chat cannot spawn.
    pub chat_program_missing: Option<String>,
    /// Absolute path the binary resolved to, when found.
    pub path: Option<String>,
    /// Version parsed out of `--version`, when it was parseable.
    pub version: Option<String>,
    /// The version string the adapter declares it was captured against.
    pub verified_against: Option<String>,
    /// Where sessions are discovered from, and whether that path exists yet.
    ///
    /// `None` for an adapter that reaches its sessions over its protocol: there
    /// is no directory to name, and naming one that never exists would read as a
    /// broken install rather than as a different design.
    pub sessions_dir: Option<String>,
    pub sessions_dir_exists: bool,
    /// Capability flags, rendered as chips.
    pub hooks: bool,
    pub needs_you: bool,
    /// Path of the user TOML overriding this adapter, when one is loaded.
    pub override_path: Option<String>,
    /// Every account of this adapter, default first, as `profiles_for` orders
    /// them. One bounded `whoami` each, on the sweep that already runs once per
    /// app run and re-runs only when something could have changed the answer.
    ///
    /// This is what `agent_accounts` reads. Before it existed that command
    /// spawned a probe per profile on **every call**, which is every Settings
    /// open, so a second account made the accounts screen cost a subprocess it
    /// had already paid for.
    pub profiles: Vec<ProfileHealth>,
}

/// Pull a version out of a CLI's `--version` output.
///
/// Deliberately strict: a multi-line banner yields `None` rather than a guess
/// scraped off whichever line happened to hold digits first. `None` becomes
/// `VersionUnknown`, which renders neutral, so being wrong here would turn a
/// working install into a false drift warning.
pub(crate) fn parse_version(output: &str) -> Option<String> {
    let mut lines = output.lines().map(str::trim).filter(|l| !l.is_empty());
    let line = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    line.split_whitespace().find_map(|token| {
        let candidate = token.trim_start_matches('v').trim_matches(|c: char| c == '(' || c == ')');
        let looks_semver = candidate.contains('.')
            && candidate.split('.').all(|part| {
                !part.is_empty() && part.chars().next().is_some_and(|c| c.is_ascii_digit())
            });
        looks_semver.then(|| candidate.to_string())
    })
}

/// Compare a running version against the adapter's `verified_against`. Both
/// sides go through `parse_version` so `"claude 1.18.3"` compares equal to a
/// CLI printing `"1.18.3"`.
///
/// Shared with `crate::lsp`'s server health so a language server's card
/// reports drift by the same rules an agent's does.
pub(crate) fn compare(running: Option<&str>, verified: Option<&str>) -> BinaryStatus {
    match (running, verified.and_then(parse_version)) {
        (Some(running), Some(verified)) => {
            if running == verified {
                BinaryStatus::VersionMatch
            } else {
                BinaryStatus::VersionDrift
            }
        }
        _ => BinaryStatus::VersionUnknown,
    }
}

/// Shared with `crate::lsp`'s server health: probing a language server binary
/// for a version has the same shape and the same stderr fallback.
pub(crate) fn run_version(path: &Path) -> Option<String> {
    // Bounded: an agent CLI that blocks on `--version` (prompting for auth, say)
    // would otherwise strand the memoized sweep and every later caller with it.
    let out = crate::env::output_with_timeout(
        std::process::Command::new(path).arg("--version"),
    )?;
    // Some CLIs write their version to stderr; take whichever stream spoke.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let text = if stdout.trim().is_empty() {
        String::from_utf8_lossy(&out.stderr).into_owned()
    } else {
        stdout.into_owned()
    };
    parse_version(&text)
}

fn check(adapter: &AgentAdapter) -> AgentHealth {
    let resolved = crate::env::resolve_binary(&adapter.program);
    let version = resolved.as_deref().and_then(run_version);
    let status = match resolved {
        None => BinaryStatus::NotFound,
        Some(_) => compare(version.as_deref(), adapter.verified_against.as_deref()),
    };
    let sessions_dir = adapter.discovery_path();
    // Only for a binary that exists and an adapter that declares a probe.
    // Everything else is `Unknown` by construction, which costs no subprocess
    // and never reports a missing agent as signed out.
    let account = match (resolved.as_deref(), adapter.accounts.as_ref()) {
        // Not while the default home is absent: probing with the variable unset creates it.
        (Some(path), Some(accounts)) if crate::accounts::default_present(adapter) => {
            crate::auth::whoami(path, accounts, None)
        }
        _ => crate::auth::Whoami::default(),
    };
    let profiles = profile_health(adapter, resolved.as_deref(), &account);
    let chat_program_missing = chat_program_missing(adapter);

    AgentHealth {
        id: adapter.id.clone(),
        label: adapter.label.clone(),
        program: adapter.program.clone(),
        status,
        chat_program_missing,
        sign_in: account.state,
        account: account.email,
        api_key_source: account.api_key_source,
        path: resolved.map(|p| p.to_string_lossy().into_owned()),
        version,
        verified_against: adapter.verified_against.clone(),
        sessions_dir: sessions_dir.map(|d| d.to_string_lossy().into_owned()),
        sessions_dir_exists: sessions_dir.is_some_and(|d| d.exists()),
        hooks: adapter.hooks,
        needs_you: adapter.needs_you,
        override_path: adapter.is_override().then(|| adapter.source.clone()),
        profiles,
    }
}

/// The chat program's name when it is not the launch binary and is not on the
/// login PATH. Whether the package behind an `npx -y` is cached or fetchable
/// is a network question a PATH lookup cannot answer, so it is not asked.
fn chat_program_missing(adapter: &AgentAdapter) -> Option<String> {
    let program = &adapter.chat.as_ref()?.program;
    if *program == adapter.program || crate::env::resolve_binary(program).is_some() {
        return None;
    }
    Some(program.clone())
}

/// One `whoami` per account, reusing the default's answer rather than asking
/// twice.
///
/// The default profile is the home variable left unset, which is exactly the
/// probe `check` has already run, so re-probing it here would double the
/// subprocess cost of every sweep to learn nothing.
fn profile_health(
    adapter: &AgentAdapter,
    resolved: Option<&Path>,
    default_answer: &crate::auth::Whoami,
) -> Vec<ProfileHealth> {
    let file = crate::accounts::load();
    crate::accounts::profiles_for(&file, &adapter.id)
        .into_iter()
        .map(|p| {
            let answer = match (p.is_default(), resolved, adapter.accounts.as_ref()) {
                (true, _, _) => default_answer.clone(),
                (false, Some(path), Some(accounts)) => {
                    // Through `spawn_env`, so the probe and the session it is
                    // about cannot disagree about which home this profile runs
                    // in. An incoherent profile is Unknown rather than probed
                    // against the wrong account.
                    let home = crate::accounts::spawn_env(accounts, &p).ok().flatten();
                    crate::auth::whoami(path, accounts, home.as_ref())
                }
                _ => crate::auth::Whoami::default(),
            };
            ProfileHealth {
                label: p.label,
                id: p.id,
                sign_in: answer.state,
                account: answer.email,
                api_key_source: answer.api_key_source,
            }
        })
        .collect()
}

/// A memoized sweep that can be told it is wrong.
///
/// This used to be a `OnceLock`, which was right while the answer could not
/// change: nothing inside Tori installed a binary or signed anyone in, so
/// "computed once per app run" and "correct" were the same statement. They stop
/// being the same the moment an install or a login happens in-app, and a
/// `OnceLock` has no way back: the user would see `NotFound` for a agent they
/// just installed until they restarted the app.
///
/// The sweep function is a parameter rather than hardcoded so the cache's rules
/// can be tested without touching the real PATH, per
/// [[lesson_pure_core_for_global_stores]]. Tests own a local `HealthCache`
/// instead of racing on the global one, which matters because Rust runs them in
/// parallel threads of one process.
struct HealthCache(std::sync::Mutex<Option<Vec<AgentHealth>>>);

impl HealthCache {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    /// The cached sweep, running `sweep` only if there is nothing cached.
    ///
    /// The lock is held across `sweep`, which is deliberate and is what the
    /// `OnceLock` did too: the probes are bounded (see
    /// [`crate::env::output_with_timeout`] and
    /// `gotchas#A subprocess probe inside a memoized sweep must be bounded`), so
    /// a queued caller waits for one sweep rather than starting a second one.
    /// Dropping the lock first would let two callers probe every binary at once.
    fn get_or_sweep(&self, sweep: impl FnOnce() -> Vec<AgentHealth>) -> Vec<AgentHealth> {
        // A poisoned lock means a previous sweep panicked. Recovering the guard
        // and re-sweeping is better than propagating: this is a cache, and the
        // alternative is an Agents panel that stays broken until restart.
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = slot.as_ref() {
            return cached.clone();
        }
        let fresh = sweep();
        *slot = Some(fresh.clone());
        fresh
    }

    fn invalidate(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

static HEALTH: HealthCache = HealthCache::new();

fn sweep() -> Vec<AgentHealth> {
    agents::registry().iter().map(check).collect()
}

/// Health for every registered adapter, probed once and then cached until
/// something invalidates it.
#[tauri::command]
pub async fn agent_health() -> Vec<AgentHealth> {
    HEALTH.get_or_sweep(sweep)
}

/// What the cached sweep says about every account of one adapter.
///
/// The accounts screen's whole answer, so opening Settings costs no subprocess.
/// It used to probe every profile on every call, which made "cached until an
/// explicit refresh" false of exactly the accounts a user added on purpose.
pub async fn cached_profiles(adapter_id: &str) -> Vec<ProfileHealth> {
    HEALTH
        .get_or_sweep(sweep)
        .into_iter()
        .find(|h| h.id == adapter_id)
        .map(|h| h.profiles)
        .unwrap_or_default()
}

/// What the cached sweep says about one adapter's **default** profile.
///
/// The narrow read, for callers that only ever mean the account a session
/// started without choosing one runs as.
pub async fn cached_sign_in(adapter_id: &str) -> crate::auth::Whoami {
    HEALTH
        .get_or_sweep(sweep)
        .into_iter()
        .find(|h| h.id == adapter_id)
        .map(|h| crate::auth::Whoami {
            state: h.sign_in,
            email: h.account,
            api_key_source: h.api_key_source,
        })
        .unwrap_or_default()
}

/// Re-probe every adapter now and return the new answer.
///
/// The caller is anything that could have changed the answer: an in-app
/// install, a completed login, a user pressing refresh. It is a separate
/// command rather than a parameter on `agent_health` so the ordinary read stays
/// a read, and nothing can force a full sweep by passing the wrong argument on
/// a hot path.
#[tauri::command]
pub async fn refresh_agent_health() -> Vec<AgentHealth> {
    HEALTH.invalidate();
    HEALTH.get_or_sweep(sweep)
}


#[cfg(test)]
mod tests {
    use super::*;

    // --- the invalidatable cache ---
    //
    // Driven through a local `HealthCache` with a counting sweep, so these
    // assert the caching rules rather than what happens to be installed on the
    // machine running them, and do not race the global cache across threads.

    fn health_named(id: &str, status: BinaryStatus) -> Vec<AgentHealth> {
        vec![AgentHealth {
            id: id.into(),
            label: id.into(),
            program: id.into(),
            status,
            chat_program_missing: None,
            sign_in: SignIn::Unknown,
            account: None,
            api_key_source: None,
            path: None,
            version: None,
            verified_against: None,
            sessions_dir: None,
            sessions_dir_exists: false,
            hooks: false,
            needs_you: false,
            override_path: None,
            profiles: Vec::new(),
        }]
    }

    /// The card said Ready for codex and pi with no `npx` on the machine: health
    /// resolved only the launch binary, and chat runs through a different one.
    #[test]
    fn a_chat_program_that_is_not_the_launch_binary_is_resolved_too() {
        let missing = agents::test_adapter_with_chat("sh", "tori-no-such-chat-program");
        assert_eq!(
            chat_program_missing(&missing).as_deref(),
            Some("tori-no-such-chat-program")
        );

        let present = agents::test_adapter_with_chat("tori-no-such-launch", "sh");
        assert_eq!(chat_program_missing(&present), None, "found on PATH is not missing");

        let same = agents::test_adapter_with_chat("tori-no-such-launch", "tori-no-such-launch");
        assert_eq!(chat_program_missing(&same), None, "the launch binary is `status`'s question");

        assert_eq!(chat_program_missing(&agents::test_adapter("sh")), None, "no chat table");
    }

    /// The reason the cache exists at all: Settings must not re-probe every
    /// binary each time it is opened.
    #[test]
    fn a_second_read_does_not_re_probe() {
        let cache = HealthCache::new();
        let sweeps = std::cell::Cell::new(0);
        let sweep = || {
            sweeps.set(sweeps.get() + 1);
            health_named("claude", BinaryStatus::NotFound)
        };

        let first = cache.get_or_sweep(sweep);
        let second = cache.get_or_sweep(sweep);

        assert_eq!(sweeps.get(), 1, "opening Settings twice must probe once");
        assert_eq!(first.len(), second.len());
        assert_eq!(second[0].status, BinaryStatus::NotFound);
    }

    /// The reason it is no longer a `OnceLock`: an install inside the app has
    /// to be visible without a restart.
    #[test]
    fn invalidating_lets_an_install_show_up_without_a_restart() {
        let cache = HealthCache::new();
        assert_eq!(
            cache.get_or_sweep(|| health_named("claude", BinaryStatus::NotFound))[0].status,
            BinaryStatus::NotFound
        );

        // Nothing changed yet, so the stale answer is still the answer.
        assert_eq!(
            cache.get_or_sweep(|| health_named("claude", BinaryStatus::VersionMatch))[0].status,
            BinaryStatus::NotFound,
            "without invalidation the cache must not silently re-probe"
        );

        cache.invalidate();
        assert_eq!(
            cache.get_or_sweep(|| health_named("claude", BinaryStatus::VersionMatch))[0].status,
            BinaryStatus::VersionMatch,
            "after invalidation the newly installed binary must be visible"
        );
    }

    /// One `whoami` per account, and the default's is the one `check` already
    /// ran. Probing it again here would double the subprocess cost of every
    /// sweep to learn something it had just been told.
    #[test]
    fn the_default_accounts_row_reuses_the_answer_the_sweep_already_has() {
        let adapter = agents::find("claude").expect("claude ships bundled");
        if !crate::accounts::default_present(adapter) {
            eprintln!("skipping: this machine has no default claude home, so there is no default account row");
            return;
        }
        let answer = crate::auth::Whoami {
            state: SignIn::SignedIn,
            email: Some("a@b.c".into()),
            api_key_source: None,
        };

        // No resolved binary, so anything that probed would come back Unknown.
        let rows = profile_health(adapter, None, &answer);
        let default = rows
            .iter()
            .find(|r| r.id == crate::accounts::DEFAULT_PROFILE_ID)
            .expect("every adapter has the default account");
        assert_eq!(default.sign_in, SignIn::SignedIn);
        assert_eq!(default.account.as_deref(), Some("a@b.c"));
    }

    /// A panic inside a sweep must not wedge the Agents panel until restart.
    #[test]
    fn a_poisoned_cache_recovers_instead_of_staying_broken() {
        let cache = std::sync::Arc::new(HealthCache::new());
        let poisoner = std::sync::Arc::clone(&cache);
        let _ = std::thread::spawn(move || {
            poisoner.get_or_sweep(|| panic!("a probe blew up"));
        })
        .join();

        let after = cache.get_or_sweep(|| health_named("claude", BinaryStatus::VersionMatch));
        assert_eq!(after[0].status, BinaryStatus::VersionMatch);
    }

    #[test]
    fn parses_a_single_line_version() {
        assert_eq!(parse_version("1.18.3\n"), Some("1.18.3".into()));
        assert_eq!(parse_version("claude 1.18.3"), Some("1.18.3".into()));
        assert_eq!(parse_version("v2.0.1"), Some("2.0.1".into()));
        assert_eq!(parse_version("1.0.0 (Claude Code)"), Some("1.0.0".into()));
        // Leading/trailing blank lines are noise, not a second line.
        assert_eq!(parse_version("\n1.2.3\n\n"), Some("1.2.3".into()));
    }

    #[test]
    fn a_multi_line_banner_is_unknown_not_a_guess() {
        let banner = "Some Agent CLI\nCopyright 2026\nversion 3.1.0\n";
        assert_eq!(parse_version(banner), None);
        // ...and that None must surface as neutral, never as drift.
        assert_eq!(compare(None, Some("3.0.0")), BinaryStatus::VersionUnknown);
    }

    #[test]
    fn output_without_a_version_token_is_unknown() {
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn compare_matches_across_the_verified_against_prefix() {
        assert_eq!(compare(Some("1.18.3"), Some("claude 1.18.3")), BinaryStatus::VersionMatch);
        assert_eq!(compare(Some("1.18.4"), Some("claude 1.18.3")), BinaryStatus::VersionDrift);
        // An adapter that declares nothing to compare against is never drift.
        assert_eq!(compare(Some("1.18.3"), None), BinaryStatus::VersionUnknown);
    }

    /// Every bundled adapter gets a card, and the two things that card reads
    /// from the adapter rather than from the binary are right for both shapes.
    ///
    /// `sessions_dir` is the one worth pinning: an ACP agent has no such
    /// directory, and a card naming a path that will never exist reads as a
    /// broken install rather than as a different design.
    #[test]
    fn a_protocol_backed_adapter_reports_no_sessions_directory() {
        for adapter in agents::registry() {
            let health = check(adapter);
            assert_eq!(
                health.sessions_dir.is_some(),
                adapter.discovery.is_some(),
                "{}: a sessions directory is reported exactly when one is discovered from",
                adapter.id
            );
            if health.sessions_dir.is_none() {
                assert!(!health.sessions_dir_exists, "{}: nothing to exist", adapter.id);
            }
        }
    }

    /// An adapter shipped without `verified_against` cannot report a version
    /// match, however new the binary is - which is what lets the Agents card
    /// label it untested instead of supported.
    #[test]
    fn an_adapter_that_declares_no_measurement_never_reports_a_match() {
        let gemini = agents::find("gemini").expect("gemini ships bundled");
        assert_eq!(gemini.verified_against, None);
        assert_eq!(compare(Some("0.9.0"), gemini.verified_against.as_deref()), BinaryStatus::VersionUnknown);

        // And the measured one does match its declared version.
        let opencode = agents::find("opencode").expect("opencode ships bundled");
        assert_eq!(
            compare(Some("1.18.3"), opencode.verified_against.as_deref()),
            BinaryStatus::VersionMatch
        );
    }

    #[test]
    fn a_missing_binary_reports_not_found() {
        // A fake adapter whose launch binary cannot exist on any machine.
        let adapter = agents::test_adapter("tori-nonexistent-agent-binary");
        let health = check(&adapter);
        assert_eq!(health.status, BinaryStatus::NotFound);
        assert!(health.path.is_none());
        assert!(health.version.is_none());
    }

    // --- sign-in rides the sweep ---

    fn with_accounts(program: &str, accounts: agents::AccountsConfig) -> AgentAdapter {
        let mut adapter = agents::test_adapter(program);
        adapter.accounts = Some(accounts);
        adapter
    }

    fn probe(args: &[&str], kind: agents::WhoamiKind) -> agents::AccountsConfig {
        agents::AccountsConfig {
            home_env: None,
            home_default: None,
            home_markers: vec![],
            login_args: vec![],
            logout_args: vec![],
            whoami_args: args.iter().map(|a| a.to_string()).collect(),
            whoami_kind: Some(kind),
            supports_isolation: false,
            onboarded: None,
            plugins_kind: None,
        }
    }

    /// The probe runs inside `check`, which is what makes it cached: everything
    /// the cache tests above assert about re-reading applies to the sign-in
    /// answer too, without a second cache to remember to invalidate.
    ///
    /// Driven through `sh` so it asserts the wiring rather than whatever agent
    /// CLIs the machine running it happens to have.
    #[test]
    fn the_sweep_asks_the_agent_who_is_signed_in() {
        let adapter = with_accounts("sh", probe(&["-c", "exit 0"], agents::WhoamiKind::ExitCode));
        assert_eq!(check(&adapter).sign_in, SignIn::SignedIn);

        let adapter = with_accounts("sh", probe(&["-c", "exit 1"], agents::WhoamiKind::ExitCode));
        assert_eq!(check(&adapter).sign_in, SignIn::SignedOut);
    }

    /// Two independent axes. A signed-out agent is still installed, and its
    /// card still says which version, because those are different facts and
    /// collapsing them would make one of them unsayable.
    #[test]
    fn signed_out_is_not_the_same_answer_as_not_installed() {
        let adapter = with_accounts("sh", probe(&["-c", "exit 1"], agents::WhoamiKind::ExitCode));
        let health = check(&adapter);
        assert_eq!(health.sign_in, SignIn::SignedOut);
        assert!(health.path.is_some(), "signed out says nothing about the binary");
        assert_ne!(health.status, BinaryStatus::NotFound);
    }

    /// No probe, no subprocess, and no verdict. An adapter with no way to say
    /// who is signed in must not read as signed out, which would put a sign-in
    /// prompt in front of a agent that has no sign-in.
    #[test]
    fn an_adapter_that_declares_no_probe_reports_unknown() {
        assert_eq!(check(&agents::test_adapter("sh")).sign_in, SignIn::Unknown);
    }

    /// A binary that is not there is not asked. There would be nothing to ask.
    #[test]
    fn a_missing_binary_is_never_probed_for_a_sign_in() {
        let adapter = with_accounts(
            "tori-nonexistent-agent-binary",
            probe(&["-c", "exit 0"], agents::WhoamiKind::ExitCode),
        );
        let health = check(&adapter);
        assert_eq!(health.status, BinaryStatus::NotFound);
        assert_eq!(health.sign_in, SignIn::Unknown, "not signed out: nothing was asked");
    }

    #[test]
    fn a_binary_on_the_login_path_is_found() {
        // /bin/sh is on every login PATH; resolving it by bare name exercises
        // the same lookup an nvm-installed agent CLI takes.
        let adapter = agents::test_adapter("sh");
        let health = check(&adapter);
        assert_eq!(health.status, BinaryStatus::VersionUnknown, "sh has no --version");
        assert!(health.path.is_some(), "sh should resolve on the login PATH");
    }
}
