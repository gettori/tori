use std::collections::HashMap;

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
    ("enums", "ee nums"),
    ("sqlite", "S Q lite"),
    ("yaml", "yammel"),
    ("toml", "tommel"),
];

// misaki fails the whole read when a fallback errs, and a fallback is its only
// error path. The inner G2P has none, so `spoken` cannot fail.
struct Identifiers {
    inner: G2P,
    parts: Regex,
}

impl Fallback for Identifiers {
    fn phonemize(&self, word: &str) -> Result<String, FallbackError> {
        let spoken = |w: &str| {
            self.inner
                .g2p(w)
                .map(|(ph, _)| ph.trim().to_string())
                .unwrap_or_default()
        };
        let parts: Vec<&str> = self.parts.find_iter(word).map(|m| m.as_str()).collect();
        if parts.len() < 2 {
            return Ok(spoken(word));
        }
        Ok(parts.iter().map(|p| spoken(p)).collect::<Vec<_>>().join(" "))
    }
}

pub struct Phonemizer {
    g2p: G2P,
    words: Regex,
    respell: HashMap<&'static str, &'static str>,
}

impl Phonemizer {
    pub fn new() -> Self {
        let names: Vec<&str> = WORDS.iter().map(|(w, _)| *w).collect();
        Phonemizer {
            g2p: G2P::with_fallback(
                Language::EnglishUS,
                Some(Box::new(Identifiers {
                    inner: G2P::new(Language::EnglishUS),
                    parts: Regex::new(r"[A-Z]+(?:[a-z]+)?|[a-z]+|[0-9]+").unwrap(),
                })),
            ),
            words: Regex::new(&format!(r"(?i)\b(?:{})\b", names.join("|"))).unwrap(),
            respell: WORDS.iter().copied().collect(),
        }
    }

    pub fn phonemes(&self, text: &str) -> Result<String, String> {
        let text = self.words.replace_all(text, |c: &Captures| {
            self.respell[c[0].to_lowercase().as_str()].to_string()
        });
        self.g2p.g2p(&text).map(|(ph, _)| ph).map_err(|e| e.to_string())
    }
}

pub fn split(phonemes: &str, is_token: impl Fn(char) -> bool, cap: usize) -> Vec<String> {
    let chars: Vec<char> = phonemes.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
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
            let rank = match c {
                '.' | '!' | '?' => 3,
                ',' | ';' | ':' => 2,
                ' ' => 1,
                _ => 0,
            };
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
    use super::*;

    fn letters(g2p: &G2P, word: &str) -> String {
        g2p.g2p(word).unwrap().0
    }

    #[test]
    fn every_listed_word_reads_as_its_respelling_not_its_letters() {
        let p = Phonemizer::new();
        let plain = G2P::new(Language::EnglishUS);
        for (word, respelling) in WORDS {
            let said = p.phonemes(word).unwrap();
            assert_eq!(said.trim(), plain.g2p(respelling).unwrap().0.trim(), "{word}");
            assert_ne!(said.trim(), letters(&plain, word).trim(), "{word} is still spelled");
        }
        assert_eq!(p.phonemes("JSON").unwrap().trim(), plain.g2p("Jason").unwrap().0.trim());
    }

    #[test]
    fn an_identifier_reads_as_its_words() {
        let p = Phonemizer::new();
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
    fn a_long_paragraph_splits_into_pieces_under_the_cap_that_keep_every_token() {
        let p = Phonemizer::new();
        let text = "The store reads each block in turn, and the chip shows the speed. ".repeat(16);
        assert!(text.len() > 1_000);
        let ph = p.phonemes(&text).unwrap();
        let is_token = |c: char| !c.is_whitespace();
        let pieces = split(&ph, is_token, 150);
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
