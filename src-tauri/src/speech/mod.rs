// The model loads on the first read and is dropped after five idle minutes:
// it holds about 2 GB while loaded, too much to keep for a feature used now
// and then.

mod kokoro;
mod queue;
mod text;

use std::num::NonZero;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rodio::buffer::SamplesBuffer;
use rodio::{DeviceSinkBuilder, MixerDeviceSink, Player};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use queue::{Engine, Models, Out};

const DEFAULT_VOICE: &str = "af_heart";

const MODELS: [(&str, &str); 2] = [("int8", "model_quantized.onnx"), ("full", "model.onnx")];

pub fn dir() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("TORI_SPEECH_DIR") {
        return dir.into();
    }
    dirs::data_dir().unwrap_or_default().join("tori/speech")
}

fn installed(dir: &Path) -> Option<(&'static str, &'static str)> {
    if !dir.join("tokenizer.json").is_file() {
        return None;
    }
    MODELS.into_iter().find(|(_, file)| dir.join(file).is_file())
}

#[derive(Default)]
pub struct SpeechState(OnceLock<Engine>);

impl SpeechState {
    fn engine(&self, app: &AppHandle) -> &Engine {
        self.0.get_or_init(|| {
            let app = app.clone();
            let models = Models::new(Box::new(|| {
                let dir = dir();
                let (_, model) = installed(&dir).ok_or("No voice is downloaded")?;
                kokoro::load(&dir, &dir.join(model))
            }));
            let emit = Arc::new(move |event: queue::Event| {
                let _ = app.emit("speech", event);
            });
            Engine::start(models, Arc::new(Speakers::default()), emit, Duration::from_secs(30))
        })
    }
}

pub fn stop(app: &AppHandle) {
    if let Some(engine) = app.try_state::<SpeechState>().as_ref().and_then(|s| s.0.get()) {
        engine.stop();
    }
}

#[derive(Default)]
struct Speakers(Mutex<Option<(MixerDeviceSink, Arc<Player>)>>);

impl Out for Speakers {
    fn play(&self, samples: Vec<f32>, stale: &dyn Fn() -> bool) -> Result<(), String> {
        let player = {
            let mut device = self.0.lock().unwrap();
            if stale() {
                return Ok(());
            }
            if device.is_none() {
                let mut sink = DeviceSinkBuilder::open_default_sink().map_err(|e| format!("no audio output: {e}"))?;
                sink.log_on_drop(false);
                let player = Arc::new(Player::connect_new(sink.mixer()));
                *device = Some((sink, player));
            }
            let player = device.as_ref().unwrap().1.clone();
            let mono = NonZero::new(1).unwrap();
            let rate = NonZero::new(kokoro::SAMPLE_RATE).unwrap();
            player.append(SamplesBuffer::new(mono, rate, samples));
            player
        };
        player.sleep_until_end();
        Ok(())
    }

    fn stop(&self) {
        if let Some((_, player)) = &*self.0.lock().unwrap() {
            player.stop();
        }
    }

    fn release(&self) {
        self.0.lock().unwrap().take();
    }
}

#[derive(Serialize)]
pub struct SpeechVoice {
    id: String,
    name: String,
    language: &'static str,
}

#[derive(Serialize)]
pub struct SpeechStatus {
    installed: bool,
    model: Option<&'static str>,
}

fn voices(dir: &Path) -> Vec<SpeechVoice> {
    let Ok(entries) = std::fs::read_dir(dir.join("voices")) else {
        return Vec::new();
    };
    let mut out: Vec<SpeechVoice> = entries
        .filter_map(|e| {
            let id = e.ok()?.path().file_stem()?.to_str()?.to_string();
            let (accent, name) = id.split_once('_')?;
            let language = match accent.chars().next()? {
                'a' => "en-US",
                'b' => "en-GB",
                _ => return None,
            };
            let mut name = name.chars();
            let name = name.next()?.to_uppercase().chain(name).collect();
            Some(SpeechVoice { id, name, language })
        })
        .collect();
    out.sort_by(|a, b| (a.language != "en-US", &a.name).cmp(&(b.language != "en-US", &b.name)));
    out
}

#[tauri::command]
pub fn speech_speak(
    app: AppHandle,
    state: State<SpeechState>,
    chunks: Vec<String>,
    rate: f32,
    voice: Option<String>,
) -> Result<u64, String> {
    let dir = dir();
    installed(&dir).ok_or("No voice is downloaded")?;
    let voice = voice
        .filter(|v| dir.join("voices").join(format!("{v}.bin")).is_file())
        .unwrap_or_else(|| DEFAULT_VOICE.into());
    state.engine(&app).speak(chunks, rate.clamp(0.5, 2.0), voice)
}

#[tauri::command]
pub fn speech_stop(state: State<SpeechState>) {
    if let Some(engine) = state.0.get() {
        engine.stop();
    }
}

#[tauri::command]
pub fn speech_voices() -> Vec<SpeechVoice> {
    voices(&dir())
}

#[tauri::command]
pub fn speech_status() -> SpeechStatus {
    let model = installed(&dir()).map(|(size, _)| size);
    SpeechStatus {
        installed: model.is_some(),
        model,
    }
}
