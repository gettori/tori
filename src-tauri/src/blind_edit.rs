//! Blind edits: a file a session changed without having seen it first.
//!
//! A fact recorded on the call, never a gate. Lenient about what counts as
//! seen, because a wrong accusation costs more than a missed one, but exact
//! about paths: a directory a command named covers none of the files under it,
//! or a single `ls` would silence the mark for the rest of the session.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::Value;

use crate::chat::model::{ChatEvent, FileEditKind, ToolKind, ToolStatus};
use crate::secret_watch::{command_text, expand, normalize, shell_words};

const SEARCH_TOOLS: [&str; 4] = ["rg", "grep", "ag", "ack"];

/// One session's seen files, fed every event in order. Only `FileEdit` makes an
/// edit, so the Claude adapter, which emits none and whose tools already refuse
/// an unread file, is never judged.
pub struct Tracker {
    cwd: Option<PathBuf>,
    home: PathBuf,
    seen: HashSet<PathBuf>,
    calls: HashMap<String, Call>,
    // The first answer per call. A `session/load` replays a conversation through
    // the same tracker, and by then the seen set holds the reads that came after
    // each edit, so a recomputed answer would clear every mark.
    verdicts: HashMap<String, Vec<String>>,
}

#[derive(Default)]
struct Call {
    kind: ToolKind,
    name: String,
    ran_in: Option<PathBuf>,
    searches: bool,
    moves: Vec<PathBuf>,
    edits: Vec<Edit>,
}

struct Edit {
    raw: String,
    path: PathBuf,
    blind: bool,
}

impl Tracker {
    pub fn new(cwd: Option<PathBuf>) -> Self {
        Self::with_home(cwd, dirs::home_dir().unwrap_or_default())
    }

    fn with_home(cwd: Option<PathBuf>, home: PathBuf) -> Self {
        Self {
            cwd,
            home,
            seen: HashSet::new(),
            calls: HashMap::new(),
            verdicts: HashMap::new(),
        }
    }

    pub fn observe(&mut self, event: &ChatEvent) -> Vec<String> {
        match event {
            ChatEvent::ToolCallStarted {
                tool_use_id,
                name,
                input,
                kind,
                locations,
                ..
            } => {
                let base = self.cwd.clone();
                let call = self.calls.entry(tool_use_id.clone()).or_default();
                if *kind != ToolKind::Other {
                    call.kind = *kind;
                }
                if !name.is_empty() {
                    call.name = name.clone();
                }
                let mut paths: Vec<PathBuf> = Vec::new();
                match call.kind {
                    ToolKind::Read | ToolKind::Search if call.name != "Glob" => {
                        call.searches |= call.kind == ToolKind::Search;
                        let named = ["file_path", "path", "notebook_path"]
                            .iter()
                            .filter_map(|k| input.get(*k).and_then(Value::as_str));
                        for raw in named.chain(locations.iter().map(|l| l.path.as_str())) {
                            paths.push(resolve(raw, base.as_deref(), &self.home));
                        }
                    }
                    ToolKind::Execute => {
                        if let Some(command) = command_text(input) {
                            let mut dir = base;
                            let mut after_cd = false;
                            for word in shell_words(&command) {
                                if after_cd {
                                    dir = Some(resolve(word, dir.as_deref(), &self.home));
                                }
                                after_cd = word == "cd";
                                call.searches |= SEARCH_TOOLS.contains(&word);
                                paths.push(resolve(word, dir.as_deref(), &self.home));
                            }
                            call.ran_in = dir;
                        }
                    }
                    ToolKind::Move => {
                        let named = ["source", "destination", "from", "to"]
                            .iter()
                            .filter_map(|k| input.get(*k).and_then(Value::as_str));
                        for raw in named.chain(locations.iter().map(|l| l.path.as_str())) {
                            call.moves.push(resolve(raw, base.as_deref(), &self.home));
                        }
                    }
                    _ => {}
                }
                self.seen.extend(paths);
                Vec::new()
            }
            ChatEvent::FileEdit {
                tool_use_id,
                path,
                kind,
                ..
            } => {
                let resolved = resolve(path, self.cwd.as_deref(), &self.home);
                let blind = match kind {
                    FileEditKind::Created => false,
                    FileEditKind::Modified => !self.seen.contains(&resolved),
                    FileEditKind::Deleted => return Vec::new(),
                };
                let call = self.calls.entry(tool_use_id.clone()).or_default();
                if !call.edits.iter().any(|e| e.path == resolved) {
                    call.edits.push(Edit {
                        raw: path.clone(),
                        path: resolved,
                        blind,
                    });
                }
                Vec::new()
            }
            ChatEvent::ToolCallCompleted {
                tool_use_id,
                status,
                output,
                ..
            } => {
                let Some(call) = self.calls.remove(tool_use_id) else {
                    return self.verdicts.get(tool_use_id).cloned().unwrap_or_default();
                };
                if *status != ToolStatus::Ok {
                    return Vec::new();
                }
                if call.searches {
                    let dir = call.ran_in.clone().or_else(|| self.cwd.clone());
                    for raw in output.as_deref().unwrap_or_default().lines().filter_map(search_hit) {
                        self.seen.insert(resolve(raw, dir.as_deref(), &self.home));
                    }
                }
                if call.moves.iter().any(|p| self.seen.contains(p)) {
                    self.seen.extend(call.moves);
                }
                if call.edits.is_empty() {
                    return Vec::new();
                }
                let mut blind: Vec<String> = call.edits.iter().filter(|e| e.blind).map(|e| e.raw.clone()).collect();
                blind.sort();
                blind.dedup();
                self.seen.extend(call.edits.into_iter().map(|e| e.path));
                self.verdicts.entry(tool_use_id.clone()).or_insert(blind).clone()
            }
            _ => Vec::new(),
        }
    }
}

fn resolve(raw: &str, base: Option<&Path>, home: &Path) -> PathBuf {
    let mut path = expand(raw.trim(), home);
    if path.is_relative() {
        if let Some(base) = base {
            path = base.join(path);
        }
    }
    normalize(&path)
}

// A match line from rg or grep leads with `path:`. A bare line number is grep
// over one file, whose path the command already named.
fn search_hit(line: &str) -> Option<&str> {
    let (head, _) = line.split_once(':')?;
    (!head.is_empty() && !head.contains(char::is_whitespace) && !head.chars().all(|c| c.is_ascii_digit()))
        .then_some(head)
}

pub fn enabled() -> bool {
    static CACHE: Mutex<Option<(Option<SystemTime>, bool)>> = Mutex::new(None);
    let stamp = crate::settings::modified();
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, on)) = *cache {
        if at == stamp {
            return on;
        }
    }
    let on = crate::settings::blind_edits().enabled;
    *cache = Some((stamp, on));
    on
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::ToolLocation;
    use serde_json::json;

    const CWD: &str = "/w/app";

    struct Run {
        tracker: Tracker,
        next: usize,
    }

    impl Run {
        fn new() -> Self {
            Self {
                tracker: Tracker::with_home(Some(PathBuf::from(CWD)), PathBuf::from("/Users/me")),
                next: 0,
            }
        }

        fn id(&mut self) -> String {
            self.next += 1;
            format!("t{}", self.next)
        }

        fn call(&mut self, kind: ToolKind, name: &str, input: Value, locations: &[&str], output: &str) -> Vec<String> {
            let id = self.id();
            self.tracker.observe(&started(&id, kind, name, input, locations));
            self.tracker.observe(&completed(&id, ToolStatus::Ok, output))
        }

        fn read(&mut self, path: &str) {
            self.call(ToolKind::Read, "read", Value::Null, &[path], "");
        }

        fn shell(&mut self, command: &str, output: &str) {
            self.call(ToolKind::Execute, "execute", json!({ "command": command }), &[], output);
        }

        fn edit(&mut self, path: &str, kind: FileEditKind, status: ToolStatus) -> Vec<String> {
            let id = self.id();
            self.tracker
                .observe(&started(&id, ToolKind::Edit, "edit", Value::Null, &[path]));
            self.tracker.observe(&file_edit(&id, path, kind));
            self.tracker.observe(&completed(&id, status, ""))
        }

        fn modify(&mut self, path: &str) -> Vec<String> {
            self.edit(path, FileEditKind::Modified, ToolStatus::Ok)
        }
    }

    fn started(id: &str, kind: ToolKind, name: &str, input: Value, locations: &[&str]) -> ChatEvent {
        ChatEvent::ToolCallStarted {
            session_id: "s1".into(),
            turn_id: "turn".into(),
            tool_use_id: id.into(),
            name: name.into(),
            input,
            kind,
            locations: locations
                .iter()
                .map(|p| ToolLocation {
                    path: p.to_string(),
                    line: None,
                })
                .collect(),
            title: None,
            secret: None,
        }
    }

    fn file_edit(id: &str, path: &str, kind: FileEditKind) -> ChatEvent {
        ChatEvent::FileEdit {
            session_id: "s1".into(),
            turn_id: "turn".into(),
            tool_use_id: id.into(),
            path: path.into(),
            kind,
            before_blob: None,
        }
    }

    fn completed(id: &str, status: ToolStatus, output: &str) -> ChatEvent {
        ChatEvent::ToolCallCompleted {
            session_id: "s1".into(),
            turn_id: "turn".into(),
            tool_use_id: id.into(),
            status,
            output: Some(output.into()),
            files: Vec::new(),
            duration_ms: None,
            summary: None,
            output_truncated: false,
            patch: Vec::new(),
            blind_edits: Vec::new(),
        }
    }

    const A: &str = "/w/app/src/a.rs";

    #[test]
    fn an_edit_is_blind_only_when_nothing_showed_the_file_first() {
        let mut run = Run::new();
        run.read(A);
        assert!(run.modify(A).is_empty(), "read then edit");

        let mut run = Run::new();
        assert_eq!(run.modify(A), vec![A.to_string()], "edit then read");
        run.read(A);

        let mut run = Run::new();
        assert!(
            run.edit(A, FileEditKind::Created, ToolStatus::Ok).is_empty(),
            "a creation"
        );
        assert!(run.modify(A).is_empty(), "an edit after creating it");

        let mut run = Run::new();
        assert_eq!(run.modify(A).len(), 1);
        assert!(
            run.modify(A).is_empty(),
            "the second edit of a file whose first was blind"
        );

        let mut run = Run::new();
        assert!(
            run.edit(A, FileEditKind::Modified, ToolStatus::Error).is_empty(),
            "a failed edit"
        );
        assert_eq!(run.modify(A).len(), 1, "a failed edit is not having seen it");

        let mut run = Run::new();
        assert!(
            run.edit(A, FileEditKind::Deleted, ToolStatus::Ok).is_empty(),
            "a delete"
        );
    }

    #[test]
    fn a_shell_command_counts_the_files_it_names_but_never_a_directory() {
        let mut run = Run::new();
        run.shell("cat src/a.rs", "");
        assert!(run.modify(A).is_empty(), "cat");

        let mut run = Run::new();
        run.shell("rg -n parse src", "src/a.rs:12:fn parse() {}\n");
        assert!(run.modify(A).is_empty(), "a search hit");
        assert_eq!(run.modify("/w/app/src/b.rs").len(), 1, "a file the search did not name");

        for command in ["ls src", "find .", "rg --files"] {
            let mut run = Run::new();
            run.shell(command, "src/b.rs\n");
            assert_eq!(run.modify("/w/app/src/b.rs").len(), 1, "{command}");
        }

        let mut run = Run::new();
        run.shell("cd sub && sed -n 1,9p f", "");
        assert!(run.modify("/w/app/sub/f").is_empty(), "a cd earlier in the command");

        let mut run = Run::new();
        run.shell("cd sub && rg -n x", "f:3:x\n");
        assert!(run.modify("/w/app/sub/f").is_empty(), "a search run after a cd");
    }

    #[test]
    fn a_search_tool_counts_its_hits_and_glob_counts_nothing() {
        let mut run = Run::new();
        run.call(
            ToolKind::Search,
            "search",
            json!({ "path": "src" }),
            &[],
            "src/a.rs:1:x\n",
        );
        assert!(run.modify(A).is_empty());

        let mut run = Run::new();
        run.call(ToolKind::Search, "Glob", json!({ "path": A }), &[], "");
        assert_eq!(run.modify(A).len(), 1);
    }

    #[test]
    fn a_move_carries_the_seen_file_to_its_new_name() {
        let mut run = Run::new();
        run.read(A);
        run.call(ToolKind::Move, "move", Value::Null, &[A, "/w/app/src/b.rs"], "");
        assert!(run.modify("/w/app/src/b.rs").is_empty());

        let mut run = Run::new();
        run.call(ToolKind::Move, "move", Value::Null, &[A, "/w/app/src/b.rs"], "");
        assert_eq!(
            run.modify("/w/app/src/b.rs").len(),
            1,
            "an unseen file moved stays unseen"
        );
    }

    #[test]
    fn a_claude_write_is_never_judged() {
        let mut run = Run::new();
        let id = run.id();
        run.tracker
            .observe(&started(&id, ToolKind::Edit, "Write", json!({ "file_path": A }), &[]));
        let mut done = completed(&id, ToolStatus::Ok, "");
        if let ChatEvent::ToolCallCompleted { files, .. } = &mut done {
            *files = vec![A.into()];
        }
        assert!(run.tracker.observe(&done).is_empty());
    }

    #[test]
    fn a_replay_through_the_same_tracker_keeps_each_answer() {
        let mut run = Run::new();
        let edit = [
            started("e1", ToolKind::Edit, "edit", Value::Null, &[A]),
            file_edit("e1", A, FileEditKind::Modified),
            completed("e1", ToolStatus::Ok, ""),
            started("r1", ToolKind::Read, "read", Value::Null, &[A]),
            completed("r1", ToolStatus::Ok, ""),
        ];
        let first: Vec<Vec<String>> = edit.iter().map(|e| run.tracker.observe(e)).collect();
        let again: Vec<Vec<String>> = edit.iter().map(|e| run.tracker.observe(e)).collect();
        assert_eq!(first[2], vec![A.to_string()]);
        assert_eq!(first, again);
        assert!(run.modify(A).is_empty(), "a live edit after the replay of a read");
    }
}
