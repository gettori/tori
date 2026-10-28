use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use misaki_rs::fallback::FallbackError;
use misaki_rs::{Fallback, Language, G2P};
use regex::{Captures, Regex};

// Words a reply about code uses that the lexicon either lacks, so they would
// be spelled letter by letter, or reads as letters where developers say a word.
const WORDS: &[(&str, &str)] = &[
    ("json", "Jason"),
    ("config", "con fig"),
    ("configs", "con figs"),
    ("plugin", "plug in"),
    ("plugins", "plug ins"),
    ("src", "source"),
    ("tsconfig", "T S con fig"),
    ("localhost", "local host"),
    ("webpack", "web pack"),
    ("stdin", "standard in"),
    ("stdout", "standard out"),
    ("stderr", "standard error"),
    ("enum", "ee num"),
    ("enums", "ee numbs"),
    ("sqlite", "S Q lite"),
    ("yaml", "[yaml](/jˈæmə‍l/)"),
    ("toml", "[toml](/tˈɑːmə‍l/)"),
    ("github", "git hub"),
    ("sudo", "sue doo"),
    ("dedupe", "dee dupe"),
    ("oauth", "oh auth"),
    ("macos", "mac O S"),
    ("mkdir", "make dir"),
    ("rustfmt", "rust format"),
    ("stdlib", "standard lib"),
    ("sql", "sequel"),
    ("vite", "[vite](/vˈit/)"),
    ("params", "[params](/pəɹˈæmz/)"),
    ("readme", "read me"),
    ("changelog", "change log"),
    ("todo", "to do"),
    ("todos", "to dos"),
    ("nginx", "engine X"),
];

// Said letter by letter, as developers say them, in any case.
const SPELLED: &[&str] = &[
    "npm", "pnpm", "npx", "cli", "ui", "api", "apis", "url", "urls", "css", "html", "ssh", "pr", "prs", "cpu", "gpu",
    "tsc", "cwd", "ux", "http", "https", "tcp", "udp", "dns", "ssl", "tls", "utf", "gui", "ide", "ides", "sdk", "sdks",
    "jwt", "cdn", "dom", "orm", "crud", "id", "ids", "ssd", "usb", "hdmi", "uuid", "uuids", "os", "ci", "qa", "zmk",
    "qmk", "gh", "cp", "mv", "vm", "vms", "db", "dbs", "ip", "ips", "pid", "pids", "tty",
];

type Espeak = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

// espeak-ng is GPL, so Tori runs a copy the user installed as its own process
// rather than linking it. The word goes in on stdin, where a leading `-` cannot
// pass for an option.
fn run_espeak(word: &str) -> Option<String> {
    let bin = crate::env::resolve_binary("espeak-ng")?;
    let mut child = Command::new(bin)
        .args(["-q", "--ipa", "--tie=^", "-v", "en-us"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(word.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

// Python misaki's `EspeakFallback` for American English, which is what Kokoro
// was trained against.
const E2M: &[(&str, &str)] = &[
    ("\u{294}\u{2cc}n\u{329}", "\u{294}n"),
    ("\u{294}n\u{329}", "\u{294}n"),
    ("a^\u{26a}", "I"),
    ("a^\u{28a}", "W"),
    ("d^\u{292}", "\u{2a4}"),
    ("e^\u{26a}", "A"),
    ("t^\u{283}", "\u{2a7}"),
    ("\u{254}^\u{26a}", "Y"),
    ("\u{259}^l", "\u{1d4a}l"),
    ("\u{2b2}o", "jo"),
    ("\u{2b2}\u{259}", "j\u{259}"),
    ("\u{2b2}", ""),
    ("e", "A"),
    ("\u{25a}", "\u{259}\u{279}"),
    ("r", "\u{279}"),
    ("x", "k"),
    ("\u{e7}", "k"),
    ("\u{250}", "\u{259}"),
    ("\u{26c}", "l"),
    ("\u{303}", ""),
];

fn to_misaki(ipa: &str, syllabic: &Regex) -> String {
    let mut ps = ipa.split_whitespace().collect::<Vec<_>>().join(" ");
    for (old, new) in E2M {
        ps = ps.replace(old, new);
    }
    let ps = syllabic.replace_all(&ps, "\u{1d4a}$1").replace('\u{329}', "");
    ps.replace("o^\u{28a}", "O")
        .replace("\u{25c}\u{2d0}\u{279}", "\u{25c}\u{279}")
        .replace("\u{25c}\u{2d0}", "\u{25c}\u{279}")
        .replace("\u{26a}\u{259}", "i\u{259}")
        .replace('\u{2d0}', "")
        .replace('o', "\u{254}")
        .replace('\u{27e}', "T")
        .replace('\u{294}', "t")
        .replace('^', "")
}

// misaki's own phonemes for each letter and digit, so spelling a word needs no
// second lexicon loaded.
const LETTERS: &[(char, &str)] = &[
    ('A', "ˈA"),
    ('B', "bˈi"),
    ('C', "sˈi"),
    ('D', "dˈi"),
    ('E', "ˈi"),
    ('F', "ˈɛf"),
    ('G', "ʤˈi"),
    ('H', "ˈAʧ"),
    ('I', "ˌI"),
    ('J', "ʤˈA"),
    ('K', "kˈA"),
    ('L', "ˈɛl"),
    ('M', "ˈɛm"),
    ('N', "ˈɛn"),
    ('O', "ˈO"),
    ('P', "pˈi"),
    ('Q', "kjˈu"),
    ('R', "ˈɑɹ"),
    ('S', "ˈɛs"),
    ('T', "tˈi"),
    ('U', "jˈu"),
    ('V', "vˈi"),
    ('W', "dˈʌbᵊlju"),
    ('X', "ˈɛks"),
    ('Y', "wˈI"),
    ('Z', "zˈi"),
    ('0', "zˈi\u{200d}əɹo\u{200d}ʊ"),
    ('1', "wˈʌn"),
    ('2', "tˈuː"),
    ('3', "θɹˈiː"),
    ('4', "fˈɔː\u{200d}ɹ"),
    ('5', "fˈa\u{200d}ɪv"),
    ('6', "sˈɪks"),
    ('7', "sˈɛvən"),
    ('8', "ˈe\u{200d}ɪt"),
    ('9', "nˈa\u{200d}ɪn"),
];

// misaki fails the whole read when a fallback errs, and a fallback is its only
// error path, so this one never returns one.
struct Unknown {
    espeak: Espeak,
    syllabic: Regex,
    said: Mutex<HashMap<String, String>>,
}

fn spelled(word: &str) -> String {
    word.chars()
        .filter_map(|c| LETTERS.iter().find(|(l, _)| *l == c.to_ascii_uppercase()))
        .map(|(_, ph)| *ph)
        .collect::<Vec<_>>()
        .join(" ")
}

impl Fallback for Unknown {
    fn phonemize(&self, word: &str) -> Result<String, FallbackError> {
        let acronym = word.len() <= 5 && word.chars().all(|c| c.is_ascii_uppercase());
        if acronym {
            return Ok(spelled(word));
        }
        if let Some(ph) = self.said.lock().unwrap().get(word) {
            return Ok(ph.clone());
        }
        let Some(ipa) = (self.espeak)(word) else {
            return Ok(spelled(word));
        };
        let ph = to_misaki(&ipa, &self.syllabic);
        self.said.lock().unwrap().insert(word.to_string(), ph.clone());
        Ok(ph)
    }
}

pub struct Phonemizer {
    g2p: G2P,
    words: Regex,
    respell: HashMap<&'static str, String>,
}

impl Phonemizer {
    pub fn new() -> Self {
        Self::with_espeak(Box::new(run_espeak))
    }

    fn with_espeak(espeak: Espeak) -> Self {
        let spelled: Vec<(&'static str, String)> = SPELLED
            .iter()
            .map(|w| {
                let (letters, plural) = match w.strip_suffix('s').filter(|_| w.len() > 3) {
                    Some(stem) => (stem, "s"),
                    None => (*w, ""),
                };
                let said = letters
                    .to_uppercase()
                    .chars()
                    .map(String::from)
                    .collect::<Vec<_>>()
                    .join(" ");
                (*w, format!("{said}{plural}"))
            })
            .collect();
        let names: Vec<&str> = WORDS.iter().map(|(w, _)| *w).chain(SPELLED.iter().copied()).collect();
        let unknown = Unknown {
            espeak,
            syllabic: Regex::new("(\\S)\u{329}").unwrap(),
            said: Mutex::default(),
        };
        Phonemizer {
            g2p: G2P::with_fallback(Language::EnglishUS, Some(Box::new(unknown))),
            words: Regex::new(&format!(r"(?i)\b(?:{})\b", names.join("|"))).unwrap(),
            respell: WORDS.iter().map(|(w, r)| (*w, r.to_string())).chain(spelled).collect(),
        }
    }

    pub fn phonemes(&self, text: &str) -> Result<String, String> {
        let text = super::spoken::spoken(text);
        let text = self
            .words
            .replace_all(&text, |c: &Captures| self.respell[c[0].to_lowercase().as_str()].clone());
        self.g2p.g2p(&text).map(|(ph, _)| ph).map_err(|e| e.to_string())
    }
}

fn rank(c: char) -> u8 {
    match c {
        '.' | '!' | '?' => 3,
        ',' | ';' | ':' => 2,
        ' ' => 1,
        _ => 0,
    }
}

// `first`, when not zero, ends the opening piece at its last clause break
// within that many tokens, or at its last space when it has none.
pub fn split(phonemes: &str, is_token: impl Fn(char) -> bool, cap: usize, first: usize) -> Vec<String> {
    let chars: Vec<char> = phonemes.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    if first > 0 {
        let mut tokens = 0;
        let mut best = (0, 0);
        for (i, &c) in chars.iter().enumerate() {
            if is_token(c) {
                if tokens == first {
                    break;
                }
                tokens += 1;
            }
            let rank = rank(c).min(2);
            if rank > 0 && rank >= best.0 {
                best = (rank, i + 1);
            }
        }
        let cut = Some(best.1).filter(|&cut| cut > 0 && chars[cut..].iter().any(|&c| is_token(c)));
        if let Some(cut) = cut {
            out.push(chars[..cut].iter().collect::<String>().trim().to_string());
            start = cut;
        }
    }
    while start < chars.len() {
        let mut tokens = 0;
        let mut end = start;
        let mut best = (0, 0);
        while end < chars.len() {
            let c = chars[end];
            if is_token(c) {
                if tokens == cap {
                    break;
                }
                tokens += 1;
            }
            end += 1;
            let rank = rank(c);
            if rank >= best.0 && rank > 0 {
                best = (rank, end);
            }
        }
        let cut = if end == chars.len() || best.0 == 0 { end } else { best.1 };
        let piece: String = chars[start..cut].iter().collect();
        if piece.chars().any(&is_token) {
            out.push(piece.trim().to_string());
        }
        start = cut;
    }
    out
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn letters(g2p: &G2P, word: &str) -> String {
        g2p.g2p(word).unwrap().0
    }

    #[test]
    fn every_listed_word_reads_as_its_respelling_not_its_letters() {
        let p = Phonemizer::with_espeak(Box::new(|_| None));
        let plain = G2P::new(Language::EnglishUS);
        for (word, respelling) in WORDS {
            let said = p.phonemes(word).unwrap();
            assert_eq!(said.trim(), plain.g2p(respelling).unwrap().0.trim(), "{word}");
            assert_ne!(said.trim(), letters(&plain, word).trim(), "{word} is still spelled");
        }
        assert_eq!(p.phonemes("JSON").unwrap().trim(), plain.g2p("Jason").unwrap().0.trim());
    }

    fn spelled(word: &str) -> String {
        let plain = G2P::new(Language::EnglishUS);
        word.chars()
            .map(|c| {
                plain
                    .g2p(&c.to_ascii_uppercase().to_string())
                    .unwrap()
                    .0
                    .trim()
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn every_spelled_word_reads_as_its_letters() {
        let p = Phonemizer::with_espeak(Box::new(|_| None));
        let plain = G2P::new(Language::EnglishUS);
        for word in SPELLED {
            let said = p.phonemes(word).unwrap();
            let letters: String = word.to_uppercase().chars().map(|c| format!("{c} ")).collect();
            let expected = match word.strip_suffix('s').filter(|_| word.len() > 3) {
                Some(stem) => {
                    let letters: String = stem.to_uppercase().chars().map(|c| format!("{c} ")).collect();
                    plain.g2p(&format!("{}s", letters.trim_end())).unwrap().0
                }
                None => plain.g2p(letters.trim_end()).unwrap().0,
            };
            assert_eq!(said.trim(), expected.trim(), "{word}");
            assert_eq!(
                p.phonemes(&word.to_uppercase()).unwrap().trim(),
                expected.trim(),
                "{word} in capitals"
            );
        }
    }

    #[test]
    fn espeak_ipa_maps_onto_misaki_phonemes() {
        let syllabic = Regex::new("(\\S)\u{329}").unwrap();
        for (ipa, misaki) in [
            ("t^\u{283}\u{2c8}e^\u{26a}n\n", "\u{2a7}\u{2c8}An"),
            ("\u{2c8}o^\u{28a}p\u{259}n", "\u{2c8}Op\u{259}n"),
            ("b\u{2c8}\u{25c}\u{2d0}d", "b\u{2c8}\u{25c}\u{279}d"),
            ("b\u{2c8}\u{28c}\u{27e}\u{25a}", "b\u{2c8}\u{28c}T\u{259}\u{279}"),
            ("b\u{2c8}\u{28c}\u{294}n\u{329}", "b\u{2c8}\u{28c}tn"),
            (
                "l\u{2c8}\u{26a}\u{259}d\u{292}\u{259}^l",
                "l\u{2c8}i\u{259}d\u{292}\u{1d4a}l",
            ),
        ] {
            assert_eq!(to_misaki(ipa, &syllabic), misaki, "{ipa}");
        }
    }

    #[test]
    fn an_unknown_word_is_said_by_espeak_once() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let log = asked.clone();
        let p = Phonemizer::with_espeak(Box::new(move |w| {
            log.lock().unwrap().push(w.to_string());
            Some("k\u{2c8}o^\u{28a}k\u{254}\u{2d0}\u{279}o^\u{28a}\n".into())
        }));
        let kokoro = "k\u{2c8}Ok\u{254}\u{279}O";
        assert_eq!(p.phonemes("Kokoro").unwrap().trim(), kokoro);
        assert!(p.phonemes("kokoroEngine").unwrap().starts_with(kokoro));
        assert_eq!(*asked.lock().unwrap(), ["Kokoro", "kokoro"]);
        p.phonemes("Kokoro and kokoro").unwrap();
        assert_eq!(asked.lock().unwrap().len(), 2);
    }

    #[test]
    fn an_acronym_is_spelled_even_with_espeak() {
        let p = Phonemizer::with_espeak(Box::new(|w| panic!("{w} went to espeak")));
        assert_eq!(p.phonemes("TTS").unwrap().trim(), spelled("TTS"));
    }

    #[test]
    fn without_espeak_an_unknown_word_is_spelled() {
        let p = Phonemizer::with_espeak(Box::new(|_| None));
        assert_eq!(p.phonemes("Kokoro").unwrap().trim(), spelled("Kokoro"));
    }

    #[test]
    fn an_identifier_reads_as_its_words() {
        let p = Phonemizer::with_espeak(Box::new(|_| None));
        let plain = G2P::new(Language::EnglishUS);
        let said = p.phonemes("speakableBlocks").unwrap();
        let words = format!(
            "{} {}",
            plain.g2p("speakable").unwrap().0.trim(),
            plain.g2p("blocks").unwrap().0.trim()
        );
        assert_eq!(said.trim(), words);
    }

    #[test]
    fn the_opening_piece_ends_at_a_clause_within_its_cap() {
        let is_token = |c: char| !c.is_whitespace();
        let text = format!("One two, three four. {}", "five six seven eight nine ten. ".repeat(4));
        assert_eq!(split(&text, is_token, 150, 40)[0], "One two, three four.");
        let late = format!("{}end, more.", "word ".repeat(20));
        assert_eq!(split(&late, is_token, 150, 40)[0], "word ".repeat(10).trim());
        assert_eq!(split("Done.", is_token, 150, 40), ["Done."]);
    }

    #[test]
    fn a_long_paragraph_splits_into_pieces_under_the_cap_that_keep_every_token() {
        let p = Phonemizer::with_espeak(Box::new(|_| None));
        let text = "The store reads each block in turn, and the chip shows the speed. ".repeat(16);
        assert!(text.len() > 1_000);
        let ph = p.phonemes(&text).unwrap();
        let is_token = |c: char| !c.is_whitespace();
        let pieces = split(&ph, is_token, 150, 0);
        assert!(pieces.len() > 1);
        for piece in &pieces {
            assert!(piece.chars().filter(|c| is_token(*c)).count() <= 150);
        }
        let kept: String = pieces.concat().chars().filter(|c| is_token(*c)).collect();
        assert_eq!(kept, ph.chars().filter(|c| is_token(*c)).collect::<String>());
        assert!(
            pieces[..pieces.len() - 1].iter().all(|p| p.ends_with('.')),
            "{pieces:?}"
        );
    }
}
