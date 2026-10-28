use std::sync::LazyLock;

use regex::{Captures, Regex};

// A short extension is spelled and a long one said as a word; these are the
// exceptions each way.
const WORD_EXTENSIONS: &[&str] = &[
    "log", "zip", "gif", "tar", "app", "bin", "jar", "exe", "iso", "img", "mov", "wav",
];
const SPELLED_EXTENSIONS: &[&str] = &["html", "xlsx", "docx", "pptx", "jsonl", "webm", "webp"];

const ABBREVIATIONS: &[(&str, &str)] = &[
    ("e.g.", "for example"),
    ("i.e.", "that is"),
    ("etc.", "et cetera"),
    ("vs.", "versus"),
    ("vs", "versus"),
    ("approx.", "approximately"),
    ("aka", "also known as"),
    ("w/o", "without"),
    ("w/", "with"),
];

const UNITS: &[(&str, &str)] = &[
    ("TB", "terabyte"),
    ("GB", "gigabyte"),
    ("MB", "megabyte"),
    ("KB", "kilobyte"),
    ("kB", "kilobyte"),
    ("ms", "millisecond"),
    ("kHz", "kilohertz"),
    ("MHz", "megahertz"),
    ("GHz", "gigahertz"),
    ("Hz", "hertz"),
    ("px", "pixel"),
    ("fps", "frames per second"),
    ("mm", "millimetre"),
    ("cm", "centimetre"),
    ("km", "kilometre"),
    ("kg", "kilogram"),
    ("mAh", "milliamp hour"),
    ("min", "minute"),
    ("hr", "hour"),
];

const MODIFIERS: &[(&str, &str)] = &[
    ("ctrl", "Control"),
    ("ctl", "Control"),
    ("control", "Control"),
    ("shft", "Shift"),
    ("sft", "Shift"),
    ("shift", "Shift"),
    ("alt", "Alt"),
    ("opt", "Option"),
    ("option", "Option"),
    ("cmd", "Command"),
    ("command", "Command"),
    ("gui", "GUI"),
    ("win", "Windows"),
    ("meta", "Meta"),
    ("super", "Super"),
    ("fn", "Function"),
];

// Key names as keymaps (ZMK, QMK) and shortcuts write them.
const KEYS: &[(&str, &str)] = &[
    ("BSPC", "Backspace"),
    ("BKSP", "Backspace"),
    ("DEL", "Delete"),
    ("ESC", "Escape"),
    ("RET", "Enter"),
    ("ENT", "Enter"),
    ("ENTER", "Enter"),
    ("SPC", "Space"),
    ("SPACE", "Space"),
    ("CAPS", "Caps Lock"),
    ("CLCK", "Caps Lock"),
    ("PGUP", "Page Up"),
    ("PGDN", "Page Down"),
    ("INS", "Insert"),
    ("PSCR", "Print Screen"),
    ("SLCK", "Scroll Lock"),
    ("SEMI", "Semicolon"),
    ("COMMA", "Comma"),
    ("DOT", "Dot"),
    ("FSLH", "Slash"),
    ("SLASH", "Slash"),
    ("BSLH", "Backslash"),
    ("GRAVE", "Grave"),
    ("MINUS", "Minus"),
    ("EQUAL", "Equals"),
    ("LBKT", "Left Bracket"),
    ("RBKT", "Right Bracket"),
    ("LBRC", "Left Brace"),
    ("RBRC", "Right Brace"),
    ("LPAR", "Left Paren"),
    ("RPAR", "Right Paren"),
    ("SQT", "Single Quote"),
    ("DQT", "Double Quote"),
    ("TILDE", "Tilde"),
    ("EXCL", "Exclamation"),
    ("DLLR", "Dollar"),
    ("PRCNT", "Percent"),
    ("CARET", "Caret"),
    ("AMPS", "Ampersand"),
    ("STAR", "Star"),
    ("ASTRK", "Star"),
    ("UNDER", "Underscore"),
    ("PLUS", "Plus"),
    ("PIPE", "Pipe"),
    ("QMARK", "Question Mark"),
    ("KP", "Keypad"),
    ("VOL", "Volume"),
    ("BRI", "Brightness"),
    ("PP", "Play Pause"),
    ("PREV", "Previous"),
    ("DN", "Down"),
];

// ZMK behaviours, which a keymap reply quotes by the line.
const BEHAVIOURS: &[(&str, &str)] = &[
    ("&kp", "key"),
    ("&mt", "mod tap"),
    ("&lt", "layer tap"),
    ("&mo", "momentary layer"),
    ("&to", "to layer"),
    ("&tog", "toggle layer"),
    ("&sk", "sticky key"),
    ("&sl", "sticky layer"),
    ("&trans", "transparent"),
    ("&none", "none"),
    ("&bt", "bluetooth"),
    ("&out", "output"),
    ("&bootloader", "bootloader"),
    ("&sys_reset", "reset"),
];

const SYMBOLS: &[(&str, &str)] = &[
    ("!==", " not equal "),
    ("===", " equals "),
    ("!=", " not equal "),
    ("==", " equals "),
    ("->", " to "),
    ("=>", " to "),
    ("<=", " at most "),
    (">=", " at least "),
    ("&&", " and "),
    ("||", " or "),
    ("::", " "),
];

// The emoji that carry a verdict are said; the rest are decoration.
const EMOJI_SAID: &[(&str, &str)] = &[("\u{2705}", "check"), ("\u{274c}", "cross"), ("\u{26a0}", "warning")];

static EMOJI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}\x{200D}\x{1F3FB}-\x{1F3FF}]").unwrap()
});
static TASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([ xX])\]").unwrap());
static ABBREV: LazyLock<Regex> = LazyLock::new(|| {
    let alts: Vec<String> = ABBREVIATIONS.iter().map(|(a, _)| regex::escape(a)).collect();
    Regex::new(&format!(r"(?i)(^|[\s(])({})(?:$|[\s,;:)])", alts.join("|"))).unwrap()
});
static BEHAVIOUR: LazyLock<Regex> = LazyLock::new(|| {
    let alts: Vec<String> = BEHAVIOURS.iter().map(|(b, _)| regex::escape(b)).collect();
    Regex::new(&format!(r"({})\b", alts.join("|"))).unwrap()
});
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9+.-]*://(?:www\.)?([^/:?#]+)").unwrap());
static HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{7,64}$").unwrap());
static FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\.?[A-Za-z0-9_+-]{2,}(?:\.[A-Za-z0-9]{1,10})+$").unwrap());
static PORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+):(\d{2,5})$").unwrap()
});
static VERSIONED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[vV](\d+(?:\.\d+)+)$").unwrap());
static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.+?):(\d+)(?::\d+)?$").unwrap());
static FOLDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z][\w.-]*/$").unwrap());
static DOTFILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\.[A-Za-z][\w-]+$").unwrap());
static UNIT: LazyLock<Regex> = LazyLock::new(|| {
    let alts: Vec<&str> = UNITS.iter().map(|(u, _)| *u).collect();
    Regex::new(&format!(r"\b(\d+(?:\.\d+)?) ?({})\b", alts.join("|"))).unwrap()
});
static SECONDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d{1,3}(?:\.\d+)?)s\b|\b(\d+\.\d+) s\b").unwrap());
static PERCENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+(?:\.\d+)?) ?%").unwrap());
static ABOUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"~(\d)").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#(\d+)\b").unwrap());
static BY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d+) ?[x×] ?(\d+)\b").unwrap());
// A slash left after the paths are taken out is prose: read/write, LCTRL / TAB.
// Between two numbers it is a date or a ratio and stays.
static EITHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Za-z]\w*|\d+) ?/ ?([A-Za-z]\w*|\d+)").unwrap());
static CHORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[A-Za-z]+(?:\+[A-Za-z0-9]+)+\b").unwrap());
static SIDED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b([LR])(CTRL|CTL|SHFT|SFT|SHIFT|ALT|GUI|CMD|WIN|META|OPT)\b").unwrap());
static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b([A-Z]{2,5})\b|\bN(\d)\b").unwrap());
static NAMED_MOD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(Ctrl|Cmd|Esc)\b").unwrap());
static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bv?(\d+(?:\.\d+)+)\b").unwrap());
static FLAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|\s)(--?)([A-Za-z][\w-]*)").unwrap());
static SNAKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\w*[A-Za-z0-9]_\w+").unwrap());
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9]+").unwrap());
// Kokoro barely pauses on a colon and misaki drops parentheses, so both
// become commas, which it does pause on.
static COLON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":(\s|$)").unwrap());
static PAREN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*[()]\s*").unwrap());
static COMMAS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*,(?:\s*,)+").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" {2,}").unwrap());
static KEBAB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[A-Za-z]+(?:-[A-Za-z]+)+\b").unwrap());

const OPENS: &[char] = &['(', '[', '"', '\'', '`'];
const CLOSES: &[char] = &[',', '.', ';', ':', '!', '?', ')', ']', '"', '\'', '`'];

fn lookup<'a>(table: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// `text` as a developer would say it: paths, file names, URLs, hashes,
/// versions, units, flags, key names and operators become words the
/// phonemizer can read.
pub fn spoken(text: &str) -> String {
    let text = EMOJI.replace_all(text, |c: &Captures| {
        lookup(EMOJI_SAID, &c[0]).map_or(String::new(), |said| format!(" {said} "))
    });
    let text = TASK.replace_all(&text, |c: &Captures| if &c[1] == " " { "to do," } else { "done," });
    let text = ABBREV.replace_all(&text, |c: &Captures| {
        let said = lookup(ABBREVIATIONS, &c[2].to_ascii_lowercase()).unwrap();
        format!("{}{said}{}", &c[1], &c[0][c[1].len() + c[2].len()..])
    });
    let text = BEHAVIOUR.replace_all(&text, |c: &Captures| lookup(BEHAVIOURS, &c[1]).unwrap());

    let mut out = String::with_capacity(text.len());
    let mut rest: &str = &text;
    while let Some(start) = rest.find(|c: char| !c.is_whitespace()) {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        out.push_str(&token(&rest[..end]));
        rest = &rest[end..];
    }
    out.push_str(rest);

    let text = UNIT.replace_all(&out, |c: &Captures| {
        let unit = lookup(UNITS, &c[2]).unwrap();
        let plural = if &c[1] == "1" || unit.ends_with("hertz") || unit.starts_with("frames") {
            ""
        } else {
            "s"
        };
        format!("{} {unit}{plural}", &c[1])
    });
    let text = SECONDS.replace_all(&text, |c: &Captures| {
        let n = c.get(1).or(c.get(2)).unwrap().as_str();
        format!("{n} second{}", if n == "1" { "" } else { "s" })
    });
    let text = PERCENT.replace_all(&text, "$1 percent");
    let text = ABOUT.replace_all(&text, "about $1");
    let text = NUMBER.replace_all(&text, "number $1");
    let text = BY.replace_all(&text, "$1 by $2");
    let text = EITHER.replace_all(&text, |c: &Captures| {
        if c[1].chars().all(|ch| ch.is_ascii_digit()) && c[2].chars().all(|ch| ch.is_ascii_digit()) {
            c[0].to_string()
        } else {
            format!("{} or {}", &c[1], &c[2])
        }
    });
    let text = CHORD.replace_all(&text, |c: &Captures| chord(&c[0]));
    let text = SIDED.replace_all(&text, |c: &Captures| {
        let side = if &c[1] == "L" { "Left" } else { "Right" };
        format!("{side} {}", lookup(MODIFIERS, &c[2].to_ascii_lowercase()).unwrap())
    });
    let text = NAMED_MOD.replace_all(&text, |c: &Captures| match &c[1] {
        "Ctrl" => "Control",
        "Cmd" => "Command",
        _ => "Escape",
    });
    let text = VERSION.replace_all(&text, |c: &Captures| c[1].replace('.', " point "));
    let text = FLAG.replace_all(&text, |c: &Captures| {
        let dashes = if &c[2] == "--" { "dash dash" } else { "dash" };
        format!("{}{dashes} {}", &c[1], &c[3])
    });
    let mut text = text.into_owned();
    for (symbol, word) in SYMBOLS {
        text = text.replace(symbol, word);
    }
    let text = SNAKE.replace_all(&text, |c: &Captures| c[0].replace('_', " ").trim().to_string());
    let text = KEY.replace_all(&text, |c: &Captures| match c.get(1) {
        Some(key) => lookup(KEYS, key.as_str()).unwrap_or(key.as_str()).to_string(),
        None => c[2].to_string(),
    });
    let text = KEBAB.replace_all(&text, |c: &Captures| c[0].replace('-', " "));
    let text = WORD.replace_all(&text, |c: &Captures| words(&c[0]));
    let text = COLON.replace_all(&text, ",$1");
    let text = text.replace("(s)", "s");
    let text = PAREN.replace_all(&text, ", ");
    let text = COMMAS.replace_all(&text, ",");
    let text = text.replace(", .", ".").replace(" ,", ",").replace(" .", ".");
    SPACES.replace_all(&text, " ").into_owned().trim_end().to_string()
}

// Cmd+Shift+P: a chain is only a shortcut when a modifier starts it.
fn chord(raw: &str) -> String {
    let parts: Vec<&str> = raw.split('+').collect();
    if lookup(MODIFIERS, &parts[0].to_ascii_lowercase()).is_none() {
        return raw.to_string();
    }
    parts
        .iter()
        .map(|p| lookup(MODIFIERS, &p.to_ascii_lowercase()).unwrap_or(p).to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

// camelCase, PascalCase and digit runs into words: speakableBlocks,
// HTMLElement, utf8. An all-capitals word is left whole.
fn words(w: &str) -> String {
    let chars: Vec<char> = w.chars().collect();
    let mut out = String::with_capacity(w.len() + 4);
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 {
            let prev = chars[i - 1];
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_ascii_lowercase());
            let split = (prev.is_ascii_lowercase() && c.is_ascii_uppercase())
                || (prev.is_ascii_uppercase() && c.is_ascii_uppercase() && next_lower)
                || (prev.is_ascii_digit() != c.is_ascii_digit());
            if split {
                out.push(' ');
            }
        }
        out.push(c);
    }
    out
}

fn token(raw: &str) -> String {
    let core = raw.trim_start_matches(OPENS).trim_end_matches(CLOSES);
    if core.is_empty() {
        return raw.to_string();
    }
    let at = raw.find(core).unwrap();
    let said = if let Some(c) = VERSIONED.captures(core) {
        format!("version {}", c[1].replace('.', " point "))
    } else if let Some(c) = PORT.captures(core) {
        format!("{}, port {}", c[1].replace('.', " dot "), &c[2])
    } else if let Some(said) = LINE
        .captures(core)
        .and_then(|c| name(&c[1]).map(|n| format!("{n}, line {}", &c[2])))
    {
        said
    } else if let Some(c) = URL.captures(core) {
        c[1].replace('.', " dot ")
    } else if HASH.is_match(core)
        && core.contains(|c: char| c.is_ascii_digit())
        && core.contains(|c: char| c.is_ascii_alphabetic())
    {
        "a hash".into()
    } else if let Some(said) = name(core) {
        said
    } else if FOLDER.is_match(core) {
        format!("{} folder", core.trim_end_matches('/'))
    } else {
        return raw.to_string();
    };
    format!("{}{said}{}", &raw[..at], &raw[at + core.len()..])
}

fn name(core: &str) -> Option<String> {
    if DOTFILE.is_match(core) {
        Some(format!("dot {}", &core[1..]))
    } else if is_path(core) {
        Some(path(core))
    } else if FILE.is_match(core)
        && core
            .rsplit('.')
            .next()
            .is_some_and(|ext| ext.contains(|c: char| c.is_ascii_alphabetic()))
    {
        Some(file(core))
    } else {
        None
    }
}

// One slash is often prose (and/or, read/write, 10/29), so a lone slash only
// counts when the name after it has an extension.
fn is_path(core: &str) -> bool {
    if !core.contains('/') || core.contains("://") || !core.contains(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    let anchored = core.starts_with('/') || core.starts_with("~/") || core.starts_with("./") || core.starts_with("../");
    let last = core.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    anchored || core.matches('/').count() >= 2 || FILE.is_match(last)
}

fn path(core: &str) -> String {
    let segments: Vec<&str> = core
        .split('/')
        .filter(|s| !s.is_empty() && *s != "." && *s != ".." && *s != "~")
        .collect();
    let Some((last, parents)) = segments.split_last() else {
        return core.to_string();
    };
    let name = if DOTFILE.is_match(last) {
        format!("dot {}", &last[1..])
    } else if FILE.is_match(last) {
        file(last)
    } else {
        last.to_string()
    };
    let near: Vec<String> = parents
        .iter()
        .rev()
        .take(2)
        .rev()
        .map(|p| {
            p.strip_prefix('.')
                .map_or_else(|| p.to_string(), |rest| format!("dot {rest}"))
        })
        .collect();
    if near.is_empty() {
        name
    } else {
        format!("{name}, in {}", near.join(" "))
    }
}

fn file(name: &str) -> String {
    let (stem, ext) = name.rsplit_once('.').unwrap();
    let lower = ext.to_ascii_lowercase();
    let as_word = if ext.len() >= 4 {
        !SPELLED_EXTENSIONS.contains(&lower.as_str())
    } else {
        WORD_EXTENSIONS.contains(&lower.as_str())
    };
    let ext_said = if as_word {
        ext.to_string()
    } else {
        ext.to_ascii_uppercase()
            .chars()
            .map(String::from)
            .collect::<Vec<_>>()
            .join(" ")
    };
    if stem.is_empty() {
        return format!("dot {ext_said}");
    }
    let stem = if FILE.is_match(stem) {
        file(stem)
    } else {
        stem.to_string()
    };
    format!("{stem} dot {ext_said}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_text_reads_the_way_a_developer_says_it() {
        for (text, said) in [
            (
                "The fix is in src/utils/speech.ts, next to the store.",
                "The fix is in speech dot T S, in src utils, next to the store.",
            ),
            (
                "Open src-tauri/src/speech/mod.rs and look at speech_speak.",
                "Open mod dot R S, in src speech and look at speech speak.",
            ),
            (
                "It reads /tmp/kokoro-spike/models now.",
                "It reads models, in tmp kokoro spike now.",
            ),
            (
                "Edit package.json and Cargo.toml.",
                "Edit package dot json and Cargo dot toml.",
            ),
            ("The ignore list is .gitignore.", "The ignore list is dot gitignore."),
            ("Mine is in ~/.config/tori.", "Mine is in tori, in dot config."),
            ("Node.js is fine.", "Node dot J S is fine."),
            (
                "It breaks at Omnibox.tsx:703 today.",
                "It breaks at Omnibox dot T S X, line 703 today.",
            ),
            (
                "See src/speech/queue.rs:240:9 for that.",
                "See queue dot R S, in src speech, line 240 for that.",
            ),
            ("Read through desktop/ first.", "Read through desktop folder first."),
            ("The time is 10:30 now.", "The time is 10:30 now."),
            (
                "It serves on localhost:3000 and 127.0.0.1:8080.",
                "It serves on localhost, port 3000 and 127 dot 0 dot 0 dot 1, port 8080.",
            ),
            (
                "Pinned at 1939ad2a8e416c0acfeecc08a694d14ef25f2231.",
                "Pinned at a hash.",
            ),
            ("Committed as 3c492711.", "Committed as a hash."),
            (
                "See https://github.com/gettori/tickets/issues/103 for it.",
                "See github dot com for it.",
            ),
            (
                "ureq goes 3.4.2 -> 3.5.0 here.",
                "ureq goes 3 point 4 point 2 to 3 point 5 point 0 here.",
            ),
            ("A rate of 1.5 is fine.", "A rate of 1 point 5 is fine."),
            (
                "Tagged v0.3, after v26.1022.0.",
                "Tagged version 0 point 3, after version 26 point 1022 point 0.",
            ),
            (
                "Run it with --no-verify or -q.",
                "Run it with dash dash no verify or dash q.",
            ),
            ("Check a != b && c == d.", "Check a not equal b and c equals d."),
            ("Call std::env::var first.", "Call std env var first."),
            ("The read-a-reply-aloud branch.", "The read a reply aloud branch."),
            ("Use MAX_DOWNLOAD_BYTES there.", "Use MAX DOWNLOAD BYTES there."),
            (
                "Call speakableBlocks on an HTMLElement.",
                "Call speakable Blocks on an HTML Element.",
            ),
            ("It is utf8 and x86, not TTS.", "It is utf 8 and x 86, not TTS."),
            (
                "read/write and LCTRL / TAB, but not 10/29.",
                "read or write and Left Control or TAB, but not 10/29.",
            ),
            (
                "Abbreviated, e.g. this, i.e. that, etc.",
                "Abbreviated, for example this, that is that, et cetera",
            ),
            (
                "Rust vs. Go, w/ tests and w/o docs, aka done.",
                "Rust versus Go, with tests and without docs, also known as done.",
            ),
            ("A word in `backticks` stays.", "A word in `backticks` stays."),
            (
                "Two things: one (the first) and two (the second).",
                "Two things, one, the first, and two, the second.",
            ),
            ("Pick the file(s): done", "Pick the files, done"),
            (
                "Tests pass \u{2705} and ship it \u{1F680}\u{FE0F} now \u{1F44D}.",
                "Tests pass check and ship it now.",
            ),
            (
                "[ ] write docs and [x] add tests",
                "to do, write docs and done, add tests",
            ),
            (
                "The keymap is config/corne.keymap.",
                "The keymap is corne dot keymap, in config.",
            ),
            (
                "Also index.html and notes.docx.",
                "Also index dot H T M L and notes dot D O C X.",
            ),
            ("A 3x6 board, at 1920x1080.", "A 3 by 6 board, at 1920 by 1080."),
            (
                "int8 is 107 MB, full 340 MB, 1 GB free, 24 kHz.",
                "int 8 is 107 megabytes, full 340 megabytes, 1 gigabyte free, 24 kilohertz.",
            ),
            (
                "It took 450ms, then 0.5 s, then 30s.",
                "It took 450 milliseconds, then 0 point 5 seconds, then 30 seconds.",
            ),
            (
                "About 15% failed, ~2 GB used, see #101.",
                "About 15 percent failed, about 2 gigabytes used, see number 101.",
            ),
            (
                "LCTRL and RSHFT, then LGUI, BSPC, PGUP and KP_SLASH.",
                "Left Control and Right Shift, then Left GUI, Backspace, Page Up and Keypad Slash.",
            ),
            (
                "&kp N1 &mt LALT ESC &trans",
                "key 1 mod tap Left Alt Escape transparent",
            ),
            (
                "Press Cmd+Shift+P or Ctrl+K, then Esc.",
                "Press Command Shift P or Control K, then Escape.",
            ),
            ("The TTS and the DOM stay.", "The TTS and the DOM stay."),
        ] {
            assert_eq!(spoken(text), said, "{text}");
        }
    }
}
