use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use ort::environment::Environment;
use ort::session::builder::AutoDevicePolicy;
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
pub const STYLE_WIDTH: usize = 256;
const STYLE_ROWS: usize = 510;

// Kitten leaves 700 to 825 ms of silence before a piece and 150 to 210 ms
// after it, measured on three replies; Kokoro's own 300 and 500 ms are kept.
const KEEP_LEAD: usize = 2_400;
const KEEP_TAIL: usize = 3_600;
const QUIET: f32 = 0.01;

pub enum Styles {
    Dir {
        dir: PathBuf,
        cache: HashMap<String, Vec<f32>>,
    },
    Loaded(HashMap<String, Vec<f32>>),
}

pub struct Model {
    session: Session,
    vocab: HashMap<char, i64>,
    text: Phonemizer,
    styles: Styles,
    rows: usize,
    adapt: fn(&str) -> String,
    priors: &'static [(&'static str, f32)],
    trim: bool,
}

pub struct Config {
    pub vocab: HashMap<char, i64>,
    pub styles: Styles,
    pub rows: usize,
    pub adapt: fn(&str) -> String,
    pub priors: &'static [(&'static str, f32)],
    pub trim: bool,
}

pub fn load(dir: &Path, model: &Path) -> Result<Model, String> {
    let fail = |what: &str, e: &dyn std::fmt::Display| format!("{what}: {e}");
    let tokenizer = std::fs::read_to_string(dir.join("tokenizer.json")).map_err(|e| fail("tokenizer", &e))?;
    let tokenizer: serde_json::Value = serde_json::from_str(&tokenizer).map_err(|e| fail("tokenizer", &e))?;
    let vocab = tokenizer["model"]["vocab"]
        .as_object()
        .ok_or("tokenizer has no vocab")?
        .iter()
        .filter_map(|(k, v)| Some((single(k)?, v.as_i64()?)))
        .collect();
    open(
        model,
        Config {
            vocab,
            styles: Styles::Dir {
                dir: dir.join("voices"),
                cache: HashMap::new(),
            },
            rows: STYLE_ROWS,
            adapt: str::to_string,
            priors: &[],
            trim: false,
        },
    )
}

// ONNX Runtime allows one environment per process, and a model is loaded
// again after every idle drop or size switch.
static ENV: OnceLock<Environment> = OnceLock::new();

fn environment() -> Result<&'static Environment, String> {
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let env = ort::init()
        .with_execution_providers([ort::ep::CPU::default().build()])
        .build()
        .map_err(|e| format!("runtime: {e}"))?;
    Ok(ENV.get_or_init(|| env))
}

pub fn open(model: &Path, config: Config) -> Result<Model, String> {
    let fail = |what: &str, e: &dyn std::fmt::Display| format!("{what}: {e}");
    let env = environment()?;
    // ort's default policy registers CoreML on a Mac, which compiles the
    // graph on every load (5 s here) and then runs it slower than the CPU.
    let session = Session::builder(env)
        .map_err(|e| fail("runtime", &e))?
        .with_auto_device(AutoDevicePolicy::PreferCPU)
        .map_err(|e| fail("runtime", &e))?
        .commit_from_file(model)
        .map_err(|e| fail("model", &e))?;
    Ok(Model {
        session,
        vocab: config.vocab,
        text: Phonemizer::new(),
        styles: config.styles,
        rows: config.rows,
        adapt: config.adapt,
        priors: config.priors,
        trim: config.trim,
    })
}

fn single(s: &str) -> Option<char> {
    let mut chars = s.chars();
    chars.next().filter(|_| chars.next().is_none())
}

pub fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

fn trimmed(audio: Vec<f32>) -> Vec<f32> {
    let loud = |s: &f32| s.abs() > QUIET;
    let Some(first) = audio.iter().position(loud) else {
        return audio;
    };
    let last = audio.iter().rposition(loud).unwrap();
    let start = first.saturating_sub(KEEP_LEAD);
    let end = (last + 1 + KEEP_TAIL).min(audio.len());
    audio[start..end].to_vec()
}

impl Model {
    fn style(&mut self, voice: &str, tokens: usize) -> Result<&[f32], String> {
        let row = tokens.min(self.rows - 1) * STYLE_WIDTH;
        let rows = self.rows;
        let table = match &mut self.styles {
            Styles::Loaded(map) => map.get(voice).ok_or_else(|| format!("no voice {voice}"))?,
            Styles::Dir { dir, cache } => {
                if !cache.contains_key(voice) {
                    let bytes =
                        std::fs::read(dir.join(format!("{voice}.bin"))).map_err(|e| format!("voice {voice}: {e}"))?;
                    if bytes.len() != rows * STYLE_WIDTH * 4 {
                        return Err(format!("voice {voice} is {} bytes", bytes.len()));
                    }
                    cache.insert(voice.to_string(), floats(&bytes));
                }
                &cache[voice]
            }
        };
        Ok(&table[row..row + STYLE_WIDTH])
    }
}

impl Voice for Model {
    fn pieces(&mut self, text: &str, opening: bool) -> Result<Vec<String>, String> {
        let phonemes = (self.adapt)(&self.text.phonemes(text)?);
        let first = if opening { OPENING_TOKENS } else { 0 };
        Ok(split(&phonemes, |c| self.vocab.contains_key(&c), PIECE_TOKENS, first))
    }

    fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }

    fn synth(&mut self, piece: &str, voice: &str, rate: f32) -> Result<Vec<f32>, String> {
        let mut ids = vec![0i64];
        ids.extend(piece.chars().filter_map(|c| self.vocab.get(&c).copied()));
        ids.push(0);
        let style = self.style(voice, ids.len() - 2)?.to_vec();
        let prior = self.priors.iter().find(|(v, _)| *v == voice).map_or(1.0, |(_, p)| *p);
        let input = |e: ort::Error| format!("input: {e}");
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, ids.len()], ids)).map_err(input)?,
                "style" => Tensor::from_array(([1usize, STYLE_WIDTH], style)).map_err(input)?,
                "speed" => Tensor::from_array(([1usize], vec![rate * prior])).map_err(input)?,
            ])
            .map_err(|e| format!("synthesis: {e}"))?;
        let (_, audio) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("synthesis: {e}"))?;
        let audio = audio.to_vec();
        Ok(if self.trim { trimmed(audio) } else { audio })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trimming_keeps_a_short_margin_of_silence_at_each_end() {
        let mut audio = vec![0.0; 20_000];
        audio.extend(vec![0.5; 1_000]);
        audio.extend(vec![0.0; 10_000]);
        let out = trimmed(audio);
        assert_eq!(out.len(), KEEP_LEAD + 1_000 + KEEP_TAIL);
        assert_eq!(trimmed(vec![0.0; 100]).len(), 100);
    }
}
