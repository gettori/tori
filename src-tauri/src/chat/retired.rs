//! Stores Tori used to write and no longer does, and the one-time sweep that
//! clears them off disk.
//!
//! **Why a sweep and not a silent leftover.** `~/.config/tori/chat-rules` held
//! three things: a compiled file per session, a durable file per project, and a
//! tally of hand-approvals per project. All three were read by the `PreToolUse`
//! gate. Nothing reads them now - the agent decides its own tool calls and
//! records its own grants - so leaving them is leaving a directory of files that
//! look like settings and are not: a user who found them would reasonably
//! believe editing one changed something.
//!
//! **Removed rather than archived.** An archive would be the same bytes under a
//! different name, and there is no format left to restore them into. What is
//! owed instead is the telling: the sweep reports how many *project* rules went,
//! because that is the only part a person deliberately wrote, and points at
//! where that intent lives now.
//!
//! **Said once, by construction.** The report is produced by the removal, so a
//! second run finds nothing and returns `None`. There is no "have I told them"
//! flag to keep in sync with the disk.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// What one sweep removed, for the notice the user reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredRuleStore {
    /// The directory that is gone, named so the user can see this was theirs.
    pub path: String,
    /// Files removed, across all three kinds. The blunt figure, so the notice
    /// can say something happened even when nothing was deliberately written.
    pub files: usize,
    /// Rules the user actually wrote, project-scoped, summed across projects.
    /// The number worth acting on: session files and tallies were Tori's own
    /// bookkeeping, and nobody misses those.
    pub project_rules: usize,
}

fn store_dir() -> PathBuf {
    crate::owned_state::config_dir().join("chat-rules")
}

/// Remove the retired rule store, reporting what went.
///
/// `None` when there is nothing there, which is every run after the first and
/// every install that never had the gate.
pub fn sweep_rule_store() -> Option<RetiredRuleStore> {
    sweep_at(&store_dir())
}

/// The sweep against an explicit directory, so it is testable without touching
/// the real `~/.config`.
fn sweep_at(dir: &Path) -> Option<RetiredRuleStore> {
    if !dir.is_dir() {
        return None;
    }
    let files = count_files(dir);
    let project_rules = count_project_rules(&dir.join("projects"));
    // A directory that exists but holds nothing is still worth removing, and
    // still not worth a notice: there is nothing the user could act on.
    if files == 0 {
        let _ = std::fs::remove_dir_all(dir);
        return None;
    }
    // Reported only if it really went. A removal that failed (a permission
    // problem, a file held open) must not produce a notice saying it did, or
    // the next run would sweep again and say it twice.
    std::fs::remove_dir_all(dir).ok()?;
    Some(RetiredRuleStore { path: dir.to_string_lossy().into_owned(), files, project_rules })
}

fn count_files(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .filter_map(|e| e.ok())
        .map(|e| if e.path().is_dir() { count_files(&e.path()) } else { 1 })
        .sum()
}

/// How many rules the durable project files hold.
///
/// Read as plain JSON rather than through the old `ProjectRuleFile` type, which
/// is deleted. Keeping that type alive only to count its contents would keep the
/// rule engine's vocabulary in the codebase to describe something that no longer
/// exists; a length is all this needs, and a file it cannot parse counts zero
/// rather than failing the sweep.
fn count_project_rules(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter_map(|v| v.get("rules").and_then(|r| r.as_array()).map(Vec::len))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-retired-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn seed(dir: &Path) {
        std::fs::create_dir_all(dir.join("projects")).unwrap();
        std::fs::create_dir_all(dir.join("counts")).unwrap();
        // Two session files: compiled artefacts, nobody's intent.
        std::fs::write(dir.join("a.json"), r#"{"formatVersion":2,"rules":[]}"#).unwrap();
        std::fs::write(dir.join("b.json"), r#"{"formatVersion":2,"rules":[]}"#).unwrap();
        // One project file holding two rules somebody meant.
        std::fs::write(
            dir.join("projects/proj-1.json"),
            r#"{"formatVersion":2,"rules":[{"tool":"Read"},{"tool":"Bash"}]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("counts/proj-1.json"), r#"{"formatVersion":2,"counts":{}}"#).unwrap();
    }

    #[test]
    fn the_store_goes_and_the_report_names_what_a_person_wrote() {
        let dir = scratch("full");
        seed(&dir);

        let report = sweep_at(&dir).expect("a populated store should be reported");
        assert_eq!(report.files, 4, "every file across all three kinds is counted");
        assert_eq!(report.project_rules, 2, "only the durable project rules are the user's own");
        assert_eq!(report.path, dir.to_string_lossy());
        assert!(!dir.exists(), "the store must actually be gone, not merely reported");
    }

    /// The "once" in "told once" is the disk, not a flag.
    #[test]
    fn a_second_sweep_says_nothing() {
        let dir = scratch("twice");
        seed(&dir);

        assert!(sweep_at(&dir).is_some());
        assert!(sweep_at(&dir).is_none(), "there is nothing left to report, so nothing is said");
    }

    /// An install that never turned the gate on has nothing to be told about.
    #[test]
    fn an_absent_store_is_not_news() {
        assert!(sweep_at(&scratch("absent")).is_none());
    }

    /// An empty directory is still cleared, and still not worth a notice: there
    /// is nothing the user could act on.
    #[test]
    fn an_empty_store_is_removed_without_a_notice() {
        let dir = scratch("empty");
        std::fs::create_dir_all(dir.join("projects")).unwrap();

        assert!(sweep_at(&dir).is_none());
        assert!(!dir.exists(), "an empty leftover is still a leftover");
    }

    /// A project file this build cannot parse must not fail the sweep: the
    /// removal is the point, and the count is the part that degrades.
    #[test]
    fn an_unreadable_project_file_costs_a_count_and_nothing_else() {
        let dir = scratch("garbled");
        std::fs::create_dir_all(dir.join("projects")).unwrap();
        std::fs::write(dir.join("projects/proj-1.json"), "not json at all").unwrap();

        let report = sweep_at(&dir).expect("the file is still there to remove");
        assert_eq!(report.files, 1);
        assert_eq!(report.project_rules, 0, "an unparseable file counts zero rather than failing");
        assert!(!dir.exists());
    }
}
