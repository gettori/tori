use std::collections::HashMap;
use std::path::Path;

use regex::Regex;

use super::kokoro::{self, Config, Model, Styles, STYLE_WIDTH};

pub const MODEL: &str = "kitten_tts_nano_v0_8.onnx";
pub const VOICES_FILE: &str = "voices.npz";
pub const DEFAULT_VOICE: &str = "expr-voice-2-f";

const STYLE_ROWS: usize = 400;

pub const VOICES: &[(&str, &str, f32)] = &[
    ("expr-voice-2-f", "Bella", 0.8),
    ("expr-voice-2-m", "Jasper", 0.8),
    ("expr-voice-3-f", "Luna", 0.8),
    ("expr-voice-3-m", "Bruno", 0.8),
    ("expr-voice-4-f", "Rosie", 0.8),
    ("expr-voice-4-m", "Hugo", 0.9),
    ("expr-voice-5-f", "Kiki", 0.8),
    ("expr-voice-5-m", "Leo", 0.8),
];

const PRIORS: &[(&str, f32)] = &[
    ("expr-voice-2-f", 0.8),
    ("expr-voice-2-m", 0.8),
    ("expr-voice-3-f", 0.8),
    ("expr-voice-3-m", 0.8),
    ("expr-voice-4-f", 0.8),
    ("expr-voice-4-m", 0.9),
    ("expr-voice-5-f", 0.8),
    ("expr-voice-5-m", 0.8),
];

const SYMBOLS: &[&str] = &[
    "$",
    ";:,.!?\u{a1}\u{bf}\u{2014}\u{2026}\u{201c}\u{ab}\u{bb}\u{201d}\" ",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘\u{2019}\u{329}\u{2018}ᵻ",
];

// misaki writes some diphthongs and sounds as single letters that Kitten,
// trained on espeak's output, spells out.
const TO_KITTEN: &[(char, &str)] = &[
    ('A', "eɪ"),
    ('I', "aɪ"),
    ('O', "oʊ"),
    ('W', "aʊ"),
    ('Y', "ɔɪ"),
    ('Q', "əʊ"),
    ('T', "ɾ"),
    ('\u{1d4a}', "ə"),
    ('\u{200d}', ""),
];

pub fn vocab() -> HashMap<char, i64> {
    SYMBOLS
        .concat()
        .chars()
        .enumerate()
        .map(|(i, c)| (c, i as i64))
        .collect()
}

pub fn adapt(phonemes: &str) -> String {
    phonemes
        .chars()
        .map(|c| match TO_KITTEN.iter().find(|(from, _)| *from == c) {
            Some((_, to)) => (*to).to_string(),
            None => c.to_string(),
        })
        .collect()
}

pub fn load(dir: &Path) -> Result<Model, String> {
    let bytes = std::fs::read(dir.join(VOICES_FILE)).map_err(|e| format!("voices: {e}"))?;
    let styles = voices(&bytes)?;
    kokoro::open(
        &dir.join(MODEL),
        Config {
            vocab: vocab(),
            styles: Styles::Loaded(styles),
            rows: STYLE_ROWS,
            adapt,
            priors: PRIORS,
            trim: true,
        },
    )
}

// numpy's savez writes a stored zip of one npy file per voice, little enough
// format to read without a zip crate.
pub fn voices(npz: &[u8]) -> Result<HashMap<String, Vec<f32>>, String> {
    let shape = Regex::new(r"'shape': \((\d+), (\d+)\)").unwrap();
    let mut out = HashMap::new();
    for (name, data) in entries(npz)? {
        let name = name
            .strip_suffix(".npy")
            .ok_or_else(|| format!("voices: {name} is not npy"))?;
        if data.len() < 10 || &data[..6] != b"\x93NUMPY" {
            return Err(format!("voices: {name} is not an npy file"));
        }
        let header_len = u16::from_le_bytes([data[8], data[9]]) as usize;
        let header = String::from_utf8_lossy(&data[10..10 + header_len]);
        let dims = shape
            .captures(&header)
            .ok_or_else(|| format!("voices: {name} has no shape"))?;
        let rows: usize = dims[1].parse().unwrap();
        let width: usize = dims[2].parse().unwrap();
        let body = &data[10 + header_len..];
        if !header.contains("'<f4'") || rows != STYLE_ROWS || width != STYLE_WIDTH || body.len() != rows * width * 4 {
            return Err(format!("voices: {name} is {header}"));
        }
        out.insert(name.to_string(), kokoro::floats(body));
    }
    Ok(out)
}

fn u16_at(b: &[u8], at: usize) -> usize {
    u16::from_le_bytes([b[at], b[at + 1]]) as usize
}

fn u32_at(b: &[u8], at: usize) -> usize {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as usize
}

// Walks the central directory, so the sizes are right even when a local
// header left them for a trailing descriptor.
fn entries(zip: &[u8]) -> Result<Vec<(String, &[u8])>, String> {
    let bad = || "voices: not a zip file".to_string();
    let end = zip.len().checked_sub(22).ok_or_else(bad)?;
    let eocd = (0..=end)
        .rev()
        .find(|&i| zip[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(bad)?;
    let count = u16_at(zip, eocd + 10);
    let mut at = u32_at(zip, eocd + 16);
    let mut out = Vec::new();
    for _ in 0..count {
        if zip.len() < at + 46 || zip[at..at + 4] != [0x50, 0x4b, 0x01, 0x02] {
            return Err(bad());
        }
        let method = u16_at(zip, at + 10);
        let size = u32_at(zip, at + 24);
        let name_len = u16_at(zip, at + 28);
        let extra_len = u16_at(zip, at + 30);
        let comment_len = u16_at(zip, at + 32);
        let local = u32_at(zip, at + 42);
        let name = String::from_utf8_lossy(&zip[at + 46..at + 46 + name_len]).into_owned();
        if method != 0 {
            return Err(format!("voices: {name} is compressed"));
        }
        if zip.len() < local + 30 || zip[local..local + 4] != [0x50, 0x4b, 0x03, 0x04] {
            return Err(bad());
        }
        let start = local + 30 + u16_at(zip, local + 26) + u16_at(zip, local + 28);
        let data = zip.get(start..start + size).ok_or_else(bad)?;
        out.push((name, data));
        at += 46 + name_len + extra_len + comment_len;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::text::Phonemizer;

    fn stored_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = Vec::new();
        let mut central = Vec::new();
        for (name, data) in files {
            let local = zip.len() as u32;
            let (n, s) = (name.len() as u16, data.len() as u32);
            zip.extend([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            zip.extend(s.to_le_bytes());
            zip.extend(s.to_le_bytes());
            zip.extend(n.to_le_bytes());
            zip.extend([0, 0]);
            zip.extend(name.as_bytes());
            zip.extend(*data);
            central.extend([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend(s.to_le_bytes());
            central.extend(s.to_le_bytes());
            central.extend(n.to_le_bytes());
            central.extend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend(local.to_le_bytes());
            central.extend(name.as_bytes());
        }
        let (offset, size) = (zip.len() as u32, central.len() as u32);
        zip.extend(central);
        zip.extend([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
        zip.extend((files.len() as u16).to_le_bytes());
        zip.extend((files.len() as u16).to_le_bytes());
        zip.extend(size.to_le_bytes());
        zip.extend(offset.to_le_bytes());
        zip.extend([0, 0]);
        zip
    }

    fn npy(rows: usize, fill: f32) -> Vec<u8> {
        let header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': ({rows}, {STYLE_WIDTH}), }}");
        let mut out = b"\x93NUMPY\x01\x00".to_vec();
        out.extend((header.len() as u16).to_le_bytes());
        out.extend(header.as_bytes());
        for _ in 0..rows * STYLE_WIDTH {
            out.extend(fill.to_le_bytes());
        }
        out
    }

    #[test]
    fn a_voices_npz_reads_into_one_style_table_per_voice() {
        let zip = stored_zip(&[
            ("expr-voice-2-f.npy", &npy(STYLE_ROWS, 0.5)),
            ("expr-voice-2-m.npy", &npy(STYLE_ROWS, -1.0)),
        ]);
        let styles = voices(&zip).unwrap();
        assert_eq!(styles.len(), 2);
        assert_eq!(styles["expr-voice-2-f"].len(), STYLE_ROWS * STYLE_WIDTH);
        assert_eq!(styles["expr-voice-2-m"][STYLE_ROWS * STYLE_WIDTH - 1], -1.0);

        let short = stored_zip(&[("expr-voice-2-f.npy", &npy(3, 0.0))]);
        assert!(voices(&short).unwrap_err().contains("shape"));
        assert!(voices(b"not a zip").unwrap_err().contains("not a zip"));
    }

    #[test]
    #[ignore = "needs a real voices.npz at TORI_KITTEN_VOICES"]
    fn the_real_voices_npz_reads_into_eight_styles() {
        let bytes = std::fs::read(std::env::var("TORI_KITTEN_VOICES").unwrap()).unwrap();
        let styles = voices(&bytes).unwrap();
        let mut names: Vec<&str> = styles.keys().map(String::as_str).collect();
        names.sort();
        let mut expected: Vec<&str> = VOICES.iter().map(|(id, _, _)| *id).collect();
        expected.sort();
        assert_eq!(names, expected);
        assert!(styles.values().all(|s| s.len() == STYLE_ROWS * STYLE_WIDTH));
    }

    #[test]
    fn every_symbol_misaki_emits_for_dev_text_maps_into_kittens_vocabulary() {
        let p = Phonemizer::with_espeak(Box::new(|_| None));
        let text = "The fix is in src/utils/speech.ts, next to the store! Does the chip show the speed? \
            It reads 3.4.2 -> 3.5.0, a 107 MB download, LCTRL / TAB, Kokoro and omnibox; \
            yes, this is how a reply will sound when Tori reads it to you, with Jason and tsconfig.";
        let vocab = vocab();
        let phonemes = adapt(&p.phonemes(text).unwrap());
        let missing: Vec<char> = phonemes.chars().filter(|c| !vocab.contains_key(c)).collect();
        assert!(missing.is_empty(), "not in the Kitten vocabulary: {missing:?}");
        assert_eq!(adapt("hˈA"), "hˈeɪ");
    }
}
