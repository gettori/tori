// The indent keys of the `.editorconfig` files that govern one file, read the
// way editorconfig.org says: every file from the file's folder up to the first
// one marked `root = true`, the nearer file and the later section winning.

use std::collections::HashMap;
use std::path::Path;

use regex::Regex;
use serde::Serialize;

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfigIndent {
    spaces: Option<bool>,
    size: Option<u32>,
    tab_width: Option<u32>,
}

#[tauri::command(async)]
pub fn editorconfig_indent(path: String) -> EditorConfigIndent {
    indent_for(Path::new(&path))
}

struct Section {
    glob: String,
    pairs: Vec<(String, String)>,
}

struct Parsed {
    root: bool,
    sections: Vec<Section>,
}

fn indent_for(file: &Path) -> EditorConfigIndent {
    let mut chain = Vec::new();
    let mut dir = file.parent();
    while let Some(d) = dir {
        if let Ok(text) = std::fs::read_to_string(d.join(".editorconfig")) {
            let parsed = parse(&text);
            let root = parsed.root;
            chain.push((d, parsed));
            if root {
                break;
            }
        }
        dir = d.parent();
    }
    let mut keys = HashMap::new();
    for (d, parsed) in chain.iter().rev() {
        let Ok(rel) = file.strip_prefix(d) else { continue };
        let rel = rel.to_string_lossy();
        for section in parsed.sections.iter().filter(|s| matches(&s.glob, &rel)) {
            for (k, v) in &section.pairs {
                keys.insert(k.as_str(), v.as_str());
            }
        }
    }
    keys.retain(|_, v| *v != "unset");
    resolve(&keys)
}

fn parse(text: &str) -> Parsed {
    let mut parsed = Parsed {
        root: false,
        sections: Vec::new(),
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(glob) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            parsed.sections.push(Section {
                glob: glob.to_string(),
                pairs: Vec::new(),
            });
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_ascii_lowercase());
        match parsed.sections.last_mut() {
            Some(section) => section.pairs.push((k, v)),
            None if k == "root" => parsed.root = v == "true",
            None => {}
        }
    }
    parsed
}

// A glob with no slash matches at any depth below the file that holds it; one
// with a slash is anchored to that file's folder.
fn matches(glob: &str, rel: &str) -> bool {
    section_regex(glob).is_some_and(|re| re.is_match(rel))
}

// Translated rather than handed to `globset`, which takes `**` only as a whole
// path component: editorconfig lets it run into a name on either side, and
// `lib/**.js` is in its own sample file. `{num1..num2}` ranges are the one part
// of the syntax left out.
fn section_regex(glob: &str) -> Option<Regex> {
    let mut re = String::from("^");
    if !glob.contains('/') {
        re.push_str("(?:.*/)?");
    }
    let mut chars = glob.trim_start_matches('/').chars().peekable();
    let mut depth = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '*' if chars.peek() == Some(&'*') => {
                chars.next();
                re.push_str(".*");
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '[' => {
                let mut class = String::from("[");
                if chars.peek() == Some(&'!') {
                    chars.next();
                    class.push('^');
                }
                let mut closed = false;
                for c in chars.by_ref() {
                    if c == ']' {
                        closed = true;
                        break;
                    }
                    if matches!(c, '\\' | '^' | '[') {
                        class.push('\\');
                    }
                    class.push(c);
                }
                if !closed {
                    return None;
                }
                class.push(']');
                re.push_str(&class);
            }
            '{' => {
                re.push_str("(?:");
                depth += 1;
            }
            ',' if depth > 0 => re.push('|'),
            '}' if depth > 0 => {
                re.push(')');
                depth -= 1;
            }
            // A backslash is the escape, so the character after it is itself.
            '\\' => match chars.next() {
                Some(c) => re.push_str(&regex::escape(&c.to_string())),
                None => return None,
            },
            _ => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    if depth > 0 {
        return None;
    }
    re.push('$');
    Regex::new(&re).ok()
}

fn resolve(keys: &HashMap<&str, &str>) -> EditorConfigIndent {
    let number = |k: &str| keys.get(k).and_then(|v| v.parse::<u32>().ok());
    let tab_width = number("tab_width");
    let size = match keys.get("indent_size") {
        Some(&"tab") => tab_width,
        _ => number("indent_size"),
    };
    EditorConfigIndent {
        spaces: match keys.get("indent_style") {
            Some(&"space") => Some(true),
            Some(&"tab") => Some(false),
            _ => None,
        },
        size,
        // The spec's default: a tab is as wide as an indent level unless told.
        tab_width: tab_width.or(size),
    }
}
