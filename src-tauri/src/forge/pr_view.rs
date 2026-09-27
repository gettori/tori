//! A pull request as a reviewer reads it, and the check a review draft passes
//! before anyone is asked to approve it. See [[concept_review_line_anchoring]].

use serde::Serialize;

use super::model::{Capabilities, DiffSide, DraftComment, FileStatus, Paged, PrFile, PullRequest, ReviewEvent};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrView {
    pub pull_request: PullRequest,
    pub files: Vec<FileView>,
    /// The host stopped listing files before the end, so a file missing here may still be in the diff.
    pub files_truncated: bool,
    /// The signed in account opened it, so approve and request changes are not its to give.
    pub mine: bool,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: FileStatus,
    /// The host sent a patch, so a line comment has something to anchor to.
    pub commentable: bool,
    /// Inclusive line ranges a comment may anchor to, in the base file's numbering.
    pub left: Vec<(u32, u32)>,
    /// The same in the head file's numbering.
    pub right: Vec<(u32, u32)>,
}

pub fn view(pull_request: PullRequest, files: Paged<PrFile>, viewer: &str, capabilities: Capabilities) -> PrView {
    let mine = !viewer.is_empty() && viewer.eq_ignore_ascii_case(&pull_request.author);
    PrView {
        files: files.items.into_iter().map(file_view).collect(),
        files_truncated: files.truncated,
        mine,
        pull_request,
        capabilities,
    }
}

fn file_view(file: PrFile) -> FileView {
    let hunks = file.patch.as_deref().map(|p| crate::patch::parse_patch(p).hunks).unwrap_or_default();
    let span = |start: u32, count: u32| (count > 0).then(|| (start, start + count - 1));
    FileView {
        commentable: file.patch.is_some(),
        left: hunks.iter().filter_map(|h| span(h.old_start, h.old_count)).collect(),
        right: hunks.iter().filter_map(|h| span(h.new_start, h.new_count)).collect(),
        path: file.path,
        previous_path: file.previous_path,
        status: file.status,
    }
}

/// Refuses a review that would not post as drawn, naming the verdict or the comment at fault.
pub fn check_review(view: &PrView, head_sha: &str, event: ReviewEvent, comments: &[DraftComment]) -> Result<(), String> {
    let pr = &view.pull_request;
    if pr.head_sha != head_sha {
        return Err(format!("#{} moved past {head_sha} to {}, ask again for the new head", pr.number, pr.head_sha));
    }
    let offered = match event {
        ReviewEvent::Approve => view.capabilities.approve,
        ReviewEvent::RequestChanges => view.capabilities.request_changes,
        ReviewEvent::Comment => view.capabilities.comment_review,
    };
    if !offered {
        return Err(format!("this host has no {event:?} verdict, pick another"));
    }
    if view.mine && event != ReviewEvent::Comment {
        return Err(format!("#{} is your own pull request, so only a Comment review can go on it", pr.number));
    }
    for (i, c) in comments.iter().enumerate() {
        let n = i + 1;
        let Some(file) = view.files.iter().find(|f| f.path == c.path) else {
            return Err(format!("comment {n} is on {}, which #{} does not change", c.path, pr.number));
        };
        if !file.commentable {
            return Err(format!("comment {n} is on {}, which has no patch to anchor to (binary, mode only or too large)", c.path));
        }
        let ends = [Some((c.line, c.side)), c.start_line.map(|l| (l, c.start_side.unwrap_or(c.side)))];
        for (line, side) in ends.into_iter().flatten() {
            let ranges = match side {
                DiffSide::Left => &file.left,
                DiffSide::Right => &file.right,
            };
            if !ranges.iter().any(|(from, to)| (*from..=*to).contains(&line)) {
                return Err(format!("comment {n}: line {line} ({side:?}) of {} is outside the diff", c.path));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::model::MergeableState;
    use crate::forge::model::PrState;

    fn caps(request_changes: bool) -> Capabilities {
        Capabilities {
            pull_requests: true,
            checks: true,
            review_threads: true,
            resolve_threads: true,
            merge: true,
            approve: true,
            request_changes,
            comment_review: true,
            single_comment: true,
        }
    }

    fn pr(author: &str) -> PullRequest {
        PullRequest {
            number: 45,
            title: "T".into(),
            body: None,
            state: PrState::Open,
            is_draft: false,
            author: author.into(),
            created_at: String::new(),
            merged_at: None,
            closed_at: None,
            comments: 0,
            head_ref: "feature".into(),
            base_ref: "main".into(),
            head_sha: "abc".into(),
            head_repo_is_origin: true,
            url: String::new(),
            mergeable_state: MergeableState::Unknown,
        }
    }

    fn file(path: &str, patch: Option<&str>) -> PrFile {
        PrFile {
            path: path.into(),
            previous_path: None,
            status: FileStatus::Modified,
            additions: 1,
            deletions: 1,
            patch: patch.map(str::to_string),
        }
    }

    fn sample(author: &str, request_changes: bool) -> PrView {
        let files = Paged::complete(vec![
            file("src/a.rs", Some("@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+more\n ctx\n")),
            file("logo.png", None),
        ]);
        view(pr(author), files, "me", caps(request_changes))
    }

    fn comment(path: &str, line: u32, side: DiffSide) -> DraftComment {
        DraftComment { path: path.into(), line, side, start_line: None, start_side: None, body: "b".into() }
    }

    #[test]
    fn the_view_says_whose_it_is_what_the_host_offers_and_where_a_comment_can_go() {
        let mine = sample("Me", false);
        assert!(mine.mine, "the login compares without case");
        assert!(!sample("them", true).mine);
        assert!(!mine.capabilities.request_changes);
        assert_eq!((mine.files[0].left.clone(), mine.files[0].right.clone()), (vec![(10, 12)], vec![(10, 13)]));
        assert!(mine.files[0].commentable);
        assert!(!mine.files[1].commentable, "a file with no patch has nothing to anchor to");
    }

    #[test]
    fn a_draft_inside_the_diff_on_the_head_it_was_drawn_against_passes() {
        let ok = [comment("src/a.rs", 13, DiffSide::Right), comment("src/a.rs", 11, DiffSide::Left)];
        assert_eq!(check_review(&sample("them", true), "abc", ReviewEvent::RequestChanges, &ok), Ok(()));
    }

    #[test]
    fn a_moved_head_is_refused_as_moved() {
        let err = check_review(&sample("them", true), "old", ReviewEvent::Comment, &[]).unwrap_err();
        assert!(err.contains("moved past old to abc"), "{err}");
    }

    #[test]
    fn a_verdict_the_host_lacks_is_refused() {
        let err = check_review(&sample("them", false), "abc", ReviewEvent::RequestChanges, &[]).unwrap_err();
        assert!(err.contains("no RequestChanges verdict"), "{err}");
    }

    #[test]
    fn approve_and_request_changes_on_your_own_pull_request_are_refused() {
        for event in [ReviewEvent::Approve, ReviewEvent::RequestChanges] {
            let err = check_review(&sample("me", true), "abc", event, &[]).unwrap_err();
            assert!(err.contains("your own pull request"), "{err}");
        }
        assert_eq!(check_review(&sample("me", true), "abc", ReviewEvent::Comment, &[]), Ok(()));
    }

    #[test]
    fn a_comment_outside_the_diff_is_refused_by_its_number() {
        let past = [comment("src/a.rs", 13, DiffSide::Right), comment("src/a.rs", 13, DiffSide::Left)];
        let err = check_review(&sample("them", true), "abc", ReviewEvent::Comment, &past).unwrap_err();
        assert!(err.contains("comment 2: line 13 (Left)"), "{err}");
        let range = [DraftComment { start_line: Some(2), start_side: Some(DiffSide::Right), ..comment("src/a.rs", 12, DiffSide::Right) }];
        let err = check_review(&sample("them", true), "abc", ReviewEvent::Comment, &range).unwrap_err();
        assert!(err.contains("comment 1: line 2 (Right)"), "{err}");
        let elsewhere = [comment("src/b.rs", 1, DiffSide::Right)];
        let err = check_review(&sample("them", true), "abc", ReviewEvent::Comment, &elsewhere).unwrap_err();
        assert!(err.contains("does not change"), "{err}");
    }

    #[test]
    fn a_comment_on_a_file_with_no_patch_is_refused() {
        let err = check_review(&sample("them", true), "abc", ReviewEvent::Comment, &[comment("logo.png", 1, DiffSide::Right)]).unwrap_err();
        assert!(err.contains("no patch to anchor to"), "{err}");
    }
}
