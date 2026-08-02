// Reconstructing a partial patch from a subset of a file's hunks, for
// hunk-level staging (`git apply --cached`).
//
// Two things here are easy to get wrong and both corrupt the index silently:
//
//   1. **Offsets.** Dropping a hunk shifts every later hunk on the side being
//      produced. `git add -p` rewrites those headers and so must we, or git
//      applies the right content at the wrong line.
//   2. **Direction.** The side the patch is applied *to* must keep its original
//      coordinates; only the side being produced is recomputed. Staging applies
//      forward to the index (source = old side); unstaging applies in reverse
//      (source = new side). Getting this backwards mangles the file rather than
//      failing, which is why the two cases are spelled out separately below.
//
// Hunks are also content-fingerprinted so a stale UI cannot stage the wrong
// one: hunk *indices* are only meaningful against the exact diff they came
// from, and an agent writing to the file between render and click renumbers
// them. The fingerprint is FNV-1a over the hunk's header and body, and the
// frontend computes it identically (`src/utils/hunkFingerprint.ts`) so the
// value the UI rendered is the value the backend re-derives.

/// One hunk of a single-file unified diff.
#[derive(Debug, Clone, PartialEq)]
pub struct PatchHunk {
    /// The verbatim `@@ ... @@` line, including any trailing section heading.
    pub header: String,
    /// The hunk's lines, header excluded.
    pub body: Vec<String>,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub fingerprint: String,
}

/// A parsed single-file patch: the `diff --git`/`index`/`---`/`+++` preamble
/// plus its hunks.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FilePatch {
    pub preamble: Vec<String>,
    pub hunks: Vec<PatchHunk>,
}

fn fnv1a(hash: &mut u32, s: &str) {
    for b in s.bytes() {
        *hash ^= b as u32;
        *hash = hash.wrapping_mul(0x0100_0193);
    }
}

/// Stable content hash of a hunk. Mirrored byte-for-byte by the frontend.
pub fn fingerprint(header: &str, body: &[String]) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    fnv1a(&mut hash, header);
    for line in body {
        fnv1a(&mut hash, "\n");
        fnv1a(&mut hash, line);
    }
    format!("{:08x}", hash)
}

/// Parse "12,3" or "12" (count defaults to 1).
fn parse_span(s: &str) -> (u32, u32) {
    let mut parts = s.splitn(2, ',');
    let start = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let count = parts.next().map_or(1, |v| v.parse().unwrap_or(1));
    (start, count)
}

/// Split a `@@ -a,b +c,d @@ heading` line into its two spans.
fn parse_hunk_header(line: &str) -> Option<((u32, u32), (u32, u32))> {
    let rest = line.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    let mut spans = rest[..end].split_whitespace();
    let old = spans.next()?.strip_prefix('-')?;
    let new = spans.next()?.strip_prefix('+')?;
    Some((parse_span(old), parse_span(new)))
}

/// Parse the unified diff of a single file.
pub fn parse_patch(text: &str) -> FilePatch {
    let mut out = FilePatch::default();
    let mut current: Option<PatchHunk> = None;

    for line in text.lines() {
        if let Some((old, new)) = parse_hunk_header(line) {
            if let Some(h) = current.take() {
                out.hunks.push(h);
            }
            current = Some(PatchHunk {
                header: line.to_string(),
                body: Vec::new(),
                old_start: old.0,
                old_count: old.1,
                new_start: new.0,
                new_count: new.1,
                fingerprint: String::new(),
            });
            continue;
        }
        match current.as_mut() {
            Some(h) => h.body.push(line.to_string()),
            // Everything before the first hunk is the file preamble.
            None => out.preamble.push(line.to_string()),
        }
    }
    if let Some(h) = current.take() {
        out.hunks.push(h);
    }

    for h in &mut out.hunks {
        h.fingerprint = fingerprint(&h.header, &h.body);
    }
    out
}

/// Build a patch containing only `selected` hunks, with headers rewritten so
/// the offsets are consistent once the unselected hunks are absent.
///
/// `reverse` describes how the result will be applied (`git apply --reverse`),
/// which decides *which* side keeps its original coordinates: see the module
/// header. Indices are into `patch.hunks`; order does not matter.
pub fn build_patch(patch: &FilePatch, selected: &[usize], reverse: bool) -> Result<String, String> {
    if selected.is_empty() {
        return Err("No hunks selected".into());
    }
    let mut idx: Vec<usize> = selected.to_vec();
    idx.sort_unstable();
    idx.dedup();
    if let Some(&bad) = idx.iter().find(|&&i| i >= patch.hunks.len()) {
        return Err(format!("Hunk {} is out of range", bad));
    }

    let mut out = String::new();
    for line in &patch.preamble {
        out.push_str(line);
        out.push('\n');
    }

    // Running line-count drift introduced by the hunks kept so far. Only
    // selected hunks contribute: the dropped ones are not in this patch, so
    // they shift nothing.
    let mut delta: i64 = 0;
    for &i in &idx {
        let h = &patch.hunks[i];
        let (old_start, new_start) = if reverse {
            // Applied in reverse: the new side is the source and keeps its real
            // coordinates; the old side is what gets produced.
            let old = h.new_start as i64 + delta;
            (old.max(0) as u32, h.new_start)
        } else {
            // Applied forward: the old side is the source.
            let new = h.old_start as i64 + delta;
            (h.old_start, new.max(0) as u32)
        };

        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            if reverse { old_start } else { h.old_start },
            h.old_count,
            if reverse { h.new_start } else { new_start },
            h.new_count,
        ));
        for line in &h.body {
            out.push_str(line);
            out.push('\n');
        }

        delta += if reverse {
            h.old_count as i64 - h.new_count as i64
        } else {
            h.new_count as i64 - h.old_count as i64
        };
    }

    Ok(out)
}

/// Which sides of the diff a body line belongs to: `(old, new)`.
///
/// A `\ No newline at end of file` marker is on neither: it is an annotation on
/// the line above, not a line of either version.
fn sides(line: &str) -> (bool, bool) {
    match line.as_bytes().first() {
        Some(b'\\') => (false, false),
        Some(b'+') => (false, true),
        Some(b'-') => (true, false),
        _ => (true, true),
    }
}

/// `(old_count, new_count)` for a hunk body, counted rather than trusted: a
/// line-selected rebuild changes the produced side's length.
fn side_counts(body: &[String]) -> (u32, u32) {
    let mut old = 0;
    let mut new = 0;
    for line in body {
        let (o, n) = sides(line);
        old += o as u32;
        new += n as u32;
    }
    (old, new)
}

pub const SPLIT_NO_NEWLINE: &str =
    "That selection splits the end of a file that has no final newline. Use the whole hunk instead.";

/// A `\ No newline at end of file` marker is only meaningful directly after the
/// *last* line of a side. Dropping or demoting lines around one can strand it in
/// the middle, which git accepts as far as parsing and then applies wrongly, so
/// the rebuild refuses instead.
fn markers_are_coherent(body: &[String]) -> bool {
    for (i, line) in body.iter().enumerate() {
        if !line.starts_with('\\') {
            continue;
        }
        let Some(owner) = i.checked_sub(1).map(|j| &body[j]) else {
            return false;
        };
        let (claims_old, claims_new) = sides(owner);
        if body[i + 1..].iter().any(|l| {
            let (o, n) = sides(l);
            (claims_old && o) || (claims_new && n)
        }) {
            return false;
        }
    }
    true
}

/// Build a patch from a subset of the *lines* of one hunk.
///
/// `lines` are indices into `patch.hunks[hunk].body`. The rule is one rule seen
/// from two directions: the side the patch is applied *to* is the source, and
/// every source line has to survive, as itself if selected and as context if
/// not, while an unselected line that exists only on the produced side is
/// dropped. Staging applies forward, so the old side is the source: unselected
/// `-` becomes context, unselected `+` disappears. Unstaging applies in reverse,
/// so the new side is the source and the two swap.
///
/// The hunk is never split into several. Its source span stays whole, so the
/// context around a selection always abuts it however scattered the selection
/// is, and the unselected changes in between are exactly the context that holds
/// the two ends together. The alternative, emitting a hunk per run of selected
/// lines, would have to re-derive context git never sent us.
///
/// **A demoted line keeps its place in the body**, which is the one visible
/// consequence worth knowing about. git groups a run of removals and then a run
/// of additions, so demoting a removal inside such a block places it *before*
/// the additions on the produced side: staging only the `a -> A` half of
/// `-a -b +A +B` produces `b, A`, not `A, b`. Ordering the block correctly would
/// need to know which removal each addition replaces, and a unified diff does
/// not say; the panel's pairing is a similarity guess, and guessing wrong here
/// writes the wrong file into the index rather than merely rendering oddly. So
/// this follows the rule git's own `add -p` edit mode documents ("to remove
/// a `-` line, make it a ` ` line"), which is what every other line-staging tool
/// produces, and the panel re-reads the diff afterwards so the result is on
/// screen immediately.
///
/// Indices naming a context line or a `\` marker are ignored (the fingerprint
/// check upstream already proves the body is the one the UI rendered, so they
/// can only mean the caller counted rows it did not offer); at least one changed
/// line must survive or there is nothing to apply.
pub fn build_line_patch(patch: &FilePatch, hunk: usize, lines: &[usize], reverse: bool) -> Result<String, String> {
    let h = patch.hunks.get(hunk).ok_or_else(|| format!("Hunk {} is out of range", hunk))?;
    if let Some(&bad) = lines.iter().find(|&&i| i >= h.body.len()) {
        return Err(format!("Line {} is out of range", bad));
    }
    let picked: std::collections::HashSet<usize> = lines.iter().copied().collect();

    // The marker of the side that is *not* produced, i.e. the one whose
    // unselected lines stay as context.
    let source = if reverse { b'+' } else { b'-' };
    let mut body: Vec<String> = Vec::with_capacity(h.body.len());
    let mut changed = 0usize;
    // Whether the previous content line made it into `body`; a marker follows
    // its owner rather than being decided on its own.
    let mut owner_kept = false;
    for (i, line) in h.body.iter().enumerate() {
        let mark = line.as_bytes().first().copied().unwrap_or(b' ');
        if mark == b'\\' {
            if owner_kept {
                body.push(line.clone());
            }
            continue;
        }
        owner_kept = true;
        if mark != b'+' && mark != b'-' {
            body.push(line.clone());
        } else if picked.contains(&i) {
            changed += 1;
            body.push(line.clone());
        } else if mark == source {
            body.push(format!(" {}", &line[1..]));
        } else {
            owner_kept = false;
        }
    }

    if changed == 0 {
        return Err("No lines selected".into());
    }
    if !markers_are_coherent(&body) {
        return Err(SPLIT_NO_NEWLINE.into());
    }

    let (old_count, new_count) = side_counts(&body);
    // Only hunk in the patch, so nothing has shifted ahead of it: the produced
    // side starts wherever the source side does. Which of `h`'s starts that is
    // depends on the direction, exactly as in `build_patch`.
    let start = if reverse { h.new_start } else { h.old_start };

    let mut out = String::new();
    for line in &patch.preamble {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(&format!("@@ -{},{} +{},{} @@\n", start, old_count, start, new_count));
    for line in &body {
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/f.txt b/f.txt\n\
index 111..222 100644\n\
--- a/f.txt\n\
+++ b/f.txt\n\
@@ -1,3 +1,4 @@\n\
 one\n\
+added\n\
 two\n\
 three\n\
@@ -10,3 +11,2 @@\n\
 ten\n\
-eleven\n\
 twelve\n";

    #[test]
    fn parses_preamble_and_hunks() {
        let p = parse_patch(SAMPLE);
        assert_eq!(p.preamble.len(), 4);
        assert_eq!(p.hunks.len(), 2);
        assert_eq!((p.hunks[0].old_start, p.hunks[0].old_count), (1, 3));
        assert_eq!((p.hunks[0].new_start, p.hunks[0].new_count), (1, 4));
        assert_eq!((p.hunks[1].old_start, p.hunks[1].old_count), (10, 3));
        assert_eq!(p.hunks[0].body.len(), 4);
    }

    #[test]
    fn header_without_count_defaults_to_one() {
        let p = parse_patch("@@ -5 +5,2 @@\n one\n+two\n");
        assert_eq!((p.hunks[0].old_start, p.hunks[0].old_count), (5, 1));
    }

    #[test]
    fn keeps_the_section_heading_out_of_the_spans() {
        let p = parse_patch("@@ -1,2 +1,3 @@ fn main() {\n a\n+b\n c\n");
        assert_eq!(p.hunks.len(), 1);
        assert_eq!((p.hunks[0].new_start, p.hunks[0].new_count), (1, 3));
    }

    #[test]
    fn fingerprint_is_stable_and_content_sensitive() {
        let p = parse_patch(SAMPLE);
        assert_eq!(p.hunks[0].fingerprint, fingerprint(&p.hunks[0].header, &p.hunks[0].body));
        assert_ne!(p.hunks[0].fingerprint, p.hunks[1].fingerprint);

        // A one-character body edit must change it, or a stale hunk passes.
        let mut body = p.hunks[0].body.clone();
        body[1] = "+addedX".into();
        assert_ne!(p.hunks[0].fingerprint, fingerprint(&p.hunks[0].header, &body));
    }

    #[test]
    fn fingerprint_matches_the_frontend_implementation() {
        // Locked to the value src/utils/hunkFingerprint.test.ts asserts for the
        // same input. If the two ever drift, both suites fail loudly rather
        // than the UI silently failing every stage.
        assert_eq!(fingerprint("@@ -1,1 +1,1 @@", &["-a".into(), "+b".into()]), "8fb2ba78");
    }

    #[test]
    fn forward_patch_keeps_old_side_and_shifts_new() {
        let p = parse_patch(SAMPLE);
        // Selecting only the second hunk: its old side is untouched, but the
        // first hunk's +1 line is absent, so the new side loses that shift.
        let out = build_patch(&p, &[1], false).unwrap();
        assert!(out.contains("@@ -10,3 +10,2 @@"), "got: {}", out);
        assert!(out.contains("-eleven"));
        assert!(!out.contains("+added"));
    }

    #[test]
    fn reverse_patch_keeps_new_side_and_shifts_old() {
        let p = parse_patch(SAMPLE);
        let out = build_patch(&p, &[1], true).unwrap();
        // New side is the source under --reverse, so it keeps 11.
        assert!(out.contains("@@ -11,3 +11,2 @@"), "got: {}", out);
    }

    #[test]
    fn selecting_every_hunk_reproduces_the_original_offsets() {
        let p = parse_patch(SAMPLE);
        let out = build_patch(&p, &[0, 1], false).unwrap();
        assert!(out.contains("@@ -1,3 +1,4 @@"));
        assert!(out.contains("@@ -10,3 +11,2 @@"));
    }

    #[test]
    fn preamble_is_always_carried_so_git_can_locate_the_file() {
        let out = build_patch(&parse_patch(SAMPLE), &[0], false).unwrap();
        assert!(out.starts_with("diff --git a/f.txt b/f.txt\n"));
        assert!(out.contains("--- a/f.txt\n+++ b/f.txt\n"));
    }

    #[test]
    fn out_of_order_and_duplicate_selections_normalise() {
        let p = parse_patch(SAMPLE);
        assert_eq!(
            build_patch(&p, &[1, 0, 1], false).unwrap(),
            build_patch(&p, &[0, 1], false).unwrap()
        );
    }

    #[test]
    fn rejects_an_empty_or_out_of_range_selection() {
        let p = parse_patch(SAMPLE);
        assert!(build_patch(&p, &[], false).is_err());
        assert!(build_patch(&p, &[7], false).is_err());
    }

    #[test]
    fn patch_always_ends_with_a_newline() {
        let out = build_patch(&parse_patch(SAMPLE), &[0], false).unwrap();
        assert!(out.ends_with('\n'), "git apply rejects a truncated final line");
    }

    /// One hunk rewriting three separate lines, with context between them, so a
    /// selection can leave changes on both sides of the ones it keeps.
    // Written flat rather than with `\`-continuations: those swallow the
    // leading whitespace of the next line, and here a leading space *is* the
    // marker that says "context".
    const SCATTERED: &str = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,7 +1,7 @@\n one\n-two\n+TWO\n three\n-four\n+FOUR\n five\n-six\n+SIX\n seven\n";

    fn body_of(patch: &str) -> Vec<String> {
        patch.lines().skip_while(|l| !l.starts_with("@@")).skip(1).map(str::to_string).collect()
    }

    #[test]
    fn staging_a_line_drops_the_additions_it_left_and_keeps_their_removals() {
        let p = parse_patch(SCATTERED);
        // Body index 2 is "+TWO"; take it and its own removal at index 1.
        let out = build_line_patch(&p, 0, &[1, 2], false).unwrap();
        assert_eq!(
            body_of(&out),
            vec![" one", "-two", "+TWO", " three", " four", " five", " six", " seven"],
            "got: {out}"
        );
        // The old side is the source, so it is unchanged in length and start.
        assert!(out.contains("@@ -1,7 +1,7 @@"), "got: {out}");
    }

    #[test]
    fn taking_an_addition_without_its_removal_leaves_both_lines() {
        let p = parse_patch(SCATTERED);
        let out = build_line_patch(&p, 0, &[2], false).unwrap();
        assert_eq!(
            body_of(&out),
            vec![" one", " two", "+TWO", " three", " four", " five", " six", " seven"]
        );
        // One line longer on the new side, and the header has to say so.
        assert!(out.contains("@@ -1,7 +1,8 @@"), "got: {out}");
    }

    #[test]
    fn a_scattered_selection_stays_one_hunk_so_its_context_still_abuts() {
        let p = parse_patch(SCATTERED);
        // First and third change, skipping the middle one entirely.
        let out = build_line_patch(&p, 0, &[1, 2, 7, 8], false).unwrap();
        assert_eq!(out.matches("@@ ").count(), 1, "one hunk, not one per run: {out}");
        let body = body_of(&out);
        assert_eq!(body[4], " four", "the skipped change becomes the context between the two runs");
        assert!(body.contains(&"+TWO".to_string()) && body.contains(&"+SIX".to_string()));
        assert!(!body.contains(&"+FOUR".to_string()));
    }

    #[test]
    fn unstaging_a_line_mirrors_the_rule_onto_the_other_side() {
        let p = parse_patch(SCATTERED);
        let out = build_line_patch(&p, 0, &[1, 2], true).unwrap();
        // Reverse: the new side is the source, so the unselected *additions*
        // are what survive as context and the removals vanish.
        assert_eq!(
            body_of(&out),
            vec![" one", "-two", "+TWO", " three", " FOUR", " five", " SIX", " seven"]
        );
        assert!(out.contains("@@ -1,7 +1,7 @@"), "got: {out}");
    }

    #[test]
    fn reverse_anchors_the_hunk_on_the_new_side() {
        // Old and new start differ, so an anchor taken from the wrong side
        // would place the patch several lines off.
        let p = parse_patch("--- a/f\n+++ b/f\n@@ -4,2 +9,2 @@\n-a\n+b\n c\n");
        assert!(build_line_patch(&p, 0, &[0, 1], true).unwrap().contains("@@ -9,2 +9,2 @@"));
        assert!(build_line_patch(&p, 0, &[0, 1], false).unwrap().contains("@@ -4,2 +4,2 @@"));
    }

    #[test]
    fn a_demoted_removal_keeps_its_place_in_the_body() {
        // The documented ordering consequence, pinned so it cannot change by
        // accident: git groups removals ahead of additions, so a removal kept
        // as context lands ahead of the addition that replaced its neighbour.
        let p = parse_patch("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n-b\n+A\n+B\n");
        let out = build_line_patch(&p, 0, &[0, 2], false).unwrap();
        assert_eq!(body_of(&out), vec!["-a", " b", "+A"], "got: {out}");
        assert!(out.contains("@@ -1,2 +1,2 @@"));
    }

    #[test]
    fn a_selection_with_no_changed_line_in_it_is_refused() {
        let p = parse_patch(SCATTERED);
        // Index 0 is " one", a context line: nothing would be applied.
        assert_eq!(build_line_patch(&p, 0, &[0], false).unwrap_err(), "No lines selected");
        assert_eq!(build_line_patch(&p, 0, &[], false).unwrap_err(), "No lines selected");
    }

    #[test]
    fn out_of_range_hunk_or_line_is_refused_rather_than_panicking() {
        let p = parse_patch(SCATTERED);
        assert!(build_line_patch(&p, 9, &[1], false).is_err());
        assert!(build_line_patch(&p, 0, &[99], false).is_err());
    }

    #[test]
    fn the_preamble_is_carried_and_the_patch_ends_with_a_newline() {
        let out = build_line_patch(&parse_patch(SCATTERED), 0, &[1], false).unwrap();
        assert!(out.starts_with("diff --git a/f.txt b/f.txt\n"));
        assert!(out.contains("--- a/f.txt\n+++ b/f.txt\n"));
        assert!(out.ends_with('\n'));
    }

    const NO_NEWLINE: &str = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n keep\n-last\n\\ No newline at end of file\n+LAST\n\\ No newline at end of file\n";

    #[test]
    fn a_dropped_line_takes_its_no_newline_marker_with_it() {
        let p = parse_patch(NO_NEWLINE);
        // Both halves of the final-line rewrite, which is representable.
        let out = build_line_patch(&p, 0, &[1, 3], false).unwrap();
        assert_eq!(out.matches("\\ No newline").count(), 2, "got: {out}");
    }

    #[test]
    fn splitting_a_file_with_no_final_newline_is_refused_not_corrupted() {
        let p = parse_patch(NO_NEWLINE);
        // Taking the addition alone would leave the demoted " last" claiming to
        // be the end of the file with another line after it.
        assert_eq!(build_line_patch(&p, 0, &[3], false).unwrap_err(), SPLIT_NO_NEWLINE);
    }

    #[test]
    fn a_marker_left_at_the_end_is_still_accepted() {
        // Removing the last line of a file that had no final newline, with
        // nothing added back: the marker stays last, so it stays coherent.
        let p = parse_patch("--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n keep\n-last\n\\ No newline at end of file\n");
        let out = build_line_patch(&p, 0, &[1], false).unwrap();
        assert!(out.ends_with("-last\n\\ No newline at end of file\n"), "got: {out}");
    }
}

#[cfg(test)]
mod cross_language_tests {
    use super::*;

    /// A realistic two-hunk diff, ending in a newline. Byte-identical to the
    /// fixture in `src/utils/diffHunks.test.ts`, which asserts the same two
    /// fingerprints after parsing it with the frontend parser.
    ///
    /// This is the check that matters: the locked scalar in `patch.rs` proves
    /// the hash agrees, but only a shared *parse-then-hash* fixture proves the
    /// two hunk parsers agree about what a hunk's body is. They differed once
    /// already (a trailing newline left a phantom line on the frontend, which
    /// would have refused staging of every last hunk).
    pub const SHARED_FIXTURE: &str = "diff --git a/f.txt b/f.txt\nindex 111..222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line 2 EDITED\n line 3\n@@ -17,3 +17,3 @@\n line 17\n-line 18\n+line 18 EDITED\n line 19\n";

    #[test]
    fn shared_fixture_fingerprints_are_locked() {
        let p = parse_patch(SHARED_FIXTURE);
        assert_eq!(p.hunks.len(), 2);
        assert_eq!(p.hunks[0].fingerprint, "dacccae2");
        assert_eq!(p.hunks[1].fingerprint, "5b3ffd64");
    }

    #[test]
    fn the_last_hunk_body_has_no_trailing_blank_line() {
        // The exact shape that differed between the two parsers.
        let p = parse_patch(SHARED_FIXTURE);
        assert_eq!(p.hunks[1].body.last().unwrap(), " line 19");
    }
}
