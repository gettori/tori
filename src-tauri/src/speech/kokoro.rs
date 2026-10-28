use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ort::session::Session;
use ort::value::Tensor;

use super::queue::Voice;
use super::text::{split, Phonemizer};

pub const SAMPLE_RATE: u32 = 24_000;

// Kokoro takes 510 tokens a pass, but memory grows with the pass: 150 keeps
// a read near 2 GB where full 510 token passes peak at 3.
const PIECE_TOKENS: usize = 150;

// The first piece of a read is synthesised before anything plays, and its
// time grows with its length, so it ends at a clause break early on.
const OPENING_TOKENS: usize = 60;
const STYLE_WIDTH: usize = 256;
const STYLE_ROWS: usize = 510;

pub struct Kokoro {
    session: Session,
    vocab: HashMap<char, i64>,
    text: Phonemizer,
    voices: PathBuf,
    styles: HashMap<String, Vec<f32>>,
}

pub fn load(dir: &Path, model: &Path) -> Result<Kokoro, String> {
    let fail = |what: &str, e: &dyn std::fmt::Display| format!("{what}: {e}");
    let tokenizer = std::fs::read_to_string(dir.join("tokenizer.json")).map_err(|e| fail("tokenizer", &e))?;
    let tokenizer: serde_json::Value = serde_json::from_str(&tokenizer).map_err(|e| fail("tokenizer", &e))?;
    let vocab = tokenizer["model"]["vocab"]
        .as_object()
        .ok_or("tokenizer has no vocab")?
        .iter()
        .filter_map(|(k, v)| Some((single(k)?, v.as_i64()?)))
        .collect();
    let env = ort::init()
        .with_execution_providers([ort::ep::CPU::default().build()])
        .build()
        .map_err(|e| fail("runtime", &e))?;
    let session = Session::builder(&env)
        .map_err(|e| fail("runtime", &e))?
        .commit_from_file(model)
        .map_err(|e| fail("model", &e))?;
    Ok(Kokoro {
        session,
        vocab,
        text: Phonemizer::new(),
        voices: dir.join("voices"),
        styles: HashMap::new(),
    })
}

fn single(s: &str) -> Option<char> {
    let mut chars = s.chars();
    chars.next().filter(|_| chars.next().is_none())
}

impl Kokoro {
    fn style(&mut self, voice: &str, tokens: usize) -> Result<&[f32], String> {
        if !self.styles.contains_key(voice) {
            let bytes =
                std::fs::read(self.voices.join(format!("{voice}.bin"))).map_err(|e| format!("voice {voice}: {e}"))?;
            if bytes.len() != STYLE_ROWS * STYLE_WIDTH * 4 {
                return Err(format!("voice {voice} is {} bytes", bytes.len()));
            }
            let floats = bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes(*b))
                .collect();
            self.styles.insert(voice.into(), floats);
        }
        let row = tokens.min(STYLE_ROWS - 1) * STYLE_WIDTH;
        Ok(&self.styles[voice][row..row + STYLE_WIDTH])
    }
}

impl Voice for Kokoro {
    fn pieces(&mut self, text: &str, opening: bool) -> Result<Vec<String>, String> {
        let phonemes = self.text.phonemes(text)?;
        let first = if opening { OPENING_TOKENS } else { 0 };
        Ok(split(&phonemes, |c| self.vocab.contains_key(&c), PIECE_TOKENS, first))
    }

    fn synth(&mut self, piece: &str, voice: &str, rate: f32) -> Result<Vec<f32>, String> {
        let mut ids = vec![0i64];
        ids.extend(piece.chars().filter_map(|c| self.vocab.get(&c).copied()));
        ids.push(0);
        let style = self.style(voice, ids.len() - 2)?.to_vec();
        let input = |e: ort::Error| format!("input: {e}");
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, ids.len()], ids)).map_err(input)?,
                "style" => Tensor::from_array(([1usize, STYLE_WIDTH], style)).map_err(input)?,
                "speed" => Tensor::from_array(([1usize], vec![rate])).map_err(input)?,
            ])
            .map_err(|e| format!("synthesis: {e}"))?;
        let (_, audio) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("synthesis: {e}"))?;
        Ok(audio.to_vec())
    }
}
