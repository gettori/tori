// A clip is cut at its quietest gaps into pieces under PIECE before an engine
// sees it: Moonshine's decoder has 512 positions, about 78 s of speech, and
// Parakeet's export attends over the whole clip at once.

pub(super) mod moonshine;
pub(super) mod parakeet;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::queue::Models;

pub const SAMPLE_RATE: usize = 16_000;
pub const PIECE: usize = 50 * SAMPLE_RATE;
const FRAME: usize = SAMPLE_RATE / 50;
const SHORTEST: usize = SAMPLE_RATE / 10;

pub trait Transcriber: Send {
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, String>;
}

type Loader = Box<dyn Fn() -> Result<Box<dyn Transcriber>, String> + Send>;

pub fn dir() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("TORI_DICTATION_DIR") {
        return dir.into();
    }
    dirs::data_dir().unwrap_or_default().join("tori/dictation")
}

pub fn load(dir: &Path) -> Result<Box<dyn Transcriber>, String> {
    if dir.join(moonshine::ENCODER).is_file() {
        Ok(Box::new(moonshine::load(dir)?))
    } else if dir.join(parakeet::ENCODER).is_file() {
        Ok(Box::new(parakeet::load(dir)?))
    } else {
        Err("No dictation model is downloaded".into())
    }
}

pub struct Dictation {
    models: Mutex<Models<Box<dyn Transcriber>>>,
}

impl Dictation {
    pub fn new(load: Loader, model_generation: Arc<AtomicU64>) -> Self {
        Dictation {
            models: Mutex::new(Models::new(load, model_generation)),
        }
    }

    pub fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        self.transcribe_at(samples, Instant::now())
    }

    fn transcribe_at(&self, samples: &[f32], now: Instant) -> Result<String, String> {
        let mut models = self.models.lock().unwrap();
        models.sweep(now);
        let engine = models.get(now)?;
        let mut text = String::new();
        for piece in pieces(samples, PIECE) {
            if piece.len() < SHORTEST {
                continue;
            }
            let said = engine.transcribe(piece)?;
            let said = said.trim();
            if said.is_empty() {
                continue;
            }
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(said);
        }
        Ok(text)
    }

    // A held lock is a transcription in progress, so the model is not idle.
    pub fn sweep(&self, now: Instant) {
        if let Ok(mut models) = self.models.try_lock() {
            models.sweep(now);
        }
    }
}

pub fn pieces(samples: &[f32], cap: usize) -> Vec<&[f32]> {
    let half = (cap / 2).max(1);
    let mut out = Vec::new();
    let mut start = 0;
    while samples.len() - start > cap {
        let cut = start + half + quietest(&samples[start + half..start + cap]);
        out.push(&samples[start..cut]);
        start = cut;
    }
    out.push(&samples[start..]);
    out
}

fn quietest(window: &[f32]) -> usize {
    let energy = |at: &usize| window[*at..*at + FRAME].iter().map(|s| s * s).sum::<f32>();
    (0..window.len() / FRAME)
        .map(|i| i * FRAME)
        .min_by(|a, b| energy(a).total_cmp(&energy(b)))
        .unwrap_or(0)
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::atomic::Ordering;

    use super::super::queue::IDLE;
    use super::*;

    pub fn tone(seconds: f32) -> Vec<f32> {
        (0..(seconds * SAMPLE_RATE as f32) as usize)
            .map(|i| 0.3 * (i as f32 * 0.3).sin())
            .collect()
    }

    pub fn silence(seconds: f32) -> Vec<f32> {
        vec![0.0; (seconds * SAMPLE_RATE as f32) as usize]
    }

    pub fn wav(path: &str) -> Vec<f32> {
        let bytes = std::fs::read(path).unwrap();
        let mut at = 12;
        let mut samples = Vec::new();
        while at + 8 <= bytes.len() {
            let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            let body = &bytes[at + 8..at + 8 + size];
            match &bytes[at..at + 4] {
                b"fmt " => {
                    let channels = u16::from_le_bytes([body[2], body[3]]);
                    let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                    let bits = u16::from_le_bytes([body[14], body[15]]);
                    assert_eq!(
                        (channels, rate, bits),
                        (1, 16_000, 16),
                        "{path} must be 16 kHz mono 16 bit"
                    );
                }
                b"data" => {
                    samples = body
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|b| i16::from_le_bytes(*b) as f32 / 32768.0)
                        .collect()
                }
                _ => {}
            }
            at += 8 + size + size % 2;
        }
        samples
    }

    pub fn clip(engine: &str) -> (Vec<f32>, Option<String>) {
        let path = std::env::var("TORI_DICTATION_CLIP").unwrap();
        let said = std::fs::read_to_string(Path::new(&path).with_extension(format!("{engine}.txt")));
        (wav(&path), said.ok().map(|s| s.trim().to_string()))
    }

    #[test]
    fn a_long_clip_is_cut_in_its_silences_into_pieces_under_the_cap() {
        let cap = 8 * SAMPLE_RATE;
        let mut clip = Vec::new();
        for _ in 0..3 {
            clip.extend(tone(5.0));
            clip.extend(silence(0.4));
        }
        clip.extend(tone(2.0));
        let pieces = pieces(&clip, cap);
        assert_eq!(pieces.len(), 3);
        assert_eq!(pieces.iter().map(|p| p.len()).sum::<usize>(), clip.len());
        let mut at = 0;
        for piece in &pieces[..2] {
            assert!(piece.len() < cap);
            at += piece.len();
            assert!(
                clip[at..at + FRAME].iter().all(|s| *s == 0.0),
                "cut at {at} is inside speech"
            );
        }
        assert!(pieces[2].len() <= cap);
    }

    #[test]
    fn a_short_clip_is_one_piece() {
        let clip = tone(3.0);
        let pieces = pieces(&clip, 8 * SAMPLE_RATE);
        assert_eq!(pieces, [clip.as_slice()]);
        assert_eq!(super::pieces(&[], 8 * SAMPLE_RATE), [&[0.0f32; 0][..]]);
    }

    struct Seconds;

    impl Transcriber for Seconds {
        fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
            Ok(format!("{}s", samples.len() / SAMPLE_RATE))
        }
    }

    #[test]
    fn the_model_is_dropped_after_the_idle_window_and_loaded_again_by_the_next_call() {
        let loads = Arc::new(AtomicU64::new(0));
        let counter = loads.clone();
        let load: Loader = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(Seconds))
        });
        let dictation = Dictation::new(load, Arc::default());
        let t0 = Instant::now();
        dictation.transcribe_at(&tone(1.0), t0).unwrap();
        dictation.transcribe_at(&tone(1.0), t0 + IDLE / 2).unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        dictation.sweep(t0 + IDLE / 2 + IDLE);
        dictation.transcribe_at(&tone(1.0), t0 + 2 * IDLE).unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }
}
