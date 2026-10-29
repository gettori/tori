use std::path::Path;

use ort::session::Session;
use ort::value::{DynValue, Tensor};

use super::super::runtime;
use super::Transcriber;

pub const ENCODER: &str = "encoder-model.int8.onnx";
pub const DECODER: &str = "decoder_joint-model.int8.onnx";
pub const FEATURES: &str = "nemo128.onnx";
pub const VOCAB: &str = "vocab.txt";

const WIDTH: usize = 1024;
const STATE: [usize; 3] = [2, 1, 640];
// NeMo's own ceiling on symbols emitted for one encoder frame.
const MAX_TOKENS_PER_STEP: usize = 10;

pub struct Model {
    features: Session,
    encoder: Session,
    joint: Session,
    vocab: Vec<String>,
    blank: usize,
}

pub fn load(dir: &Path) -> Result<Model, String> {
    let text = std::fs::read_to_string(dir.join(VOCAB)).map_err(|e| format!("vocab: {e}"))?;
    let (vocab, blank) = vocab(&text)?;
    Ok(Model {
        features: runtime::session(&dir.join(FEATURES))?,
        encoder: runtime::session(&dir.join(ENCODER))?,
        joint: runtime::session(&dir.join(DECODER))?,
        vocab,
        blank,
    })
}

fn vocab(text: &str) -> Result<(Vec<String>, usize), String> {
    let mut entries = Vec::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let (token, id) = line
            .rsplit_once(' ')
            .ok_or_else(|| format!("vocab: bad line {line:?}"))?;
        let id: usize = id.parse().map_err(|_| format!("vocab: bad line {line:?}"))?;
        entries.push((id, token.replace('\u{2581}', " ")));
    }
    let size = entries.iter().map(|(id, _)| id + 1).max().unwrap_or(0);
    let mut out = vec![String::new(); size];
    for (id, token) in entries {
        out[id] = token;
    }
    let blank = out.iter().position(|t| t == "<blk>").ok_or("vocab has no <blk>")?;
    Ok((out, blank))
}

fn space_between_words(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if !c.is_whitespace() {
            out.push(c);
            continue;
        }
        let word_next = chars.peek().is_some_and(|n| n.is_alphanumeric() || *n == '_');
        if word_next && !out.is_empty() {
            out.push(' ');
        }
    }
    out
}

fn advance(skip: usize, token: usize, blank: usize, emitted: usize) -> usize {
    if skip > 0 || token == blank || emitted == MAX_TOKENS_PER_STEP {
        skip.max(1)
    } else {
        0
    }
}

fn greedy<S>(
    frames: usize,
    blank: usize,
    start: S,
    mut step: impl FnMut(usize, usize, &S) -> Result<(usize, usize, S), String>,
) -> Result<Vec<usize>, String> {
    let mut tokens = Vec::new();
    let mut state = start;
    let (mut t, mut emitted) = (0, 0);
    while t < frames {
        let last = tokens.last().copied().unwrap_or(blank);
        let (token, skip, next) = step(t, last, &state)?;
        if token != blank {
            state = next;
            tokens.push(token);
            emitted += 1;
        }
        let by = advance(skip, token, blank, emitted);
        if by > 0 {
            t += by;
            emitted = 0;
        }
    }
    Ok(tokens)
}

fn argmax(row: &[f32]) -> usize {
    row.iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map_or(0, |(i, _)| i)
}

fn zero_state() -> Result<DynValue, String> {
    Tensor::<f32>::from_array((STATE, vec![0.0; STATE.iter().product()]))
        .map(|t| t.into_dyn())
        .map_err(|e| format!("input: {e}"))
}

impl Transcriber for Model {
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
        let input = |e: ort::Error| format!("input: {e}");
        let (features, lengths) = {
            let mut outputs = self
                .features
                .run(ort::inputs![
                    "waveforms" => Tensor::from_array(([1usize, samples.len()], samples.to_vec())).map_err(input)?,
                    "waveforms_lens" => Tensor::from_array(([1usize], vec![samples.len() as i64])).map_err(input)?,
                ])
                .map_err(|e| format!("features: {e}"))?;
            (
                outputs.remove("features").ok_or("no features")?,
                outputs.remove("features_lens").ok_or("no feature length")?,
            )
        };
        let (encoded, frames) = {
            let outputs = self
                .encoder
                .run(ort::inputs!["audio_signal" => features, "length" => lengths])
                .map_err(|e| format!("encoder: {e}"))?;
            let (shape, data) = outputs["outputs"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("encoder: {e}"))?;
            let (_, lengths) = outputs["encoded_lengths"]
                .try_extract_tensor::<i64>()
                .map_err(|e| format!("encoder: {e}"))?;
            let frames = (lengths[0].max(0) as usize).min(shape[2] as usize);
            (data.to_vec(), frames)
        };
        let stride = encoded.len() / WIDTH.max(1);
        let joint = &mut self.joint;
        let vocab_size = self.vocab.len();
        let tokens = greedy(frames, self.blank, (zero_state()?, zero_state()?), |t, last, state| {
            let column: Vec<f32> = (0..WIDTH).map(|c| encoded[c * stride + t]).collect();
            let mut outputs = joint
                .run(ort::inputs![
                    "encoder_outputs" => Tensor::from_array(([1usize, WIDTH, 1], column)).map_err(input)?,
                    "targets" => Tensor::from_array(([1usize, 1], vec![last as i32])).map_err(input)?,
                    "target_length" => Tensor::from_array(([1usize], vec![1i32])).map_err(input)?,
                    "input_states_1" => &state.0,
                    "input_states_2" => &state.1,
                ])
                .map_err(|e| format!("decoder: {e}"))?;
            let (_, logits) = outputs["outputs"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("decoder: {e}"))?;
            if logits.len() <= vocab_size {
                return Err(format!("decoder gives {} scores for {vocab_size} tokens", logits.len()));
            }
            let token = argmax(&logits[..vocab_size]);
            let skip = argmax(&logits[vocab_size..]);
            let next = (
                outputs.remove("output_states_1").ok_or("decoder gave no state")?,
                outputs.remove("output_states_2").ok_or("decoder gave no state")?,
            );
            Ok((token, skip, next))
        })?;
        let text: String = tokens.iter().map(|t| self.vocab[*t].as_str()).collect();
        Ok(space_between_words(&text))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    #[test]
    fn the_tdt_loop_skips_by_the_duration_and_keeps_the_state_of_emitted_tokens() {
        let blank = 9;
        let mut calls = Vec::new();
        let per_call = [(1, 0), (blank, 2), (2, 1), (blank, 0), (3, 0), (blank, 1)];
        let tokens = greedy(5, blank, 0, |t, last, state| {
            let (token, skip) = per_call[calls.len()];
            calls.push((t, last, *state));
            Ok((token, skip, state + 1))
        })
        .unwrap();
        assert_eq!(tokens, [1, 2, 3]);
        assert_eq!(
            calls,
            [(0, blank, 0), (0, 1, 1), (2, 1, 1), (3, 2, 2), (4, 2, 2), (4, 3, 3)]
        );
    }

    #[test]
    #[ignore = "needs the Parakeet files at TORI_PARAKEET_DIR and a 16 kHz clip at TORI_DICTATION_CLIP"]
    fn the_real_model_transcribes_a_clip() {
        let dir = std::env::var("TORI_PARAKEET_DIR").unwrap();
        let (clip, said) = super::super::tests::clip("parakeet");
        let t0 = Instant::now();
        let mut model = load(Path::new(&dir)).unwrap();
        let loaded = t0.elapsed();
        let t1 = Instant::now();
        let text = model.transcribe(&clip).unwrap();
        println!(
            "parakeet: loaded in {loaded:?}, {:.1} s of audio in {:?}: {text:?}",
            clip.len() as f32 / super::super::SAMPLE_RATE as f32,
            t1.elapsed()
        );
        if let Some(said) = said {
            assert_eq!(text, said);
        }
    }
}
