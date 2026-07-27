//! Before-state capture, riding the approval hook.
//!
//! `PreToolUse` fires before every `Edit`, `Write` and `MultiEdit` with the
//! target path in `tool_input`, so the bridge that is already blocking the call
//! can capture the file's exact prior content on the way past. One mechanism,
//! two jobs - and it makes tool-call diffs *exact* rather than reconstructed
//! from whatever the working tree happened to look like when a card was opened.
//! That distinction matters most in the case this whole feature exists for:
//! several chats sharing one working tree, where "what the file looks like now"
//! is not evidence of what *this* session changed.
//!
//! **Only the sha is cached, never the bytes.** The content goes into the repo's
//! own object store via `git hash-object -w`, which is content-addressed, shared
//! with git, and already garbage-collected. A session that rewrites a 3MB file
//! forty times grows this cache by forty shas - kilobytes - instead of 120MB.
//! Reading a card back is a `git cat-file` away.
//!
//! Three outcomes, all first-class:
//!
//!   * **A blob sha** - the file existed and its content is now addressable.
//!   * **Absent** - the write creates a new file. Recorded explicitly, because
//!     "no before-state" and "we failed to capture one" must render differently:
//!     the first is a creation diff, the second is an apology.
//!   * **Unavailable** - a folder with no object store to write into. The card
//!     degrades to "open the file" rather than failing the turn.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

/// How many tool calls' before-states one session keeps.
///
/// Generous, because each entry is a sha and a path rather than content, and a
/// long session's early cards are exactly the ones a user scrolls back to.
pub const CACHE_CAP: usize = 500;

/// What was captured for one file before a tool wrote to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BeforeState {
    /// The file existed; its prior content is this blob in the object store.
    Blob { sha: String },
    /// The file did not exist. A creation, not a failure.
    Absent,
    /// No object store to write into (a non-repo folder), or the capture failed.
    /// The card degrades to "diff unavailable, open the file".
    Unavailable,
}

/// One captured file, keyed to the tool call that was about to write it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    pub path: String,
    pub before: BeforeState,
}

/// The files a tool call is about to write.
///
/// Only the writing tools. A `Read` has no before-state worth capturing, and
/// capturing one would put the hook's cost on the calls that are most frequent.
pub fn write_targets(tool: &str, input: &Value) -> Vec<String> {
    match tool {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => input
            .get("file_path")
            .and_then(Value::as_str)
            .map(|p| vec![p.to_string()])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Write `path`'s current content into `repo`'s object store and return its sha.
///
/// `git hash-object -w` rather than reading the bytes ourselves: it is the same
/// store git already maintains, so the content is deduplicated against every
/// other copy and swept by the same gc. `--no-filters` keeps the stored bytes
/// byte-identical to what is on disk, so a diff reflects the file rather than
/// what a clean filter would have made of it.
pub fn capture(repo: &Path, path: &str) -> BeforeState {
    if !Path::new(path).exists() {
        return BeforeState::Absent;
    }
    let out = Command::new("git")
        .current_dir(repo)
        .args(["hash-object", "-w", "--no-filters", "--", path])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let sha = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if sha.is_empty() {
                BeforeState::Unavailable
            } else {
                BeforeState::Blob { sha }
            }
        }
        // A non-repo folder has nowhere to put it. Not an error the turn should
        // fail over: the card says the diff is unavailable and offers the file.
        _ => BeforeState::Unavailable,
    }
}

/// Read a captured blob back, for a card the user expanded.
pub fn read_back(repo: &Path, sha: &str) -> Option<String> {
    let out = Command::new("git").current_dir(repo).args(["cat-file", "-p", sha]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One session's before-states, keyed by `tool_use_id` and bounded.
///
/// Bounded even though entries are tiny, because "tiny times unbounded" is still
/// unbounded and a long-running session has no natural end. Oldest-first, since
/// the newest cards are the ones on screen.
#[derive(Debug, Default)]
pub struct SnapshotCache {
    entries: HashMap<String, Vec<Captured>>,
    /// Insertion order, so eviction is oldest-first rather than whatever the
    /// map's iteration order happens to be.
    order: VecDeque<String>,
    cap: usize,
}

impl SnapshotCache {
    pub fn new(cap: usize) -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new(), cap: cap.max(1) }
    }

    pub fn insert(&mut self, tool_use_id: &str, captured: Vec<Captured>) {
        if self.entries.insert(tool_use_id.to_string(), captured).is_none() {
            self.order.push_back(tool_use_id.to_string());
        }
        while self.order.len() > self.cap {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    /// The before-states for a tool call, or `None` if it was never captured or
    /// has been evicted.
    ///
    /// `None` is a normal answer, not an error: the caller renders "diff
    /// unavailable, open the file". An evicted card degrading is strictly better
    /// than an unbounded cache.
    pub fn get(&self, tool_use_id: &str) -> Option<&Vec<Captured>> {
        self.entries.get(tool_use_id)
    }

    /// Test-only: the product asks about one tool call at a time. No companion
    /// `is_empty`, because nothing would call it - clippy's usual pairing rule
    /// does not apply to a method that only exists for assertions.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

}

/// Capture every file a tool call is about to write.
pub fn capture_all(repo: &Path, tool: &str, input: &Value) -> Vec<Captured> {
    write_targets(tool, input)
        .into_iter()
        .map(|path| {
            let before = capture(repo, &path);
            Captured { path, before }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sway-snap-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ok = Command::new("git").current_dir(&dir).args(["init", "-q"]).status().unwrap();
        assert!(ok.success());
        dir
    }

    #[test]
    fn only_the_writing_tools_have_capture_targets() {
        assert_eq!(write_targets("Edit", &json!({"file_path": "/a.rs"})), vec!["/a.rs"]);
        assert_eq!(write_targets("Write", &json!({"file_path": "/a.rs"})), vec!["/a.rs"]);
        assert_eq!(write_targets("MultiEdit", &json!({"file_path": "/a.rs"})), vec!["/a.rs"]);
        // A read has no before-state worth the hook's time.
        assert!(write_targets("Read", &json!({"file_path": "/a.rs"})).is_empty());
        assert!(write_targets("Bash", &json!({"command": "rm /a.rs"})).is_empty());
    }

    /// **The load-bearing property.** Two edits to one file in one turn must
    /// produce two *different* shas, or the second card would show the first
    /// card's before-state and the diff would be wrong.
    #[test]
    fn two_sequential_edits_to_one_file_produce_two_distinct_shas() {
        let repo = temp_repo("two-edits");
        let file = repo.join("a.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();

        let first = capture(&repo, file.to_str().unwrap());
        std::fs::write(&file, "fn main() { println!(\"hi\"); }\n").unwrap();
        let second = capture(&repo, file.to_str().unwrap());

        match (&first, &second) {
            (BeforeState::Blob { sha: a }, BeforeState::Blob { sha: b }) => {
                assert_ne!(a, b, "each edit must capture its own before-state");
                assert_eq!(read_back(&repo, a).as_deref(), Some("fn main() {}\n"));
                assert_eq!(read_back(&repo, b).as_deref(), Some("fn main() { println!(\"hi\"); }\n"));
            }
            other => panic!("expected two blobs, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A write to a file that does not exist yet is a **creation**, recorded
    /// explicitly. Conflating it with a failed capture would render an apology
    /// where a creation diff belongs.
    #[test]
    fn a_write_to_a_new_file_records_absent_rather_than_failing() {
        let repo = temp_repo("new-file");
        let missing = repo.join("does-not-exist-yet.rs");
        assert_eq!(capture(&repo, missing.to_str().unwrap()), BeforeState::Absent);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A folder with no object store falls back rather than failing the turn.
    #[test]
    fn a_non_git_folder_degrades_to_unavailable_rather_than_failing() {
        let dir = std::env::temp_dir().join(format!("sway-snap-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.rs");
        std::fs::write(&file, "hello\n").unwrap();

        assert_eq!(capture(&dir, file.to_str().unwrap()), BeforeState::Unavailable);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The memory claim, measured rather than asserted: a session rewriting a
    /// large file many times must grow the cache by shas, not by content.
    #[test]
    fn rewriting_a_large_file_forty_times_grows_the_cache_by_kilobytes() {
        let repo = temp_repo("large");
        let file = repo.join("big.txt");
        let mut cache = SnapshotCache::new(CACHE_CAP);

        // Capture *then* write, which is the order the hook runs in: the
        // before-state belongs to the call that is about to overwrite it.
        // 3MB of distinct content each round, so nothing dedupes away.
        std::fs::write(&file, "seed".repeat(750_000)).unwrap();
        for i in 0..40 {
            let captured = capture_all(&repo, "Write", &json!({"file_path": file.to_str().unwrap()}));
            cache.insert(&format!("toolu_{i}"), captured);
            std::fs::write(&file, format!("r{i}-").repeat(750_000)).unwrap();
        }

        assert_eq!(cache.len(), 40);
        let held: usize = (0..40)
            .filter_map(|i| cache.get(&format!("toolu_{i}")))
            .flatten()
            .map(|c| c.path.len() + match &c.before {
                BeforeState::Blob { sha } => sha.len(),
                _ => 0,
            })
            .sum();
        assert!(held < 20_000, "the cache should hold kilobytes of shas and paths, held {held} bytes");

        // And the content really is retrievable, so holding only shas cost
        // nothing. The last call's before-state is what round 38 wrote, which is
        // exactly the "what did *this* call change" question a card asks.
        let last = cache.get("toolu_39").unwrap();
        match &last[0].before {
            BeforeState::Blob { sha } => {
                let content = read_back(&repo, sha).expect("the blob should still be readable");
                assert!(content.starts_with("r38-"), "expected round 38's content, got {:.8}", content);
            }
            other => panic!("expected a blob, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// Bounded even though entries are tiny, because a long session has no
    /// natural end. Oldest-first, since the newest cards are on screen.
    #[test]
    fn filling_past_the_cap_evicts_oldest_first_and_keeps_the_newest() {
        let mut cache = SnapshotCache::new(3);
        for i in 0..5 {
            cache.insert(
                &format!("toolu_{i}"),
                vec![Captured { path: format!("/f{i}"), before: BeforeState::Absent }],
            );
        }
        assert_eq!(cache.len(), 3);
        assert!(cache.get("toolu_0").is_none(), "the oldest should be evicted");
        assert!(cache.get("toolu_1").is_none());
        for i in 2..5 {
            assert!(cache.get(&format!("toolu_{i}")).is_some(), "toolu_{i} should still render");
        }
    }

    /// An evicted card degrades to the fallback rather than throwing, which is
    /// the same path a non-repo folder takes.
    #[test]
    fn an_evicted_entry_reads_as_missing_rather_than_erroring() {
        let mut cache = SnapshotCache::new(1);
        cache.insert("old", vec![Captured { path: "/a".into(), before: BeforeState::Absent }]);
        cache.insert("new", vec![Captured { path: "/b".into(), before: BeforeState::Absent }]);
        assert_eq!(cache.get("old"), None, "an evicted card renders the fallback");
        assert!(cache.get("new").is_some());
    }

    /// Re-inserting the same id must not double-count it in the eviction order,
    /// or the cap would evict live entries early.
    #[test]
    fn reinserting_an_id_does_not_corrupt_the_eviction_order() {
        let mut cache = SnapshotCache::new(2);
        cache.insert("a", vec![Captured { path: "/a".into(), before: BeforeState::Absent }]);
        cache.insert("a", vec![Captured { path: "/a2".into(), before: BeforeState::Absent }]);
        cache.insert("b", vec![Captured { path: "/b".into(), before: BeforeState::Absent }]);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("a").unwrap()[0].path, "/a2", "the newer capture should win");
        assert!(cache.get("b").is_some());
    }

    /// A sha for content the store never had must read back as `None`, so a
    /// stale card degrades rather than rendering someone else's bytes.
    #[test]
    fn reading_back_an_unknown_sha_is_none() {
        let repo = temp_repo("unknown-sha");
        assert_eq!(read_back(&repo, "0000000000000000000000000000000000000000"), None);
        let _ = std::fs::remove_dir_all(&repo);
    }
}
