use std::path::Path;

use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, Tensor};

use super::super::models::moonshine::{DECODER, ENCODER, TOKENIZER};
use super::super::runtime;
use super::{Transcriber, SAMPLE_RATE};

const START: i64 = 1;
const END: i64 = 2;
const LAYERS: usize = 8;
const HEADS: usize = 8;
const HEAD_WIDTH: usize = 52;
const POSITIONS: usize = 512;
// Moonshine's own generation budget per second of audio.
const TOKENS_PER_SECOND: f32 = 6.5;

enum Piece {
    Text(String),
    Byte(u8),
    Special,
}

pub struct Model {
    encoder: Session,
    decoder: Session,
    vocab: Vec<Piece>,
    past: Vec<String>,
    present: Vec<String>,
}

pub fn load(dir: &Path) -> Result<Model, String> {
    let tokenizer = std::fs::read_to_string(dir.join(TOKENIZER)).map_err(|e| format!("tokenizer: {e}"))?;
    let mut past = Vec::new();
    let mut present = Vec::new();
    for layer in 0..LAYERS {
        for side in ["decoder", "encoder"] {
            for part in ["key", "value"] {
                past.push(format!("past_key_values.{layer}.{side}.{part}"));
                present.push(format!("present.{layer}.{side}.{part}"));
            }
        }
    }
    Ok(Model {
        encoder: runtime::session(&dir.join(ENCODER))?,
        decoder: runtime::session(&dir.join(DECODER))?,
        vocab: vocab(&tokenizer)?,
        past,
        present,
    })
}

fn vocab(tokenizer: &str) -> Result<Vec<Piece>, String> {
    let json: serde_json::Value = serde_json::from_str(tokenizer).map_err(|e| format!("tokenizer: {e}"))?;
    let base = json["model"]["vocab"].as_object().ok_or("tokenizer has no vocab")?;
    let added = json["added_tokens"].as_array().ok_or("tokenizer has no added tokens")?;
    let mut entries: Vec<(usize, Piece)> = base
        .iter()
        .filter_map(|(token, id)| Some((id.as_u64()? as usize, piece(token))))
        .collect();
    for token in added {
        let id = token["id"].as_u64().ok_or("added token without an id")? as usize;
        let content = token["content"].as_str().ok_or("added token without content")?;
        let piece = if token["special"].as_bool().unwrap_or(false) {
            Piece::Special
        } else {
            piece(content)
        };
        entries.retain(|(at, _)| *at != id);
        entries.push((id, piece));
    }
    let size = entries.iter().map(|(id, _)| id + 1).max().unwrap_or(0);
    let mut out: Vec<Piece> = (0..size).map(|_| Piece::Special).collect();
    for (id, piece) in entries {
        out[id] = piece;
    }
    Ok(out)
}

fn piece(token: &str) -> Piece {
    let byte = token
        .strip_prefix("<0x")
        .and_then(|rest| rest.strip_suffix('>'))
        .and_then(|hex| u8::from_str_radix(hex, 16).ok());
    match byte {
        Some(byte) => Piece::Byte(byte),
        None => Piece::Text(token.replace('\u{2581}', " ")),
    }
}

fn decode(vocab: &[Piece], ids: &[i64]) -> String {
    let mut bytes = Vec::new();
    for id in ids {
        match vocab.get(*id as usize) {
            Some(Piece::Text(text)) => bytes.extend_from_slice(text.as_bytes()),
            Some(Piece::Byte(byte)) => bytes.push(*byte),
            Some(Piece::Special) | None => {}
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    text.strip_prefix(' ').unwrap_or(&text).to_string()
}

fn budget(samples: usize) -> usize {
    let tokens = (samples as f32 / SAMPLE_RATE as f32 * TOKENS_PER_SECOND) as usize;
    tokens.clamp(1, POSITIONS - 1)
}

fn greedy(budget: usize, mut step: impl FnMut(i64, bool) -> Result<i64, String>) -> Result<Vec<i64>, String> {
    let mut ids = vec![START];
    let mut first = true;
    while ids.len() - 1 < budget {
        let next = step(*ids.last().unwrap(), first)?;
        first = false;
        if next == END {
            break;
        }
        ids.push(next);
    }
    Ok(ids[1..].to_vec())
}

fn argmax(row: &[f32]) -> i64 {
    row.iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map_or(END, |(i, _)| i as i64)
}

fn empty_cache() -> Result<Vec<DynValue>, String> {
    (0..LAYERS * 4)
        .map(|_| {
            Tensor::<f32>::from_array(([1usize, HEADS, 0, HEAD_WIDTH], Vec::new()))
                .map(|t| t.into_dyn())
                .map_err(|e| format!("input: {e}"))
        })
        .collect()
}

impl Transcriber for Model {
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
        let input = |e: ort::Error| format!("input: {e}");
        let hidden = {
            let mut outputs = self
                .encoder
                .run(ort::inputs![
                    "input_values" => Tensor::from_array(([1usize, samples.len()], samples.to_vec())).map_err(input)?,
                ])
                .map_err(|e| format!("encoder: {e}"))?;
            outputs
                .remove("last_hidden_state")
                .ok_or("encoder gave no hidden state")?
        };
        let mut cache = empty_cache()?;
        let (decoder, past, present) = (&mut self.decoder, &self.past, &self.present);
        let ids = greedy(budget(samples.len()), |last, first| {
            let mut inputs: Vec<(&str, SessionInputValue)> = vec![
                (
                    "input_ids",
                    Tensor::from_array(([1usize, 1], vec![last])).map_err(input)?.into(),
                ),
                ("encoder_hidden_states", (&hidden).into()),
                (
                    "use_cache_branch",
                    Tensor::from_array(([1usize], vec![!first])).map_err(input)?.into(),
                ),
            ];
            for (name, value) in past.iter().zip(&cache) {
                inputs.push((name.as_str(), value.into()));
            }
            let mut outputs = decoder.run(inputs).map_err(|e| format!("decoder: {e}"))?;
            let (shape, logits) = outputs["logits"]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("decoder: {e}"))?;
            let width = shape[2] as usize;
            let next = argmax(&logits[logits.len() - width..]);
            // The cache branch returns placeholders for the encoder's keys
            // and values, so those stay as the first step computed them.
            for (i, name) in present.iter().enumerate() {
                if first || name.contains(".decoder.") {
                    cache[i] = outputs.remove(name).ok_or_else(|| format!("decoder gave no {name}"))?;
                }
            }
            Ok(next)
        })?;
        Ok(decode(&self.vocab, &ids))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    #[test]
    fn ids_decode_through_the_vocab_with_byte_pieces_fused_into_utf8() {
        let tokenizer = r#"{
            "model": {"vocab": {"<unk>": 0, "<s>": 1, "</s>": 2, "<0xE2>": 3, "<0x82>": 4, "<0xAC>": 5,
                "▁caf": 6, "<0xC3>": 7, "<0xA9>": 8, "▁costs": 9, "▁5": 10, "▁naïve": 11}},
            "added_tokens": [
                {"id": 0, "content": "<unk>", "special": true},
                {"id": 1, "content": "<s>", "special": true},
                {"id": 2, "content": "</s>", "special": true},
                {"id": 12, "content": "<<ST_0>>", "special": true}
            ]
        }"#;
        let vocab = vocab(tokenizer).unwrap();
        assert_eq!(vocab.len(), 13);
        assert_eq!(
            decode(&vocab, &[6, 7, 8, 9, 10, 3, 4, 5, 12, 11, 99]),
            "café costs 5€ naïve"
        );
        assert_eq!(decode(&vocab, &[0, 1, 2]), "");
    }

    #[test]
    fn the_greedy_loop_stops_at_the_end_token_or_the_budget() {
        let mut fed = Vec::new();
        let ids = greedy(10, |last, first| {
            fed.push((last, first));
            Ok(match last {
                START => 7,
                7 => 8,
                _ => END,
            })
        })
        .unwrap();
        assert_eq!(ids, [7, 8]);
        assert_eq!(fed, [(START, true), (7, false), (8, false)]);

        let ids = greedy(3, |_, _| Ok(5)).unwrap();
        assert_eq!(ids, [5, 5, 5]);
    }

    #[test]
    #[ignore = "needs the Moonshine files at TORI_MOONSHINE_DIR and a 16 kHz clip at TORI_DICTATION_CLIP"]
    fn the_real_model_transcribes_a_clip() {
        let dir = std::env::var("TORI_MOONSHINE_DIR").unwrap();
        let (clip, said) = super::super::tests::clip("moonshine");
        let t0 = Instant::now();
        let mut model = load(Path::new(&dir)).unwrap();
        let loaded = t0.elapsed();
        let t1 = Instant::now();
        let text = model.transcribe(&clip).unwrap();
        println!(
            "moonshine: loaded in {loaded:?}, {:.1} s of audio in {:?}: {text:?}",
            clip.len() as f32 / SAMPLE_RATE as f32,
            t1.elapsed()
        );
        if let Some(said) = said {
            assert_eq!(text, said);
        }
    }
}
