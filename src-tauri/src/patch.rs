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
