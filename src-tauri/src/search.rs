// Project-wide text search for the right panel's Search mode.
//
// One matcher decides everything. The canonical `regex::Regex` built from the
// user's options is the only thing that says whether a line matches and where
// the match sits; the three backends exist purely to narrow down which lines to
// hand it. That inversion is deliberate: `rg -w` is wider than `\b(?:pat)\b`
// (it matches `+foo` and `.env`, which the `\b` form cannot), so letting rg
// decide matches while Rust decides replace offsets would make search and
// replace disagree exactly where the offsets matter.
//
// Backend order: `rg --json` when installed, else `git grep -n --untracked`
// inside a git repo, else a plain recursive `grep -rn` with the same churn-dir
// excludes as `fs::list_project_files`. The grep fallbacks are given a *literal*
// pre-filter only (`-F` on the pattern's longest literal run), never a
// translated regex: POSIX ERE is not the same dialect as the `regex` crate, its
// behaviour varies by platform, and a pattern that is valid here can make grep
// exit 2. A literal pre-filter cannot do either.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;

use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Same list as `fs::IGNORED_DIRS`, including `.sway-attempts`: an attempt is a
/// second checkout of the same project, so without it every hit in the user's
/// own code would come back once more per attempt.
const IGNORED_DIRS: &[&str] =
    &[".git", "node_modules", "dist", "target", crate::attempts::ATTEMPTS_DIR];

/// What the user asked for, straight from the panel's toggles. `include` and
/// `exclude` are comma-separated glob lists; empty means "no filter".
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    /// Case-sensitive when true (the panel's `Aa` toggle).
    pub case: bool,
    /// Treat the query as a regex rather than a literal.
    pub regex: bool,
    /// Require word boundaries around the whole pattern.
    pub whole_word: bool,
    pub include: String,
    pub exclude: String,
    /// Search files the ignore rules would normally hide.
    pub no_ignore: bool,
}

#[derive(Clone, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
    /// Match spans within `text`, as **UTF-16 code-unit** offsets. Not bytes:
    /// the consumer is JavaScript, which indexes strings in UTF-16, so a line
    /// like `café needle` puts the match at 5 here where rg reports byte 6.
    pub submatches: Vec<(u32, u32)>,
}

/// A fingerprint for one matched file, taken at search time and handed back at
/// replace time so an edit cannot land on a file that moved underneath it.
///
/// Derived from size and mtime, not content: a search re-runs on every
/// debounced keystroke, and hashing the bytes of every matched file that often
/// would mean re-reading the whole result set from disk per keystroke. The
/// trade-off is that an edit which preserves a file's exact byte length within
/// the filesystem's mtime resolution is invisible here (nanoseconds on APFS, so
/// this needs a same-length write in the same nanosecond).
///
/// A string, not a number: these values exceed JSON's safe integer range.
#[derive(Clone, Serialize)]
pub struct FileDigest {
    pub path: String,
    pub digest: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    /// Which backend actually ran: `rg`, `git`, or `plain`.
    pub backend: String,
    /// Option names this backend cannot honour, so the panel can disable those
    /// toggles instead of letting them sit there doing nothing.
    pub unsupported: Vec<String>,
    pub files: Vec<FileDigest>,
}

/// One backend hit before the canonical regex has had its say.
struct Candidate {
    path: String,
    line: u32,
    text: String,
}

fn has_rg() -> bool {
    Command::new("rg")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn is_git_repo(root: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Strip only the line terminator, never other trailing whitespace: a match can
/// legitimately end in spaces (`\s+$`), and trimming them would push the match
/// span past the end of the text the UI renders. Applied by both parsers so a
/// CRLF file and an LF file produce identical text and identical offsets.
fn normalise_line(s: &str) -> &str {
    let s = s.strip_suffix('\n').unwrap_or(s);
    s.strip_suffix('\r').unwrap_or(s)
}

/// The pattern every backend and every offset agrees on.
fn canonical_pattern(query: &str, opts: &SearchOptions) -> String {
    let base = if opts.regex { query.to_string() } else { regex::escape(query) };
    let worded = if opts.whole_word { format!(r"\b(?:{base})\b") } else { base };
    if opts.case { worded } else { format!("(?i){worded}") }
}

fn build_regex(query: &str, opts: &SearchOptions) -> Result<Regex, String> {
    Regex::new(&canonical_pattern(query, opts)).map_err(|e| e.to_string())
}

/// The longest substring of `query` that must appear verbatim in any matching
/// line, used as the grep fallbacks' `-F` pre-filter. `None` means "no safe
/// literal", and the caller must then feed grep every line.
///
/// Deliberately conservative. Alternation and groups are bailed on entirely,
/// because a literal inside one branch of `foo|bar` is not required by the
/// pattern as a whole, and pre-filtering on it would drop real matches.
fn longest_literal(query: &str, opts: &SearchOptions) -> Option<String> {
    if !opts.regex {
        return if query.is_empty() { None } else { Some(query.to_string()) };
    }
    // A literal inside a group or an alternation branch is not required by the
    // pattern overall, and a quantifier can make a whole group vanish. Rather
    // than reason about nesting, give up and scan everything.
    if query.contains('|') || query.contains('(') || query.contains('[') || query.contains('{') {
        return None;
    }

    let mut best = String::new();
    let mut cur = String::new();
    let mut chars = query.chars();
    while let Some(c) = chars.next() {
        match c {
            // `\d`, `\w`, `\b` and friends are not literal, and `\.` is a
            // literal we would have to unescape; ending the run is the safe
            // under-approximation either way.
            '\\' => {
                chars.next();
                keep_longest(&mut cur, &mut best);
            }
            // The preceding character is optional, so it cannot be required.
            '*' | '?' => {
                cur.pop();
                keep_longest(&mut cur, &mut best);
            }
            // `x+` still requires one `x`, so the run stands as it is.
            '+' => keep_longest(&mut cur, &mut best),
            '.' | ')' | ']' | '}' | '^' | '$' => keep_longest(&mut cur, &mut best),
            _ => cur.push(c),
        }
    }
    keep_longest(&mut cur, &mut best);
    if best.is_empty() {
        None
    } else {
        Some(best)
    }
}

fn keep_longest(cur: &mut String, best: &mut String) {
    if cur.chars().count() > best.chars().count() {
        *best = cur.clone();
    }
    cur.clear();
}

/// Match spans as UTF-16 code-unit offsets. Zero-width matches are dropped: a
/// pattern like `x*` matches the empty string everywhere, which is meaningless
/// to highlight and undefined to replace.
fn submatches_utf16(re: &Regex, text: &str) -> Vec<(u32, u32)> {
    re.find_iter(text)
        .filter(|m| m.end() > m.start())
        .map(|m| {
            let start = text[..m.start()].encode_utf16().count() as u32;
            let len = text[m.start()..m.end()].encode_utf16().count() as u32;
            (start, start + len)
        })
        .collect()
}

/// Build a matcher from a comma-separated glob list. `None` when the list is
/// empty, meaning the filter does not apply at all.
fn build_globs(patterns: &str) -> Result<Option<GlobSet>, String> {
    let parts: Vec<&str> = patterns.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for p in parts {
        builder.add(Glob::new(p).map_err(|e| e.to_string())?);
    }
    builder.build().map(Some).map_err(|e| e.to_string())
}

/// `None` when the file cannot be stat-ed, which leaves it without a digest and
/// so unreplaceable: the replace guard has nothing to compare against and must
/// skip it, which is the fail-closed direction.
fn digest_of(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    let mut hasher = DefaultHasher::new();
    (meta.len(), mtime.as_secs(), mtime.subsec_nanos()).hash(&mut hasher);
    Some(format!("{:016x}", hasher.finish()))
}

/// Parse one ripgrep `--json` stream into candidate lines. rg's own submatches
/// are ignored on purpose; the canonical regex derives them later so every
/// backend produces the same offsets.
fn parse_rg_json(stdout: &[u8]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }
        let data = &v["data"];
        let Some(path) = data["path"]["text"].as_str() else {
            continue;
        };
        // rg is run from inside `root` against `.`, so paths arrive relative
        // with a `./` prefix, the same shape `plain_grep` produces.
        let rel = path.strip_prefix("./").unwrap_or(path).to_string();
        let line_no = data["line_number"].as_u64().unwrap_or(0) as u32;
        let text = normalise_line(data["lines"]["text"].as_str().unwrap_or("")).to_string();
        out.push(Candidate { path: rel, line: line_no, text });
    }
    out
}

/// Parse `grep -n`/`git grep -n` output (`path:line:text`, path already
/// relative). Splits on only the first two `:` so match text containing `:`
/// (`const x: number`) survives.
fn parse_grep_lines(stdout: &[u8]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        let mut parts = line.splitn(3, ':');
        let (Some(path), Some(line_no), Some(text)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(line_no) = line_no.parse::<u32>() else {
            continue;
        };
        let path = path.strip_prefix("./").unwrap_or(path).to_string();
        out.push(Candidate { path, line: line_no, text: normalise_line(text).to_string() });
    }
    out
}

/// The single place a candidate becomes a result: the canonical regex confirms
/// the match and produces its offsets, the globs decide whether the file counts,
/// and only then does the cap apply. Capping earlier would let a broad
/// pre-filter fill the budget with lines that do not match, leaving the panel
/// showing twenty results under a "500+" banner.
fn finalize(
    candidates: Vec<Candidate>,
    re: &Regex,
    include: Option<&GlobSet>,
    exclude: Option<&GlobSet>,
    max: usize,
) -> (Vec<SearchMatch>, bool) {
    let mut matches = Vec::new();
    let mut truncated = false;
    for c in candidates {
        if let Some(inc) = include {
            if !inc.is_match(&c.path) {
                continue;
            }
        }
        if let Some(exc) = exclude {
            if exc.is_match(&c.path) {
                continue;
            }
        }
        let submatches = submatches_utf16(re, &c.text);
        if submatches.is_empty() {
            continue;
        }
        if matches.len() >= max {
            truncated = true;
            break;
        }
        matches.push(SearchMatch { path: c.path, line: c.line, text: c.text, submatches });
    }
    (matches, truncated)
}

/// Digest every distinct file the results touch, so a later replace can tell
/// whether the file still looks the way it did when it was searched.
fn digests_for(root: &str, matches: &[SearchMatch]) -> Vec<FileDigest> {
    let mut seen = std::collections::HashSet::new();
    let mut order: Vec<String> = Vec::new();
    for m in matches {
        if seen.insert(m.path.as_str()) {
            order.push(m.path.clone());
        }
    }
    order.into_iter()
        .filter_map(|p| {
            digest_of(&Path::new(root).join(&p)).map(|digest| FileDigest { path: p, digest })
        })
        .collect()
}

/// Which backend will run, and which options it cannot honour. Split out from
/// the command so the plain path stays testable on a machine that has rg.
fn pick_backend(root: &str, use_rg: bool) -> (&'static str, Vec<String>) {
    if use_rg {
        ("rg", Vec::new())
    } else if is_git_repo(root) {
        ("git", Vec::new())
    } else {
        // No rg and no repo means no ignore rules exist to switch off.
        ("plain", vec!["noIgnore".to_string()])
    }
}

fn run_rg(
    root: &str,
    pattern: &str,
    opts: &SearchOptions,
    max: usize,
) -> Result<Vec<Candidate>, String> {
    let mut cmd = Command::new("rg");
    cmd.args(["--json", "--line-number"]);
    // A coarse bound on how much JSON a single pathological file can emit.
    // `--max-count` is per file, not global, so it is not the result cap; it is
    // `max + 1` so a file that alone overflows the cap still yields the one
    // extra candidate `finalize` needs to report the result as truncated.
    cmd.arg("--max-count").arg(max.saturating_add(1).to_string());
    // The canonical pattern carries its own `(?i)` and `\b` wrapping, so rg is
    // never given `-i`, `-w` or `-F`: those are a second matcher, and a second
    // matcher is exactly what this module refuses to have.
    if opts.no_ignore {
        cmd.arg("--no-ignore");
    }
    for g in opts.include.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        cmd.arg("--glob").arg(g);
    }
    for g in opts.exclude.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        cmd.arg("--glob").arg(format!("!{g}"));
    }
    // Searched as `.` from inside `root`, never as an absolute path: rg matches
    // `--glob` against the candidate path as it appears, so an anchored glob
    // like `src/**/*.ts` matches nothing when the root is passed absolutely.
    cmd.arg("-e").arg(pattern).arg(".");
    cmd.current_dir(root);
    let out = cmd.output().map_err(|e| e.to_string())?;
    // rg exits 1 for "no matches", which is not an error here.
    if out.status.success() || out.status.code() == Some(1) {
        return Ok(parse_rg_json(&out.stdout));
    }
    Err(String::from_utf8_lossy(&out.stderr).into_owned())
}

fn run_git_grep(
    root: &str,
    literal: Option<&str>,
    opts: &SearchOptions,
) -> Result<Vec<Candidate>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root);
    cmd.args(["grep", "-n", "--untracked"]);
    // `--no-exclude-standard` is what reaches ignored files. Merely dropping
    // `--exclude-standard` does nothing: git honours .gitignore by default
    // under `--untracked`, so the opt-out has to be asked for explicitly.
    if opts.no_ignore {
        cmd.arg("--no-exclude-standard");
    } else {
        cmd.arg("--exclude-standard");
    }
    if !opts.case {
        cmd.arg("-i");
    }
    // `-F` with an empty pattern matches every line, which is the honest
    // fallback when the regex has no literal that must appear.
    cmd.arg("-F").arg("-e").arg(literal.unwrap_or(""));
    let out = cmd.output().map_err(|e| e.to_string())?;
    // git grep exits 1 for "no matches", which is not an error here.
    if out.status.success() || out.status.code() == Some(1) {
        return Ok(parse_grep_lines(&out.stdout));
    }
    Err(String::from_utf8_lossy(&out.stderr).into_owned())
}

/// Plain recursive `grep -rn`, excluding the same churn dirs the file tree walk
/// skips. Used only when neither `rg` nor a git repo is available.
///
/// This path has no gitignore awareness of any kind, only the hard-coded
/// `IGNORED_DIRS` list, so the `no_ignore` option is meaningless here. That is
/// reported to the UI as an unsupported option rather than left to look like a
/// working toggle.
fn plain_grep(
    root: &str,
    literal: Option<&str>,
    opts: &SearchOptions,
) -> Result<Vec<Candidate>, String> {
    let mut cmd = Command::new("grep");
    cmd.arg("-rn");
    if !opts.case {
        cmd.arg("-i");
    }
    for dir in IGNORED_DIRS {
        cmd.arg(format!("--exclude-dir={dir}"));
    }
    // grep's exclude is by basename only, so the Feature worktree dir is
    // excluded just when the root actually has one, not every `worktrees/`.
    let (sway, worktrees) = crate::fs::FEATURE_WORKTREES;
    if Path::new(root).join(sway).join(worktrees).is_dir() {
        cmd.arg(format!("--exclude-dir={worktrees}"));
    }
    cmd.arg("-F").arg("-e").arg(literal.unwrap_or("")).arg(".");
    cmd.current_dir(root);
    let out = cmd.output().map_err(|e| e.to_string())?;
    // grep exits 1 for "no matches", which is not an error here.
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(parse_grep_lines(&out.stdout))
}

/// Search `root` for `query` under `options`, capping at `max` matching lines.
#[tauri::command(async)]
pub fn grep_project(
    root: String,
    query: String,
    options: SearchOptions,
    max: usize,
) -> Result<SearchResult, String> {
    let use_rg = has_rg();
    let (backend, unsupported) = pick_backend(&root, use_rg);

    let empty = |matches: Vec<SearchMatch>, truncated: bool, files: Vec<FileDigest>| SearchResult {
        matches,
        truncated,
        backend: backend.to_string(),
        unsupported: unsupported.clone(),
        files,
    };

    if query.is_empty() {
        return Ok(empty(Vec::new(), false, Vec::new()));
    }

    let re = build_regex(&query, &options)?;
    let include = build_globs(&options.include)?;
    let exclude = build_globs(&options.exclude)?;

    let candidates = if use_rg {
        run_rg(&root, &canonical_pattern(&query, &options), &options, max)?
    } else {
        let literal = longest_literal(&query, &options);
        if backend == "git" {
            run_git_grep(&root, literal.as_deref(), &options)?
        } else {
            plain_grep(&root, literal.as_deref(), &options)?
        }
    };

    let (matches, truncated) = finalize(candidates, &re, include.as_ref(), exclude.as_ref(), max);
    let files = digests_for(&root, &matches);
    Ok(empty(matches, truncated, files))
}

// --- replace ---
//
// Replace reuses the search matcher rather than re-deriving one: the same
// `canonical_pattern` compiles the same `Regex`, so a span the panel is showing
// and the span this writes at are the same span by construction. That is the
// whole reason rg was demoted to a candidate finder in the first place.

/// One match to replace, addressed the way the panel received it: a 1-based
/// line number plus UTF-16 offsets into that line's text.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSpan {
    pub line: u32,
    pub start: u32,
    pub end: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: String,
    /// The digest this file carried when it was searched. A file that no longer
    /// matches is skipped whole rather than edited at offsets that have moved.
    pub digest: String,
    pub matches: Vec<ReplaceSpan>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub changed: Vec<String>,
    pub skipped: Vec<SkippedFile>,
    pub occurrences: u32,
}

/// One line the panel is displaying, for previewing what a replacement produces.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSpan {
    pub text: String,
    pub start: u32,
    pub end: u32,
}

/// Byte offset within `text` of a UTF-16 code-unit offset. `None` when the
/// offset does not land on a character boundary, which means the caller's
/// offsets do not describe this string.
fn utf16_to_byte(text: &str, offset: u32) -> Option<usize> {
    let mut seen = 0u32;
    for (i, ch) in text.char_indices() {
        if seen == offset {
            return Some(i);
        }
        seen += ch.len_utf16() as u32;
    }
    if seen == offset {
        Some(text.len())
    } else {
        None
    }
}

/// Byte ranges of each line, excluding its terminator, indexed from 0. A file
/// ending in a newline yields no trailing empty line, since no 1-based line
/// number from grep or rg addresses one.
fn line_spans(content: &str) -> Vec<(usize, usize)> {
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            let mut end = i;
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            out.push((start, end));
            start = i + 1;
        }
    }
    if start < bytes.len() {
        out.push((start, bytes.len()));
    }
    out
}

/// Expand `replacement` for the match sitting at exactly `[start, end)` (byte
/// offsets) in `line`. `None` when no match sits there, which is the signal that
/// the caller's span does not describe this line any more.
///
/// Going through `Captures::expand` is what makes `$1` and `${name}` work, and
/// it is also why the span has to be re-found rather than trusted: the captures
/// only exist as a by-product of matching.
fn expand_at(re: &Regex, line: &str, start: usize, end: usize, replacement: &str) -> Option<String> {
    let caps = re.captures_at(line, start)?;
    let m = caps.get(0)?;
    if m.start() != start || m.end() != end {
        return None;
    }
    let mut out = String::new();
    caps.expand(replacement, &mut out);
    Some(out)
}

/// What a replacement produces for each displayed span, without touching disk.
/// Computed in Rust because the expansion has to come from the same regex
/// engine that will perform the write; JavaScript's `RegExp` is a different
/// dialect and could show a preview the write would not reproduce.
///
/// A span that no longer verifies yields `null` rather than a guess.
#[tauri::command(async)]
pub fn preview_replace(
    query: String,
    options: SearchOptions,
    replacement: String,
    spans: Vec<PreviewSpan>,
) -> Result<Vec<Option<String>>, String> {
    let re = build_regex(&query, &options)?;
    Ok(spans
        .into_iter()
        .map(|s| {
            let start = utf16_to_byte(&s.text, s.start)?;
            let end = utf16_to_byte(&s.text, s.end)?;
            expand_at(&re, &s.text, start, end, &replacement)
        })
        .collect())
}

/// Apply `replacement` to the given spans, file by file.
///
/// Fail-closed at every step: a path outside `root` is refused, a file whose
/// digest has moved is skipped whole, and a span that no longer verifies skips
/// its file rather than writing at an offset nobody agrees on. Edits are applied
/// to the original bytes back to front, so earlier offsets stay valid and the
/// file's line endings and final-newline state are whatever they already were.
#[tauri::command(async)]
pub fn replace_in_files(
    root: String,
    query: String,
    options: SearchOptions,
    replacement: String,
    targets: Vec<ReplaceTarget>,
) -> Result<ReplaceResult, String> {
    let re = build_regex(&query, &options)?;
    let mut changed = Vec::new();
    let mut skipped = Vec::new();
    let mut occurrences = 0u32;

    for target in targets {
        let abs = Path::new(&root).join(&target.path);
        let abs_str = abs.to_string_lossy().into_owned();
        let mut skip = |reason: &str| {
            skipped.push(SkippedFile { path: target.path.clone(), reason: reason.to_string() });
        };

        if let Err(e) = crate::fs::ensure_inside_named(&root, &abs_str, "project folder") {
            skip(&e);
            continue;
        }
        // An absent digest is not a pass: without one there is nothing to
        // compare, so the file cannot be shown to be the one that was searched.
        match digest_of(&abs) {
            Some(d) if d == target.digest => {}
            Some(_) => {
                skip("changed on disk");
                continue;
            }
            None => {
                skip("unreadable");
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(&abs) else {
            skip("not a text file");
            continue;
        };

        let lines = line_spans(&content);
        let mut edits: Vec<(usize, usize, String)> = Vec::new();
        let mut bad = false;
        for span in &target.matches {
            let Some(&(ls, le)) = lines.get(span.line.saturating_sub(1) as usize) else {
                bad = true;
                break;
            };
            let text = &content[ls..le];
            let (Some(bs), Some(be)) = (utf16_to_byte(text, span.start), utf16_to_byte(text, span.end))
            else {
                bad = true;
                break;
            };
            let Some(new) = expand_at(&re, text, bs, be, &replacement) else {
                bad = true;
                break;
            };
            edits.push((ls + bs, ls + be, new));
        }
        if bad {
            skip("no longer matches");
            continue;
        }
        if edits.is_empty() {
            continue;
        }

        // Overlapping spans cannot be applied as independent edits. The panel
        // derives spans from `find_iter`, which never overlaps, but this command
        // is reachable with arbitrary targets and every other guard here is
        // fail-closed.
        edits.sort_by_key(|e| e.0);
        if edits.windows(2).any(|w| w[0].1 > w[1].0) {
            skip("overlapping matches");
            continue;
        }

        // Applied back to front, so an earlier edit never shifts a later one's
        // offsets. Written through the atomic shape rather than a truncating
        // `fs::write`: a replace spans many files and has no undo, so a crash
        // mid-write must not be able to leave a source file short.
        let mut text = content;
        for (s, e, new) in edits.iter().rev() {
            text.replace_range(*s..*e, new);
        }
        if let Err(e) = crate::owned_state::write_atomically(&abs, &text) {
            skip(&e);
            continue;
        }
        occurrences += edits.len() as u32;
        changed.push(target.path.clone());
    }

    Ok(ReplaceResult { changed, skipped, occurrences })
}

// --- write-back from the editable results buffer ---
//
// The results buffer edits whole **lines**, not spans: a line is what a result
// row shows, and the map from a row back to its source is a line number. So an
// edit carries the line it means to rewrite *and the text it saw there*, and a
// file whose line no longer reads that way is refused whole rather than written
// at a number that has since moved.
//
// The guard is the line's own text rather than `replace_in_files`' file digest,
// and deliberately so. A results buffer is edited over minutes, not in the
// instant after a search; something else touching an unrelated region of a
// matched file is ordinary, and refusing every file for it would make the
// buffer unusable on a repo with an agent running in it. Comparing the line
// answers the question that actually matters, which is whether *this* edit
// still lands where it was aimed.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEdit {
    /// 1-based, as the search reported it.
    pub line: u32,
    /// The line's text as the buffer received it, without its terminator.
    pub was: String,
    pub now: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEdits {
    /// Root-relative, the way a `SearchMatch` names its file.
    pub path: String,
    pub edits: Vec<LineEdit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub changed: Vec<String>,
    pub skipped: Vec<SkippedFile>,
}

/// Rewrite whole lines, file by file. Fail-closed per file: a path outside
/// `root`, a line that is gone, a line whose text has moved, or an edit that
/// would add a line skips that file entirely and reports why. Every other file
/// in the batch still lands, which is what makes a mixed outcome retryable.
#[tauri::command(async)]
pub fn apply_line_edits(root: String, files: Vec<FileEdits>) -> Result<ApplyResult, String> {
    let mut changed = Vec::new();
    let mut skipped = Vec::new();

    for file in files {
        let abs = Path::new(&root).join(&file.path);
        let abs_str = abs.to_string_lossy().into_owned();
        let mut skip = |reason: &str| {
            skipped.push(SkippedFile { path: file.path.clone(), reason: reason.to_string() });
        };

        if let Err(e) = crate::fs::ensure_inside_named(&root, &abs_str, "project folder") {
            skip(&e);
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&abs) else {
            skip("unreadable");
            continue;
        };

        let lines = line_spans(&content);
        let mut edits: Vec<(usize, usize, &str)> = Vec::new();
        let mut seen: Vec<u32> = Vec::new();
        let mut refused: Option<&str> = None;
        for e in &file.edits {
            // A line count that changed under the map is the one failure the
            // buffer cannot describe, so it is refused at both ends: the buffer
            // will not let a line be split, and this will not write one that is.
            if e.now.contains('\n') || e.now.contains('\r') {
                refused = Some("an edit would add a line");
                break;
            }
            // Two rewrites of one line would apply in whichever order they
            // arrived and silently keep the last. The buffer has one row per
            // line and cannot produce it; this command is reachable anyway.
            if seen.contains(&e.line) {
                refused = Some("two edits on one line");
                break;
            }
            seen.push(e.line);
            let Some(&(ls, le)) = lines.get(e.line.saturating_sub(1) as usize) else {
                refused = Some("changed since the search");
                break;
            };
            if &content[ls..le] != e.was {
                refused = Some("changed since the search");
                break;
            }
            edits.push((ls, le, e.now.as_str()));
        }
        if let Some(reason) = refused {
            skip(reason);
            continue;
        }
        if edits.is_empty() {
            continue;
        }

        // Back to front, so an earlier rewrite never shifts a later one's
        // offsets, and through the atomic shape for the same reason a replace
        // uses it: this spans many files and has no undo, so a crash mid-write
        // must not be able to leave a source file short.
        edits.sort_by_key(|e| e.0);
        let mut text = content;
        for (s, e, new) in edits.iter().rev() {
            text.replace_range(*s..*e, new);
        }
        if let Err(e) = crate::owned_state::write_atomically(&abs, &text) {
            skip(&e);
            continue;
        }
        changed.push(file.path.clone());
    }

    Ok(ApplyResult { changed, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@test.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@test.com")
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sway_search_test_{name}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = temp_dir(name);
        git(&dir, &["init", "-q"]);
        dir
    }

    fn opts() -> SearchOptions {
        SearchOptions { case: true, ..Default::default() }
    }

    // --- the canonical matcher ---

    #[test]
    fn canonical_pattern_covers_literal_word_and_case() {
        let base = SearchOptions::default();

        // Literal mode escapes, regex mode does not.
        assert_eq!(canonical_pattern("a.b", &SearchOptions { case: true, ..base.clone() }), "a\\.b");
        assert_eq!(
            canonical_pattern("a.b", &SearchOptions { case: true, regex: true, ..base.clone() }),
            "a.b"
        );
        // Whole word wraps the whole pattern, so an alternation stays grouped.
        assert_eq!(
            canonical_pattern(
                "a|b",
                &SearchOptions { case: true, regex: true, whole_word: true, ..base.clone() }
            ),
            "\\b(?:a|b)\\b"
        );
        // Case-insensitivity is an inline flag, so no backend needs its own -i.
        assert_eq!(canonical_pattern("x", &SearchOptions { ..base.clone() }), "(?i)x");
        assert_eq!(
            canonical_pattern("x", &SearchOptions { whole_word: true, ..base }),
            "(?i)\\b(?:x)\\b"
        );
    }

    #[test]
    fn build_regex_returns_err_for_an_unclosed_class() {
        let err = build_regex("[", &SearchOptions { case: true, regex: true, ..Default::default() });
        assert!(err.is_err(), "an unclosed character class must not compile");
        // Literal mode escapes it, so the same query is fine there.
        assert!(build_regex("[", &opts()).is_ok());
    }

    #[test]
    fn regex_and_literal_modes_honour_case_and_word() {
        let ci = build_regex("foo", &SearchOptions::default()).unwrap();
        assert!(ci.is_match("FOO"));
        let cs = build_regex("foo", &opts()).unwrap();
        assert!(!cs.is_match("FOO"));

        let word = build_regex("foo", &SearchOptions { case: true, whole_word: true, ..Default::default() })
            .unwrap();
        assert!(word.is_match("a foo b"));
        assert!(!word.is_match("foobar"));
    }

    // --- rg is a candidate finder, not a second matcher ---

    #[test]
    fn whole_word_agrees_across_backends_and_does_not_inherit_rg_semantics() {
        // `rg -w` matches `.env` and `+foo`; `\b(?:pat)\b` matches neither.
        // Both backends must land on the canonical regex's answer, not rg's.
        let dir = temp_dir("wordparity");
        std::fs::write(dir.join("a.txt"), ".env value\n+foo bar\nplain foo here\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        // `foo` matches twice: `+` is a non-word character, so `+foo` carries a
        // word boundary even though the pattern `+foo` itself does not.
        for (query, expected) in [(".env", 0usize), ("+foo", 0), ("foo", 2)] {
            let o = SearchOptions { case: true, whole_word: true, ..Default::default() };
            let re = build_regex(query, &o).unwrap();
            let literal = longest_literal(query, &o);

            let (from_plain, _) = finalize(
                plain_grep(&root, literal.as_deref(), &o).unwrap(),
                &re,
                None,
                None,
                100,
            );
            assert_eq!(
                from_plain.len(),
                expected,
                "{query}: plain grep path disagreed with the canonical regex"
            );

            if has_rg() {
                let (from_rg, _) = finalize(
                    run_rg(&root, &canonical_pattern(query, &o), &o, 100).unwrap(),
                    &re,
                    None,
                    None,
                    100,
                );
                let a: Vec<_> = from_rg.iter().map(|m| (m.line, m.submatches.clone())).collect();
                let b: Vec<_> = from_plain.iter().map(|m| (m.line, m.submatches.clone())).collect();
                assert_eq!(a, b, "{query}: rg and the fallback returned different match sets");
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn word_boundary_still_matches_a_plain_identifier() {
        let o = SearchOptions { case: true, whole_word: true, ..Default::default() };
        let re = build_regex("foo", &o).unwrap();
        let candidates =
            vec![Candidate { path: "a.txt".into(), line: 1, text: "call foo(1)".into() }];
        let (matches, _) = finalize(candidates, &re, None, None, 10);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].submatches, vec![(5, 8)]);
    }

    // --- offsets ---

    #[test]
    fn submatches_are_utf16_offsets_not_bytes() {
        let re = build_regex("needle", &opts()).unwrap();
        // "café " is 6 bytes but 5 UTF-16 code units; rg would report 6 here.
        let spans = submatches_utf16(&re, "café needle here");
        assert_eq!(spans, vec![(5, 11)]);
    }

    #[test]
    fn submatches_reports_every_occurrence_on_a_line() {
        let re = build_regex("ab", &opts()).unwrap();
        assert_eq!(submatches_utf16(&re, "ab cd ab"), vec![(0, 2), (6, 8)]);
    }

    #[test]
    fn zero_width_matches_are_dropped() {
        let re = build_regex("x*", &SearchOptions { case: true, regex: true, ..Default::default() })
            .unwrap();
        assert!(submatches_utf16(&re, "no ex here").iter().all(|(s, e)| e > s));
    }

    // --- glob anchoring, the rg-vs-globset agreement ---

    fn glob_fixture(name: &str) -> std::path::PathBuf {
        let dir = temp_dir(name);
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        for p in ["src/a.ts", "src/deep/b.ts", "src/c.test.ts", "vendor/d.ts", "top.ts"] {
            std::fs::write(dir.join(p), "needle here\n").unwrap();
        }
        dir
    }

    #[test]
    fn rg_and_globset_agree_on_the_same_globs() {
        if !has_rg() {
            eprintln!("skipping: rg not installed");
            return;
        }
        let dir = glob_fixture("globs");
        let root = dir.to_string_lossy().into_owned();

        for (include, exclude) in
            [("src/**/*.ts", ""), ("**/*.test.ts", ""), ("", "vendor/**"), ("src/**", "**/deep/**")]
        {
            let o = SearchOptions {
                case: true,
                include: include.to_string(),
                exclude: exclude.to_string(),
                ..Default::default()
            };
            let re = build_regex("needle", &o).unwrap();
            let inc = build_globs(&o.include).unwrap();
            let exc = build_globs(&o.exclude).unwrap();

            // rg filtering natively, then globset filtering the same candidates.
            let rg_filtered = run_rg(&root, &canonical_pattern("needle", &o), &o, 100).unwrap();
            let (from_rg, _) = finalize(rg_filtered, &re, inc.as_ref(), exc.as_ref(), 100);

            // The same tree with no native filtering, filtered by globset alone.
            let bare = SearchOptions { case: true, ..Default::default() };
            let unfiltered = run_rg(&root, &canonical_pattern("needle", &bare), &bare, 100).unwrap();
            let (from_globset, _) = finalize(unfiltered, &re, inc.as_ref(), exc.as_ref(), 100);

            let mut a: Vec<_> = from_rg.iter().map(|m| m.path.clone()).collect();
            let mut b: Vec<_> = from_globset.iter().map(|m| m.path.clone()).collect();
            a.sort();
            b.sort();
            assert_eq!(a, b, "rg and globset disagreed on include={include:?} exclude={exclude:?}");
            assert!(!a.is_empty(), "fixture produced no matches for include={include:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_anchored_glob_matches_when_rg_runs_from_inside_root() {
        if !has_rg() {
            eprintln!("skipping: rg not installed");
            return;
        }
        let dir = glob_fixture("anchored");
        let root = dir.to_string_lossy().into_owned();
        let o = SearchOptions { case: true, include: "src/**".to_string(), ..Default::default() };

        // The regression this guards: with an absolute path as rg's search
        // target, `src/**` matches nothing at all.
        let candidates = run_rg(&root, &canonical_pattern("needle", &o), &o, 100).unwrap();
        assert!(!candidates.is_empty(), "anchored glob matched nothing");
        assert!(
            candidates.iter().all(|c| !c.path.starts_with("./") && !c.path.starts_with('/')),
            "paths must come back root-relative"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // --- the literal pre-filter ---

    #[test]
    fn longest_literal_picks_the_longest_required_run() {
        let rx = SearchOptions { case: true, regex: true, ..Default::default() };
        assert_eq!(longest_literal("foo.*barbaz", &rx).as_deref(), Some("barbaz"));
        assert_eq!(longest_literal(r"\d+items", &rx).as_deref(), Some("items"));
        // A trailing `?`/`*` makes the preceding character optional.
        assert_eq!(longest_literal("colou?r", &rx).as_deref(), Some("colo"));
        // `+` keeps its character: `x+` still requires one `x`.
        assert_eq!(longest_literal("ab+", &rx).as_deref(), Some("ab"));
        // Literal mode takes the whole query verbatim.
        assert_eq!(longest_literal("a.b*c", &opts()).as_deref(), Some("a.b*c"));
    }

    #[test]
    fn longest_literal_bails_on_alternation_and_groups() {
        let rx = SearchOptions { case: true, regex: true, ..Default::default() };
        // "foo" is not required: a line matching "bar" would be pre-filtered away.
        assert_eq!(longest_literal("foo|bar", &rx), None);
        assert_eq!(longest_literal("(abc)?def", &rx), None);
        assert_eq!(longest_literal("[a-z]+", &rx), None);
        assert_eq!(longest_literal(r"\d+", &rx), None);
    }

    #[test]
    fn a_pattern_with_no_literal_still_finds_its_matches() {
        let dir = temp_dir("noliteral");
        std::fs::write(dir.join("a.txt"), "value 4321 here\nno digits\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = SearchOptions { case: true, regex: true, ..Default::default() };

        // No literal run, so grep is handed an empty -F pattern (every line)
        // and the canonical regex does the actual selecting.
        assert_eq!(longest_literal(r"\d\d\d\d", &o), None);
        let candidates = plain_grep(&root, None, &o).unwrap();
        assert!(candidates.len() >= 2, "the empty pre-filter must yield every line");

        let re = build_regex(r"\d\d\d\d", &o).unwrap();
        let (matches, _) = finalize(candidates, &re, None, None, 100);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].text, "value 4321 here");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // --- cap after verification ---

    #[test]
    fn the_cap_counts_verified_matches_not_candidates() {
        let re = build_regex("needle", &opts()).unwrap();
        // 600 candidates, only 20 of which actually match.
        let candidates: Vec<Candidate> = (0..600)
            .map(|i| Candidate {
                path: format!("f{i}.txt"),
                line: 1,
                text: if i < 20 { "needle here".into() } else { "chaff".into() },
            })
            .collect();
        let (matches, truncated) = finalize(candidates, &re, None, None, 500);
        assert_eq!(matches.len(), 20);
        assert!(!truncated, "a cap counted against candidates would have tripped here");
    }

    #[test]
    fn the_cap_still_truncates_on_genuine_overflow() {
        let re = build_regex("needle", &opts()).unwrap();
        let candidates: Vec<Candidate> = (0..10)
            .map(|i| Candidate { path: format!("f{i}.txt"), line: 1, text: "needle".into() })
            .collect();
        let (matches, truncated) = finalize(candidates, &re, None, None, 3);
        assert_eq!(matches.len(), 3);
        assert!(truncated);
    }

    // --- parsers ---

    #[test]
    fn parse_rg_json_extracts_matches_and_relativizes_path() {
        let stdout = format!(
            "{}\n{}\n",
            r#"{"type":"begin","data":{"path":{"text":"./src/a.ts"}}}"#,
            r#"{"type":"match","data":{"path":{"text":"./src/a.ts"},"lines":{"text":"needle here\n"},"line_number":42}}"#,
        );
        let candidates = parse_rg_json(stdout.as_bytes());
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, "src/a.ts");
        assert_eq!(candidates[0].line, 42);
        assert_eq!(candidates[0].text, "needle here");
    }

    #[test]
    fn parse_grep_lines_preserves_colons_in_match_text() {
        let candidates = parse_grep_lines(b"src/a.ts:10:const x: number = 1;\n");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, "src/a.ts");
        assert_eq!(candidates[0].line, 10);
        assert_eq!(candidates[0].text, "const x: number = 1;");
    }

    #[test]
    fn crlf_and_lf_produce_identical_text_and_offsets() {
        let rg_lf = parse_rg_json(
            br#"{"type":"match","data":{"path":{"text":"./a.ts"},"lines":{"text":"let x = 1;\n"},"line_number":1}}"#,
        );
        let rg_crlf = parse_rg_json(
            br#"{"type":"match","data":{"path":{"text":"./a.ts"},"lines":{"text":"let x = 1;\r\n"},"line_number":1}}"#,
        );
        assert_eq!(rg_lf[0].text, "let x = 1;");
        assert_eq!(rg_crlf[0].text, rg_lf[0].text);

        let grep_crlf = parse_grep_lines(b"a.ts:1:let x = 1;\r\n");
        assert_eq!(grep_crlf[0].text, rg_lf[0].text);

        let re = build_regex("x", &opts()).unwrap();
        assert_eq!(submatches_utf16(&re, &rg_crlf[0].text), submatches_utf16(&re, &rg_lf[0].text));
    }

    #[test]
    fn trailing_whitespace_survives_normalisation() {
        // A match can end in spaces, so trimming them would push the span past
        // the end of the rendered text.
        let candidates = parse_grep_lines(b"a.ts:1:let x = 1;   \n");
        assert_eq!(candidates[0].text, "let x = 1;   ");
        let re = build_regex(r";\s+$", &SearchOptions { case: true, regex: true, ..Default::default() })
            .unwrap();
        let spans = submatches_utf16(&re, &candidates[0].text);
        assert_eq!(spans, vec![(9, 13)]);
        assert!(spans[0].1 as usize <= candidates[0].text.encode_utf16().count());
    }

    // --- backends ---

    #[test]
    fn git_grep_fallback_finds_untracked_file() {
        let dir = temp_repo("untracked");
        std::fs::write(dir.join("tracked.txt"), "needle in tracked\n").unwrap();
        git(&dir, &["add", "tracked.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("scratch.txt"), "needle in untracked\n").unwrap();

        let root = dir.to_string_lossy().into_owned();
        let candidates = run_git_grep(&root, Some("needle"), &opts()).unwrap();
        let paths: Vec<_> = candidates.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"tracked.txt"));
        assert!(paths.contains(&"scratch.txt"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn git_grep_reaches_ignored_files_only_with_no_ignore() {
        let dir = temp_repo("ignored");
        std::fs::write(dir.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.join("ignored.txt"), "needle in ignored\n").unwrap();
        std::fs::write(dir.join("kept.txt"), "needle in kept\n").unwrap();
        git(&dir, &["add", ".gitignore", "kept.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        let root = dir.to_string_lossy().into_owned();

        let respecting = run_git_grep(&root, Some("needle"), &opts()).unwrap();
        let paths: Vec<_> = respecting.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"kept.txt"));
        assert!(!paths.contains(&"ignored.txt"));

        let ignoring =
            run_git_grep(&root, Some("needle"), &SearchOptions { case: true, no_ignore: true, ..Default::default() })
                .unwrap();
        let paths: Vec<_> = ignoring.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"kept.txt"));
        assert!(paths.contains(&"ignored.txt"), "no_ignore must reach gitignored files");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn plain_grep_excludes_churn_dirs_and_strips_the_dot_prefix() {
        let dir = temp_dir("plain");
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules/dep.txt"), "needle in dep\n").unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.txt")), "needle here\n").unwrap();
        }
        let root = dir.to_string_lossy().into_owned();

        let candidates = plain_grep(&root, Some("needle"), &opts()).unwrap();
        assert_eq!(candidates.len(), 5);
        assert!(!candidates.iter().any(|c| c.path.contains("node_modules")));
        assert!(!candidates.iter().any(|c| c.path.starts_with("./")));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn plain_grep_excludes_feature_worktrees_only_when_the_root_has_them() {
        let dir = temp_dir("featwt");
        std::fs::create_dir_all(dir.join("worktrees")).unwrap();
        std::fs::write(dir.join("worktrees/plain.txt"), "needle in a plain dir\n").unwrap();
        std::fs::write(dir.join("f.txt"), "needle here\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        // No `.sway/worktrees`: an unrelated `worktrees/` folder is searched.
        assert_eq!(plain_grep(&root, Some("needle"), &opts()).unwrap().len(), 2);

        std::fs::create_dir_all(dir.join(".sway/worktrees/x")).unwrap();
        std::fs::write(dir.join(".sway/worktrees/x/a.txt"), "needle in a feature worktree\n").unwrap();
        let candidates = plain_grep(&root, Some("needle"), &opts()).unwrap();
        assert!(!candidates.iter().any(|c| c.path.contains(".sway/worktrees")));
        assert_eq!(candidates.len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    // --- capability reporting and digests ---

    #[test]
    fn a_non_git_folder_without_rg_declares_no_ignore_unsupported() {
        let dir = temp_dir("caps");
        let root = dir.to_string_lossy().into_owned();
        assert!(!is_git_repo(&root), "fixture must not be a repo");

        // `use_rg` is passed in rather than probed, so the plain path is
        // reachable on a machine that does have rg installed.
        let (backend, unsupported) = pick_backend(&root, false);
        assert_eq!(backend, "plain");
        assert_eq!(unsupported, vec!["noIgnore".to_string()]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn backends_that_can_honour_every_option_declare_nothing_unsupported() {
        let dir = temp_repo("caps_git");
        let root = dir.to_string_lossy().into_owned();

        let (backend, unsupported) = pick_backend(&root, false);
        assert_eq!(backend, "git", "a repo without rg must fall to git grep");
        assert!(unsupported.is_empty(), "git grep honours no_ignore via --no-exclude-standard");

        let (backend, unsupported) = pick_backend(&root, true);
        assert_eq!(backend, "rg");
        assert!(unsupported.is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_digest_is_stable_until_the_file_changes() {
        let dir = temp_dir("digest");
        let file = dir.join("a.txt");
        std::fs::write(&file, "needle here\n").unwrap();

        let first = digest_of(&file).unwrap();
        assert_eq!(first, digest_of(&file).unwrap(), "an untouched file must digest the same");

        // A length change, which size alone would catch.
        std::fs::write(&file, "needle here\nand more\n").unwrap();
        let second = digest_of(&file).unwrap();
        assert_ne!(first, second, "a changed file must digest differently");

        // A same-length change, which only the mtime half can catch.
        std::fs::write(&file, "needle here\nAND MORE\n").unwrap();
        let third = digest_of(&file).unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().len(),
            "needle here\nand more\n".len() as u64,
            "fixture must be the same length for this to test mtime"
        );
        assert_ne!(second, third, "a same-length edit must still change the digest");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_single_file_overflowing_the_cap_still_reports_truncated() {
        if !has_rg() {
            eprintln!("skipping: rg not installed");
            return;
        }
        // rg's `--max-count` is per file, so a lone file holding more matches
        // than the cap is the case that would silently look complete if the
        // per-file bound were exactly `max` rather than `max + 1`.
        let dir = temp_dir("onefileoverflow");
        let body = "needle\n".repeat(10);
        std::fs::write(dir.join("a.txt"), body).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = opts();

        let candidates = run_rg(&root, &canonical_pattern("needle", &o), &o, 3).unwrap();
        let re = build_regex("needle", &o).unwrap();
        let (matches, truncated) = finalize(candidates, &re, None, None, 3);
        assert_eq!(matches.len(), 3);
        assert!(truncated, "one file overflowing the cap must still report truncated");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn digests_cover_each_matched_file_once() {
        let dir = temp_dir("digests");
        std::fs::write(dir.join("a.txt"), "needle\nneedle\n").unwrap();
        std::fs::write(dir.join("b.txt"), "needle\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let matches = vec![
            SearchMatch { path: "a.txt".into(), line: 1, text: "needle".into(), submatches: vec![(0, 6)] },
            SearchMatch { path: "a.txt".into(), line: 2, text: "needle".into(), submatches: vec![(0, 6)] },
            SearchMatch { path: "b.txt".into(), line: 1, text: "needle".into(), submatches: vec![(0, 6)] },
        ];
        let files = digests_for(&root, &matches);
        assert_eq!(files.len(), 2, "three matches across two files means two digests");
        assert!(files.iter().any(|f| f.path == "a.txt"));
        assert!(files.iter().any(|f| f.path == "b.txt"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    // --- the command end to end ---

    #[test]
    fn grep_project_returns_matches_offsets_and_digests() {
        let dir = temp_dir("end2end");
        std::fs::write(dir.join("a.ts"), "café needle here\nchaff\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let result = grep_project(root, "needle".into(), opts(), 500).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].submatches, vec![(5, 11)]);
        assert!(!result.truncated);
        assert_eq!(result.files.len(), 1);
        assert!(!result.backend.is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn grep_project_surfaces_a_bad_regex_instead_of_panicking() {
        let dir = temp_dir("badregex");
        let root = dir.to_string_lossy().into_owned();
        let o = SearchOptions { case: true, regex: true, ..Default::default() };
        assert!(grep_project(root, "[".into(), o, 500).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // --- replace ---

    fn span(line: u32, start: u32, end: u32) -> ReplaceSpan {
        ReplaceSpan { line, start, end }
    }

    /// Search the fixture the way the panel does, so the digest and offsets
    /// handed to `replace_in_files` are the ones a real run would carry.
    fn search_for(root: &str, query: &str, o: &SearchOptions) -> SearchResult {
        grep_project(root.to_string(), query.to_string(), o.clone(), 500).unwrap()
    }

    fn targets_from(result: &SearchResult) -> Vec<ReplaceTarget> {
        result
            .files
            .iter()
            .map(|f| ReplaceTarget {
                path: f.path.clone(),
                digest: f.digest.clone(),
                matches: result
                    .matches
                    .iter()
                    .filter(|m| m.path == f.path)
                    .flat_map(|m| m.submatches.iter().map(|(s, e)| span(m.line, *s, *e)))
                    .collect(),
            })
            .collect()
    }

    #[test]
    fn utf16_to_byte_maps_through_non_ascii() {
        assert_eq!(utf16_to_byte("café needle", 0), Some(0));
        // "café " is 5 UTF-16 units, 6 bytes.
        assert_eq!(utf16_to_byte("café needle", 5), Some(6));
        assert_eq!(utf16_to_byte("café needle", 11), Some(12));
        // Past the end is not a boundary.
        assert_eq!(utf16_to_byte("abc", 9), None);
    }

    #[test]
    fn line_spans_handles_crlf_and_a_missing_final_newline() {
        assert_eq!(line_spans("a\nbb\n"), vec![(0, 1), (2, 4)]);
        // No phantom trailing line when the file ends in a newline.
        assert_eq!(line_spans("a\n").len(), 1);
        // A final line without a terminator still counts.
        assert_eq!(line_spans("a\nbb"), vec![(0, 1), (2, 4)]);
        // CRLF: the span excludes both terminator bytes.
        assert_eq!(line_spans("a\r\nbb\r\n"), vec![(0, 1), (3, 5)]);
    }

    #[test]
    fn preview_expands_captures_named_groups_and_a_literal_dollar() {
        let rx = SearchOptions { case: true, regex: true, ..Default::default() };

        let out = preview_replace(
            r"(\w+)@(\w+)".into(),
            rx.clone(),
            "$2 at $1".into(),
            vec![PreviewSpan { text: "mail bob@example here".into(), start: 5, end: 16 }],
        )
        .unwrap();
        assert_eq!(out, vec![Some("example at bob".to_string())]);

        let out = preview_replace(
            r"(?P<user>\w+)@(?P<host>\w+)".into(),
            rx.clone(),
            "${host}/${user}".into(),
            vec![PreviewSpan { text: "bob@example".into(), start: 0, end: 11 }],
        )
        .unwrap();
        assert_eq!(out, vec![Some("example/bob".to_string())]);

        // `$$` is the escape for a literal dollar.
        let out = preview_replace(
            "cost".into(),
            SearchOptions { case: true, ..Default::default() },
            "$$5".into(),
            vec![PreviewSpan { text: "the cost here".into(), start: 4, end: 8 }],
        )
        .unwrap();
        assert_eq!(out, vec![Some("$5".to_string())]);
    }

    #[test]
    fn preview_returns_null_for_a_span_that_no_longer_matches() {
        let out = preview_replace(
            "needle".into(),
            SearchOptions { case: true, ..Default::default() },
            "pin".into(),
            vec![
                PreviewSpan { text: "needle here".into(), start: 0, end: 6 },
                // Right length, wrong place: nothing matches at this offset.
                PreviewSpan { text: "needle here".into(), start: 5, end: 11 },
            ],
        )
        .unwrap();
        assert_eq!(out, vec![Some("pin".to_string()), None]);
    }

    #[test]
    fn preview_and_replace_agree_on_the_same_span() {
        // The property the panel relies on: what is previewed is what is written.
        let dir = temp_dir("previewparity");
        std::fs::write(dir.join("a.txt"), "bob@example here\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = SearchOptions { case: true, regex: true, ..Default::default() };
        let query = r"(\w+)@(\w+)";
        let replacement = "$2 at $1";

        let found = search_for(&root, query, &o);
        let m = &found.matches[0];
        let previewed = preview_replace(
            query.into(),
            o.clone(),
            replacement.into(),
            vec![PreviewSpan {
                text: m.text.clone(),
                start: m.submatches[0].0,
                end: m.submatches[0].1,
            }],
        )
        .unwrap()[0]
            .clone()
            .unwrap();

        replace_in_files(
            root.clone(),
            query.into(),
            o,
            replacement.into(),
            targets_from(&found),
        )
        .unwrap();

        let after = std::fs::read_to_string(dir.join("a.txt")).unwrap();
        assert!(after.contains(&previewed), "wrote {after:?}, previewed {previewed:?}");
        assert_eq!(after, "example at bob here\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_refuses_a_path_outside_the_root() {
        let dir = temp_dir("containment");
        let outside = temp_dir("containment_outside");
        std::fs::write(outside.join("secret.txt"), "needle here\n").unwrap();
        std::fs::write(dir.join("inside.txt"), "needle here\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = opts();

        // A parent-dir escape, and a symlink that resolves out of the root.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("escape")).unwrap();

        let targets = vec![
            ReplaceTarget {
                path: "../containment_outside/secret.txt".into(),
                digest: digest_of(&outside.join("secret.txt")).unwrap(),
                matches: vec![span(1, 0, 6)],
            },
            #[cfg(unix)]
            ReplaceTarget {
                path: "escape/secret.txt".into(),
                digest: digest_of(&outside.join("secret.txt")).unwrap(),
                matches: vec![span(1, 0, 6)],
            },
        ];
        let n = targets.len();
        let out =
            replace_in_files(root, "needle".into(), o, "pin".into(), targets).unwrap();

        assert!(out.changed.is_empty());
        assert_eq!(out.skipped.len(), n);
        assert!(out.skipped.iter().all(|s| s.reason.contains("project folder")));
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "needle here\n",
            "nothing outside the root may be written"
        );

        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn replace_skips_a_file_whose_digest_moved() {
        // The case a line-text comparison cannot detect: two *identical* lines
        // inserted above the match, so line 1's text still equals what was
        // searched while the match has moved to line 3.
        let dir = temp_dir("stale");
        let file = dir.join("a.txt");
        std::fs::write(&file, "needle here\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = opts();

        let found = search_for(&root, "needle", &o);
        let targets = targets_from(&found);

        std::fs::write(&file, "needle here\nneedle here\nneedle here\n").unwrap();

        let out = replace_in_files(root, "needle".into(), o, "pin".into(), targets).unwrap();
        assert!(out.changed.is_empty());
        assert_eq!(out.skipped.len(), 1);
        assert_eq!(out.skipped[0].reason, "changed on disk");
        assert_eq!(out.occurrences, 0);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "needle here\nneedle here\nneedle here\n",
            "a stale target must leave the file untouched"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_skips_a_target_with_no_digest() {
        let dir = temp_dir("nodigest");
        std::fs::write(dir.join("a.txt"), "needle\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let out = replace_in_files(
            root,
            "needle".into(),
            opts(),
            "pin".into(),
            vec![ReplaceTarget {
                path: "a.txt".into(),
                digest: String::new(),
                matches: vec![span(1, 0, 6)],
            }],
        )
        .unwrap();
        assert!(out.changed.is_empty());
        assert_eq!(out.skipped[0].reason, "changed on disk");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_preserves_crlf_and_a_missing_final_newline() {
        let dir = temp_dir("endings");
        let crlf = dir.join("crlf.txt");
        let nonl = dir.join("nonl.txt");
        std::fs::write(&crlf, "one needle\r\ntwo needle\r\n").unwrap();
        std::fs::write(&nonl, "three needle").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = opts();

        let found = search_for(&root, "needle", &o);
        let out =
            replace_in_files(root, "needle".into(), o, "pin".into(), targets_from(&found)).unwrap();
        assert_eq!(out.changed.len(), 2, "skipped: {:?}", out.skipped);

        assert_eq!(std::fs::read_to_string(&crlf).unwrap(), "one pin\r\ntwo pin\r\n");
        assert_eq!(
            std::fs::read_to_string(&nonl).unwrap(),
            "three pin",
            "a file without a final newline must not gain one"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn two_matches_on_one_line_both_land() {
        let dir = temp_dir("twoperline");
        let file = dir.join("a.txt");
        std::fs::write(&file, "ab cd ab\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = opts();

        let found = search_for(&root, "ab", &o);
        assert_eq!(found.matches[0].submatches.len(), 2);

        // A longer replacement, so a front-to-back application would corrupt the
        // second offset.
        let out =
            replace_in_files(root, "ab".into(), o, "XYZ".into(), targets_from(&found)).unwrap();
        assert_eq!(out.occurrences, 2);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "XYZ cd XYZ\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_lands_on_the_right_bytes_on_a_non_ascii_line() {
        let dir = temp_dir("utf8replace");
        let file = dir.join("a.txt");
        std::fs::write(&file, "café needle here\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = opts();

        let found = search_for(&root, "needle", &o);
        assert_eq!(found.matches[0].submatches, vec![(5, 11)]);
        let out =
            replace_in_files(root, "needle".into(), o, "pin".into(), targets_from(&found)).unwrap();
        assert_eq!(out.occurrences, 1);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "café pin here\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_rejects_overlapping_spans_rather_than_corrupting_the_file() {
        let dir = temp_dir("overlap");
        let file = dir.join("a.txt");
        std::fs::write(&file, "abcdef\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let out = replace_in_files(
            root,
            "abc".into(),
            opts(),
            "X".into(),
            vec![ReplaceTarget {
                path: "a.txt".into(),
                digest: digest_of(&file).unwrap(),
                // Hand-built overlapping spans: the UI cannot produce these, but
                // the command must not splice them.
                matches: vec![span(1, 0, 3), span(1, 2, 5)],
            }],
        )
        .unwrap();

        assert!(out.changed.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "abcdef\n", "file must be untouched");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replace_swaps_the_file_by_rename_so_a_torn_write_cannot_shorten_it() {
        // The atomic property, testable without crashing anything: `rename`
        // swaps a directory entry, so a handle opened *before* the replace still
        // reads the old bytes. A truncating write would rewrite the very file
        // that handle points at, and this would come back replaced.
        use std::io::Read;
        let dir = temp_dir("atomic");
        let file = dir.join("a.txt");
        std::fs::write(&file, "needle here\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = opts();

        let found = search_for(&root, "needle", &o);
        let mut handle = std::fs::File::open(&file).unwrap();

        let out =
            replace_in_files(root, "needle".into(), o, "pin".into(), targets_from(&found)).unwrap();
        assert_eq!(out.changed.len(), 1);

        let mut old = String::new();
        handle.read_to_string(&mut old).unwrap();
        assert_eq!(old, "needle here\n", "the pre-open handle must still see the replaced file");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "pin here\n");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_mixed_run_reports_changed_skipped_and_occurrences() {
        let dir = temp_dir("mixed");
        std::fs::write(dir.join("good.txt"), "needle one needle\n").unwrap();
        std::fs::write(dir.join("stale.txt"), "needle two\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let o = opts();

        let found = search_for(&root, "needle", &o);
        let targets = targets_from(&found);
        assert_eq!(targets.len(), 2);

        // Move one file out from under its digest.
        std::fs::write(dir.join("stale.txt"), "needle two, edited\n").unwrap();

        let out = replace_in_files(root, "needle".into(), o, "pin".into(), targets).unwrap();
        assert_eq!(out.changed, vec!["good.txt".to_string()]);
        assert_eq!(out.skipped.len(), 1);
        assert_eq!(out.skipped[0].path, "stale.txt");
        assert_eq!(out.occurrences, 2, "both spans on the one good line");
        assert_eq!(std::fs::read_to_string(dir.join("good.txt")).unwrap(), "pin one pin\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_empty_query_still_reports_backend_capability() {
        let dir = temp_dir("emptyquery");
        let root = dir.to_string_lossy().into_owned();
        let result = grep_project(root, String::new(), opts(), 500).unwrap();
        assert!(result.matches.is_empty());
        assert!(!result.backend.is_empty(), "the panel needs the backend before the first query");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // --- line write-back (the editable results buffer) ---

    fn edit(line: u32, was: &str, now: &str) -> LineEdit {
        LineEdit { line, was: was.into(), now: now.into() }
    }

    #[test]
    fn line_edits_rewrite_only_the_lines_they_name() {
        let dir = temp_dir("lineedits");
        std::fs::write(dir.join("a.txt"), "one\nneedle\nthree\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let out = apply_line_edits(
            root,
            vec![FileEdits { path: "a.txt".into(), edits: vec![edit(2, "needle", "pin")] }],
        )
        .unwrap();

        assert_eq!(out.changed, vec!["a.txt".to_string()]);
        assert!(out.skipped.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\npin\nthree\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_line_that_moved_since_the_search_refuses_its_whole_file() {
        let dir = temp_dir("linestale");
        std::fs::write(dir.join("a.txt"), "someone else got here\nneedle\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        // Two edits, one of which no longer describes its line. The other must
        // not land either: half a write-back is the outcome with no honest
        // report.
        let out = apply_line_edits(
            root,
            vec![FileEdits {
                path: "a.txt".into(),
                edits: vec![edit(1, "one", "ONE"), edit(2, "needle", "pin")],
            }],
        )
        .unwrap();

        assert!(out.changed.is_empty());
        assert_eq!(out.skipped.len(), 1);
        assert_eq!(out.skipped[0].path, "a.txt");
        assert_eq!(out.skipped[0].reason, "changed since the search");
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "someone else got here\nneedle\n",
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn one_refused_file_does_not_hold_up_the_rest() {
        let dir = temp_dir("linemixed");
        std::fs::write(dir.join("a.txt"), "needle a\n").unwrap();
        std::fs::write(dir.join("b.txt"), "needle b\n").unwrap();
        std::fs::write(dir.join("c.txt"), "moved on\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let out = apply_line_edits(
            root,
            vec![
                FileEdits { path: "a.txt".into(), edits: vec![edit(1, "needle a", "pin a")] },
                FileEdits { path: "b.txt".into(), edits: vec![edit(1, "needle b", "pin b")] },
                FileEdits { path: "c.txt".into(), edits: vec![edit(1, "needle c", "pin c")] },
            ],
        )
        .unwrap();

        assert_eq!(out.changed, vec!["a.txt".to_string(), "b.txt".to_string()]);
        assert_eq!(out.skipped.len(), 1);
        assert_eq!(out.skipped[0].path, "c.txt");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "pin a\n");
        assert_eq!(std::fs::read_to_string(dir.join("c.txt")).unwrap(), "moved on\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_edit_carrying_a_newline_is_refused_rather_than_splitting_a_line() {
        let dir = temp_dir("linesplit");
        std::fs::write(dir.join("a.txt"), "needle\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let out = apply_line_edits(
            root,
            vec![FileEdits { path: "a.txt".into(), edits: vec![edit(1, "needle", "pin\nmore")] }],
        )
        .unwrap();

        assert_eq!(out.skipped[0].reason, "an edit would add a line");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "needle\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn two_edits_on_one_line_refuse_rather_than_keeping_whichever_came_last() {
        let dir = temp_dir("linedupe");
        std::fs::write(dir.join("a.txt"), "needle\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let out = apply_line_edits(
            root,
            vec![FileEdits {
                path: "a.txt".into(),
                edits: vec![edit(1, "needle", "pin"), edit(1, "needle", "nail")],
            }],
        )
        .unwrap();

        assert_eq!(out.skipped[0].reason, "two edits on one line");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "needle\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn line_write_back_refuses_a_path_outside_the_root() {
        let dir = temp_dir("lineescape");
        std::fs::create_dir_all(dir.join("proj")).unwrap();
        std::fs::write(dir.join("outside.txt"), "needle\n").unwrap();
        let root = dir.join("proj").to_string_lossy().into_owned();

        let out = apply_line_edits(
            root,
            vec![FileEdits {
                path: "../outside.txt".into(),
                edits: vec![edit(1, "needle", "pin")],
            }],
        )
        .unwrap();

        assert!(out.changed.is_empty());
        assert_eq!(out.skipped.len(), 1);
        assert_eq!(std::fs::read_to_string(dir.join("outside.txt")).unwrap(), "needle\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn line_write_back_leaves_crlf_and_a_missing_final_newline_alone() {
        let dir = temp_dir("lineeol");
        std::fs::write(dir.join("a.txt"), "one\r\nneedle\r\nlast").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let out = apply_line_edits(
            root,
            vec![FileEdits {
                path: "a.txt".into(),
                edits: vec![edit(2, "needle", "pin"), edit(3, "last", "final")],
            }],
        )
        .unwrap();

        assert_eq!(out.changed, vec!["a.txt".to_string()]);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\r\npin\r\nfinal");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_line_edit_that_changes_nothing_writes_nothing() {
        let dir = temp_dir("lineempty");
        std::fs::write(dir.join("a.txt"), "needle\n").unwrap();
        let root = dir.to_string_lossy().into_owned();

        let out =
            apply_line_edits(root, vec![FileEdits { path: "a.txt".into(), edits: vec![] }]).unwrap();

        assert!(out.changed.is_empty(), "a file with no edits is not a file that was written");
        assert!(out.skipped.is_empty(), "and it is not a failure either");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
