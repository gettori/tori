//! Sway's own record of the ACP sessions it knows about.
//!
//! Every other agent Sway drives keeps its sessions as files Sway can read:
//! `agents::Discovery` names the directory, `ParserKind` names the format, and
//! `SessionMeta.path` points at the transcript. An ACP agent keeps its history
//! privately and hands out an opaque `sessionId`; there is no file to point at
//! and no format to parse. That is why this module exists rather than a third
//! `Discovery` variant: the enum answers "where does *this adapter* keep its
//! sessions", and for ACP the honest answer is "somewhere only the protocol can
//! reach", which no filesystem variant can express.
//!
//! What Sway keeps instead is a **locator**: one small JSON file per session,
//! recording the agent's own session id beside the cwd, title and last-active
//! time a listing reported. It is a real file at a real path, so
//! `SessionMeta.path` stays non-optional and honest, and it is the only thing
//! that lets a chat reopened after a restart find the id `session/load` needs.
//!
//! The locator is a **cache, never the truth**. The agent owns its sessions; a
//! locator naming one the agent has since forgotten simply fails to load, which
//! is the same outcome as a deleted transcript.

use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One ACP session, as Sway records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpSession {
    /// Sway's own id for the session: what the ownership registry claims, what
    /// a tab addresses, and what names this locator file.
    pub id: String,
    /// The adapter that produced it, so a listing can say which agent a row
    /// belongs to without guessing from the id's shape.
    pub agent: String,
    /// The agent's own session id, which is the only thing `session/load`
    /// accepts. Kept separate from [`Self::id`] because the two are not the
    /// same string for a session Sway opened: Sway mints its id before the
    /// child exists, and ACP has no verb for creating a session with a
    /// caller-chosen id.
    pub acp_session_id: String,
    pub cwd: String,
    pub title: String,
    /// Epoch seconds. Derived from the listing's ISO 8601 `updatedAt` when the
    /// agent gave one, and from the clock when it did not.
    pub updated_at: u64,
}

/// Test-only redirection of the store, so a test never writes a locator into
/// the running user's real config directory.
///
/// Process-global rather than a parameter threaded through every caller,
/// because a locator is written from the session's own connection thread, which
/// no test owns a handle to. The live tests that set it run single-threaded
/// (`cargo test -- --ignored --test-threads=1`), which is what makes one global
/// safe.
#[cfg(test)]
static DIR_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[cfg(test)]
pub fn use_dir_for_tests(path: PathBuf) {
    let mut guard = DIR_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(path);
}

fn dir() -> PathBuf {
    #[cfg(test)]
    {
        let guard = DIR_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(path) = guard.as_ref() {
            return path.clone();
        }
    }
    dirs::home_dir().unwrap_or_default().join(".config/sway/acp-sessions")
}

/// Where one session's locator lives.
pub fn locator_path(id: &str) -> PathBuf {
    dir().join(format!("{id}.json"))
}

/// Where one session's event log lives, beside its locator.
///
/// **`.jsonl`, never `.json`.** [`all`] scans this directory for locators by
/// extension, so a log wearing the locator's would be parsed as a session and
/// listed as one - a phantom row for every chat that ever streamed.
pub fn log_path(id: &str) -> PathBuf {
    dir().join(format!("{id}.jsonl"))
}

/// Sway's id for a session the *agent* named.
///
/// Deterministic, so the same agent session listed on two different days is one
/// row rather than two. The agent's id is used verbatim when it is safe as a
/// filename, because a readable id is worth having in every log and claim that
/// carries it; anything else is hex-encoded, which is injective and so cannot
/// collapse two distinct sessions into one row the way a hash could.
pub fn sway_id_for(acp_session_id: &str) -> String {
    let safe = !acp_session_id.is_empty()
        && acp_session_id.len() <= 120
        && acp_session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        // A leading dot would make the locator a hidden file, and `.`/`..` are
        // not names at all.
        && !acp_session_id.starts_with('.');
    if safe {
        return acp_session_id.to_string();
    }
    let mut hex = String::with_capacity(4 + acp_session_id.len() * 2);
    hex.push_str("acp-");
    for byte in acp_session_id.as_bytes() {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Write one session's locator, replacing any previous.
pub fn record(session: &AcpSession) -> Result<(), String> {
    let text = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    crate::owned_state::write_atomically(&locator_path(&session.id), &text)
}

/// Drop Sway's record of one session, given the locator path a listing row
/// carried.
///
/// **This deletes nothing of the agent's.** A session with no transcript keeps
/// its conversation wherever the agent keeps it, and ACP has no verb for
/// removing one, so the whole of what "delete" can mean here is that Sway stops
/// listing it.
///
/// Refuses a path outside the store rather than removing it. `delete_session`
/// is handed a `path` that round-trips through the frontend, and the one thing
/// this branch must not become is an arbitrary-file delete reached by naming a
/// protocol-backed agent.
pub fn forget(path: &Path) -> Result<(), String> {
    if path.parent() != Some(dir().as_path()) {
        return Err(format!(
            "{} is not one of Sway's session records, so there is nothing here to forget",
            path.display()
        ));
    }
    // The event log goes with the locator. It is Sway's own derived copy of a
    // conversation, so leaving it behind would keep a chat the user deleted
    // readable, and orphan a file nothing will ever clean up.
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        let log = log_path(stem);
        // And the half-written rebuild a crash mid-`replace` can leave beside
        // it. Invisible to `all` either way, but nothing else would ever
        // collect it.
        let _ = std::fs::remove_file(log.with_extension("jsonl.tmp"));
        let _ = std::fs::remove_file(log);
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        // Already gone is the outcome asked for.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Read one session's locator, or `None` when Sway has no record of it.
pub fn read(id: &str) -> Option<AcpSession> {
    let text = std::fs::read_to_string(locator_path(id)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Every ACP session Sway has a locator for.
///
/// A file that will not parse is skipped rather than failing the scan: one
/// corrupt locator must not hide every other session from the sidebar.
pub fn all() -> Vec<AcpSession> {
    let Ok(entries) = std::fs::read_dir(dir()) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|text| serde_json::from_str::<AcpSession>(&text).ok())
        .collect()
}

/// One row exactly as `session/list` returned it.
///
/// Four fields, because four is all the protocol carries: `sessionId`, `cwd`,
/// `title` and `updatedAt`. There is no branch, no created-at and no agent id in
/// a listed row, and this struct refuses to pretend otherwise - a shape with a
/// `branch` field would invite somebody to fill it from the folder Sway happens
/// to be looking at, which is a different session's branch as often as not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedSession {
    pub acp_session_id: String,
    pub cwd: String,
    /// The agent's own title, which both measured agents set to the raw first
    /// prompt rather than a cleaned one.
    pub title: Option<String>,
    /// ISO 8601, when the agent supplied it.
    pub updated_at: Option<String>,
}

/// Turn a listing into the locators to write, given what Sway already knows.
///
/// Pure, so the whole of "what a listed row becomes" is testable without a live
/// agent or a filesystem. Two rules earn their keep here:
///
///   * **A row Sway already has keeps its existing id.** Sway mints an id before
///     the child exists and only learns the agent's id afterwards, so the same
///     session has two names. Matching on the agent's id and reusing Sway's own
///     is what stops a session Sway opened from also appearing as a second,
///     stranger row after the next listing.
///   * **A row Sway already has also keeps Sway's `cwd`, not the agent's.** An
///     agent is free to canonicalise the path it was given, and on macOS it
///     usually does (`/var/...` comes back as `/private/var/...`). The sidebar
///     files a session by prefix-matching its `cwd` against the folder the user
///     opened, so adopting the canonical form would drop the row out of the very
///     folder it belongs to. Found by the live reopen test, where the two forms
///     differed by exactly that prefix.
///   * **A missing `updatedAt` falls back to the recorded time, then to `now`,
///     never to zero.** Zero would pin an agent that omits the field to 1970 and
///     bury its sessions under everything else. But `now` is only right the first
///     time: a listing runs on every connection, so re-dating a known row to the
///     clock floats every one of that agent's sessions to the top of the history
///     list whenever the user opens any chat at all. `now` is therefore for a row
///     nobody has seen before, which is the only case with nothing better to use.
///   * **A row opened by Sway's own catalogue probe is dropped.** Probing an ACP
///     agent means opening a session, and `session/close` frees resources rather
///     than deleting the record, so the agent keeps listing it. It is recognised
///     by the directory it was opened in rather than by an id, which is what
///     makes a probe that crashed before recording anything, and a probe from a
///     build that predates any list of ids, both still recognisable.
///     `probe_cwds` carries every spelling of that directory (see
///     [`crate::catalog_probe::probe_cwd_spellings`]) because resolving one is
///     the filesystem's job and this function does not have one.
pub fn adopt(
    agent: &str,
    listed: &[ListedSession],
    known: &[AcpSession],
    now: u64,
    probe_cwds: &[String],
) -> Vec<AcpSession> {
    listed
        .iter()
        .filter(|row| !probe_cwds.iter().any(|dir| dir == &row.cwd))
        .map(|row| {
            let existing = known
                .iter()
                .find(|k| k.agent == agent && k.acp_session_id == row.acp_session_id);
            AcpSession {
                id: existing
                    .map(|k| k.id.clone())
                    .unwrap_or_else(|| sway_id_for(&row.acp_session_id)),
                agent: agent.to_string(),
                acp_session_id: row.acp_session_id.clone(),
                cwd: existing
                    .map(|k| k.cwd.clone())
                    .unwrap_or_else(|| row.cwd.clone()),
                title: title_for(row.title.as_deref()),
                updated_at: row
                    .updated_at
                    .as_deref()
                    .and_then(epoch_from_iso8601)
                    .or_else(|| existing.map(|k| k.updated_at))
                    .unwrap_or(now),
            }
        })
        .collect()
}

/// The same trimming a transcript-derived title gets, applied to the raw first
/// prompt an ACP agent hands back as its title.
///
/// Untitled reads as untitled rather than as an empty row: `list_sessions`
/// already spells that "(untitled session)" for a transcript with no prompt in
/// its head, and a listed row with no title is the same situation.
fn title_for(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|t| !t.is_empty()) {
        Some(text) => crate::sessions::clean_title(text),
        None => "(untitled session)".to_string(),
    }
}

/// Epoch seconds for an ISO 8601 timestamp, or `None` for anything this does
/// not understand.
///
/// Written out rather than pulled from a date crate because this is the only
/// date parsing in the backend and the shape is fixed by the protocol:
/// `YYYY-MM-DDThh:mm:ss` with an optional fractional part and an optional `Z`
/// or `±hh:mm` offset. An unparseable stamp yields `None` so the caller can
/// fall back to the clock, rather than silently dating a session to 1970 and
/// sorting it to the bottom of the history list forever.
pub fn epoch_from_iso8601(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
    let seconds = seconds - offset_seconds(text.get(19..)?)?;
    u64::try_from(seconds).ok()
}

/// The trailing zone of an ISO 8601 stamp, in seconds east of UTC. A stamp with
/// no zone is read as UTC, which is what the protocol's own examples use.
fn offset_seconds(tail: &str) -> Option<i64> {
    // Skip a fractional second if there is one.
    let tail = match tail.strip_prefix('.') {
        Some(rest) => rest.trim_start_matches(|c: char| c.is_ascii_digit()),
        None => tail,
    };
    let (sign, rest) = match tail.chars().next() {
        None | Some('Z' | 'z') => return Some(0),
        Some('+') => (1, &tail[1..]),
        Some('-') => (-1, &tail[1..]),
        Some(_) => return None,
    };
    if rest.len() < 5 {
        return None;
    }
    let hours: i64 = rest.get(0..2)?.parse().ok()?;
    let minutes: i64 = rest.get(3..5)?.parse().ok()?;
    Some(sign * (hours * 3600 + minutes * 60))
}

/// Days between 1970-01-01 and a proleptic-Gregorian date. Hinnant's algorithm,
/// which is exact for every date the protocol can carry and needs no table.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Forgetting a session forgets both of its files**, and the log is
    /// invisible to the scan while it lives. A `.jsonl` read as a locator would
    /// be one phantom row per chat that ever streamed; a `.jsonl` left behind
    /// would keep a deleted conversation readable.
    #[test]
    fn forgetting_a_session_removes_its_log_and_the_scan_never_sees_one() {
        let dir = std::env::temp_dir().join(format!("sway-acp-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        use_dir_for_tests(dir.clone());

        let session = AcpSession {
            id: "log-scan".to_string(),
            agent: "codex".to_string(),
            acp_session_id: "agent-side".to_string(),
            cwd: "/tmp".to_string(),
            title: "a chat".to_string(),
            updated_at: 0,
        };
        record(&session).expect("the locator should write");
        // Deliberately a *parseable* locator inside the log. If the scan ever
        // stopped filtering by extension, this would list as a second session
        // rather than merely failing to parse, so the filter is what the
        // assertion below actually tests.
        let decoy = AcpSession { id: "log-scan-decoy".to_string(), ..session.clone() };
        std::fs::write(log_path("log-scan"), serde_json::to_string(&decoy).unwrap()).unwrap();

        // Scoped to the ids this test wrote: `use_dir_for_tests` is one global
        // for the whole process, so counting every row would count a concurrent
        // test's as well.
        let mine: Vec<String> =
            all().into_iter().map(|s| s.id).filter(|id| id.starts_with("log-scan")).collect();
        assert_eq!(mine, vec!["log-scan".to_string()], "the log must not be scanned as a locator");

        forget(&locator_path("log-scan")).expect("forgetting should succeed");
        assert!(!locator_path("log-scan").exists(), "the locator is gone");
        assert!(!log_path("log-scan").exists(), "and so is the log beside it");
    }

    #[test]
    fn a_filename_safe_agent_id_is_kept_verbatim() {
        assert_eq!(sway_id_for("ses_8f2a-01"), "ses_8f2a-01");
        assert_eq!(
            sway_id_for("6d3c1b2a-0000-4000-8000-000000000001"),
            "6d3c1b2a-0000-4000-8000-000000000001"
        );
    }

    /// An agent is free to hand out an id with a slash in it, and writing that
    /// straight into a filename would escape the directory. Hex-encoding is
    /// injective, so two different sessions cannot collapse into one row.
    #[test]
    fn an_unsafe_agent_id_is_encoded_rather_than_hashed() {
        let escaping = sway_id_for("../../etc/passwd");
        assert!(!escaping.contains('/'), "{escaping}");
        assert_ne!(sway_id_for("a/b"), sway_id_for("a/c"));
        assert_ne!(sway_id_for(""), "");
        assert!(!sway_id_for(".hidden").starts_with('.'));
    }

    fn listed(id: &str, title: Option<&str>, updated: Option<&str>) -> ListedSession {
        ListedSession {
            acp_session_id: id.to_string(),
            cwd: "/repo".to_string(),
            title: title.map(str::to_string),
            updated_at: updated.map(str::to_string),
        }
    }

    fn known(id: &str, acp_id: &str) -> AcpSession {
        AcpSession {
            id: id.to_string(),
            agent: "opencode".to_string(),
            acp_session_id: acp_id.to_string(),
            cwd: "/repo".to_string(),
            title: "old".to_string(),
            updated_at: 1,
        }
    }

    /// The duplicate this prevents: Sway mints its id before the child exists
    /// and only learns the agent's id afterwards, so the same conversation has
    /// two names. A listing that minted a fresh id would show it twice.
    #[test]
    fn a_row_sway_already_has_keeps_the_id_sway_gave_it() {
        let rows = adopt(
            "opencode",
            &[listed("ses_a", Some("hello"), None)],
            &[known("a-sway-uuid", "ses_a")],
            99,
            &[],
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "a-sway-uuid");
        assert_eq!(rows[0].acp_session_id, "ses_a");
    }

    /// The defect this pins, found by the live reopen test: `opencode acp`
    /// canonicalises the cwd it was handed, so a `/var/...` session came back
    /// from the listing as `/private/var/...`. The sidebar files a row by
    /// prefix-matching its cwd against the folder the user opened, so adopting
    /// the agent's form would have dropped the row out of its own folder.
    #[test]
    fn a_row_sway_already_has_keeps_the_path_sway_files_it_under() {
        let mut row = listed("ses_a", None, None);
        row.cwd = "/private/repo".to_string();
        let rows = adopt("opencode", &[row], &[known("a-sway-uuid", "ses_a")], 99, &[]);
        assert_eq!(rows[0].cwd, "/repo");
    }

    /// A row Sway has never seen has only the agent's word for where it lives,
    /// so that is what gets recorded.
    #[test]
    fn a_row_sway_has_never_seen_takes_the_agents_path() {
        let mut row = listed("ses_new", None, None);
        row.cwd = "/elsewhere".to_string();
        let rows = adopt("opencode", &[row], &[], 99, &[]);
        assert_eq!(rows[0].cwd, "/elsewhere");
    }

    /// Matching is per agent: two agents are free to hand out the same id
    /// string, and treating them as one session would open the wrong history.
    #[test]
    fn a_row_from_another_agent_is_not_mistaken_for_this_one() {
        let rows = adopt(
            "gemini",
            &[listed("ses_a", None, None)],
            &[known("a-sway-uuid", "ses_a")],
            99,
            &[],
        );
        assert_eq!(rows[0].id, "ses_a", "a different agent's id is a new row");
        assert_eq!(rows[0].agent, "gemini");
    }

    /// Both measured agents set the title to the raw first prompt, newlines and
    /// all. A history row is one line, so it gets the same trimming a
    /// transcript-derived title gets.
    #[test]
    fn a_raw_first_prompt_title_is_trimmed_the_way_a_transcript_title_is() {
        let raw = "fix   the\n  sidebar";
        let rows = adopt("opencode", &[listed("ses_a", Some(raw), None)], &[], 99, &[]);
        assert_eq!(rows[0].title, "fix the sidebar");

        let long = "x".repeat(200);
        let rows = adopt("opencode", &[listed("ses_b", Some(&long), None)], &[], 99, &[]);
        assert!(rows[0].title.chars().count() <= 91, "{}", rows[0].title);
        assert!(rows[0].title.ends_with('…'));
    }

    #[test]
    fn a_row_with_no_title_reads_as_untitled_rather_than_blank() {
        let rows = adopt("opencode", &[listed("ses_a", None, None)], &[], 99, &[]);
        assert_eq!(rows[0].title, "(untitled session)");
        let rows = adopt("opencode", &[listed("ses_b", Some("   "), None)], &[], 99, &[]);
        assert_eq!(rows[0].title, "(untitled session)");
    }

    /// An agent that omits `updatedAt` would otherwise date every one of its
    /// sessions to 1970 and bury them at the bottom of the history list.
    #[test]
    fn a_row_with_no_timestamp_is_dated_now_rather_than_1970() {
        let rows = adopt("opencode", &[listed("ses_a", None, None)], &[], 99, &[]);
        assert_eq!(rows[0].updated_at, 99);
        let rows = adopt(
            "opencode",
            &[listed("ses_b", None, Some("2026-08-14T12:00:00Z"))],
            &[],
            99,
            &[],
        );
        assert_eq!(rows[0].updated_at, 1_786_708_800);
    }

    /// The other half of that rule, and the one with teeth: a listing runs on
    /// every connection, so dating a *known* row to the clock would float every
    /// session of an agent that omits `updatedAt` to the top of the history list
    /// each time the user opened any chat at all.
    #[test]
    fn a_known_row_with_no_timestamp_keeps_the_time_it_was_recorded_with() {
        let rows = adopt(
            "opencode",
            &[listed("ses_a", None, None)],
            &[known("u", "ses_a")],
            99,
            &[],
        );
        assert_eq!(rows[0].updated_at, 1, "the recorded time, not the clock");
    }

    /// What makes skipping an unchanged locator safe: a second listing of the
    /// same unchanged row adopts to exactly the value already on disk, so the
    /// caller's equality check is comparing like with like rather than
    /// re-deriving a field and rewriting the file every time.
    #[test]
    fn a_second_listing_of_an_unchanged_row_adopts_to_what_is_already_recorded() {
        let row = listed("ses_a", Some("fix the sidebar"), Some("2026-08-14T12:00:00Z"));
        let first = adopt("opencode", std::slice::from_ref(&row), &[], 99, &[]);
        let second = adopt("opencode", &[row], &first, 1_000, &[]);
        assert_eq!(first, second);
    }

    /// Measured: `opencode acp` 1.18.3 advertises `session/list` and returns
    /// nothing at all. Zero rows is an empty history, not a failure, and must
    /// not disturb what Sway already recorded.
    #[test]
    fn an_empty_listing_adopts_nothing_rather_than_failing() {
        assert!(adopt("opencode", &[], &[known("u", "ses_a")], 99, &[]).is_empty());
    }

    /// The phantom the catalogue probe leaves behind. Asking an ACP agent what
    /// it can run means opening a session, and `session/close` frees resources
    /// rather than deleting the record, so the agent keeps listing one session
    /// per probe. Nothing about the row says it was Sway's own except where it
    /// was opened, which is why that is what the filter reads.
    ///
    /// **Both spellings, because a directory has more than one name.** macOS
    /// hands out `/var/...` and agents record `/private/var/...`, and this
    /// function has no filesystem to resolve either with; the caller passes in
    /// every spelling it could resolve, and each one has to drop the row.
    #[test]
    fn a_session_sways_own_probe_opened_is_not_adopted_as_history() {
        let spellings = ["/var/sway/probe".to_string(), "/private/var/sway/probe".to_string()];
        for spelling in &spellings {
            let mut row = listed("ses_probe", None, None);
            row.cwd = spelling.clone();
            assert!(
                adopt("opencode", &[row], &[], 99, &spellings).is_empty(),
                "a row in {spelling} is Sway's own probe, whichever name it came back under"
            );
        }
    }

    /// And the filter is on the directory, not on anything resembling it: a real
    /// session that merely lives near the probe dir is still the user's.
    #[test]
    fn a_session_that_is_not_the_probes_survives_the_filter() {
        let probe = ["/var/sway/probe".to_string()];
        let mut row = listed("ses_real", None, None);
        row.cwd = "/var/sway/probe-notes".to_string();
        assert_eq!(adopt("opencode", &[row], &[], 99, &probe).len(), 1);
    }

    #[test]
    fn an_iso_timestamp_becomes_epoch_seconds() {
        assert_eq!(epoch_from_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_from_iso8601("2026-08-14T12:00:00Z"), Some(1_786_708_800));
        // A fractional second is carried by both measured agents and must not
        // defeat the parse.
        assert_eq!(
            epoch_from_iso8601("2026-08-14T12:00:00.512Z"),
            Some(1_786_708_800)
        );
        // An offset is applied, not ignored: reading +02:00 as UTC would date
        // the session two hours late and sort it above sessions newer than it.
        assert_eq!(
            epoch_from_iso8601("2026-08-14T14:00:00+02:00"),
            Some(1_786_708_800)
        );
    }

    /// A stamp this cannot read must be `None` rather than 0. A session dated
    /// 1970 sorts to the bottom of the history list and stays there.
    #[test]
    fn an_unreadable_timestamp_is_declined_rather_than_dated_to_1970() {
        assert_eq!(epoch_from_iso8601(""), None);
        assert_eq!(epoch_from_iso8601("yesterday"), None);
        assert_eq!(epoch_from_iso8601("2026-13-01T00:00:00Z"), None);
        assert_eq!(epoch_from_iso8601("2026-08-14 12:00"), None);
    }
}
