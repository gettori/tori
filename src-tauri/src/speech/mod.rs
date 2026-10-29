// The model loads on the first read and is dropped after five idle minutes:
// it holds about 2 GB while loaded, too much to keep for a feature used now
// and then.

mod dictation;
mod download;
mod kitten;
mod kokoro;
mod queue;
mod runtime;
mod spoken;
mod text;

use std::num::NonZero;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rodio::buffer::SamplesBuffer;
use rodio::{DeviceSinkBuilder, MixerDeviceSink, Player};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use dictation::Dictation;
use queue::{Engine, Models, Out};

const DEFAULT_VOICE: &str = "af_heart";

fn default_voice(dir: &Path) -> &'static str {
    match installed(dir) {
        Some(("fast", _)) => kitten::DEFAULT_VOICE,
        _ => DEFAULT_VOICE,
    }
}

pub fn dir() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("TORI_SPEECH_DIR") {
        return dir.into();
    }
    dirs::data_dir().unwrap_or_default().join("tori/speech")
}

fn installed(dir: &Path) -> Option<(&'static str, &'static str)> {
    download::VOICE.installed(dir).map(|s| (s.id, s.file))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    size: &'static str,
    done: u64,
    total: u64,
}

struct Running {
    progress: Progress,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DownloadEvent {
    Progress(Progress),
    Done { size: &'static str },
    Cancel,
    Error { error: String },
}

type Slot = Arc<Mutex<Option<Running>>>;

pub struct SpeechState {
    engine: OnceLock<Engine>,
    model_generation: Arc<AtomicU64>,
    download: Slot,
    dictation: Arc<Dictation>,
    dictation_generation: Arc<AtomicU64>,
    dictation_download: Slot,
}

impl Default for SpeechState {
    fn default() -> Self {
        let load = Box::new(|| dictation::load(&dictation::dir()));
        let dictation_generation = Arc::new(AtomicU64::new(0));
        SpeechState {
            engine: OnceLock::new(),
            model_generation: Arc::default(),
            download: Arc::default(),
            dictation: Arc::new(Dictation::new(load, dictation_generation.clone())),
            dictation_generation,
            dictation_download: Arc::default(),
        }
    }
}

impl SpeechState {
    fn dictation_with_tick(&self, app: &AppHandle) -> &Dictation {
        self.engine(app);
        &self.dictation
    }

    fn engine(&self, app: &AppHandle) -> &Engine {
        self.engine.get_or_init(|| {
            let app = app.clone();
            let load = Box::new(|| {
                let dir = dir();
                let (size, model) = installed(&dir).ok_or("No voice is downloaded")?;
                if size == "fast" {
                    kitten::load(&dir)
                } else {
                    kokoro::load(&dir, &dir.join(model))
                }
            });
            let models = Models::new(load, self.model_generation.clone());
            let emit = Arc::new(move |event: queue::Event| {
                let _ = app.emit("speech", event);
            });
            let dictation = self.dictation.clone();
            let idle = Arc::new(move |now| dictation.sweep(now));
            Engine::start(
                models,
                Arc::new(Speakers::default()),
                emit,
                Duration::from_secs(30),
                idle,
            )
        })
    }
}

pub fn stop(app: &AppHandle) {
    if let Some(engine) = app.try_state::<SpeechState>().as_ref().and_then(|s| s.engine.get()) {
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
                let mut sink = open_sink().map_err(|e| format!("no audio output: {e}"))?;
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

// rodio asks for a fixed 2048 frame buffer, past what Bluetooth headphones
// accept (1024 at most), so the device's own buffer size is tried first.
fn open_sink() -> Result<MixerDeviceSink, rodio::DeviceSinkError> {
    DeviceSinkBuilder::from_default_device()
        .and_then(|b| b.with_buffer_size(rodio::cpal::BufferSize::Default).open_stream())
        .or_else(|_| DeviceSinkBuilder::open_default_sink())
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
    downloading: Option<Progress>,
    sizes: Vec<SizeInfo>,
    espeak: bool,
    brew: bool,
}

#[derive(Serialize)]
pub struct SizeInfo {
    id: &'static str,
    bytes: u64,
}

#[derive(Serialize)]
pub struct DictationStatus {
    installed: bool,
    model: Option<&'static str>,
    downloading: Option<Progress>,
    sizes: Vec<SizeInfo>,
}

fn sizes(set: &download::Set) -> Vec<SizeInfo> {
    set.sizes
        .iter()
        .map(|s| SizeInfo {
            id: s.id,
            bytes: set.manifest(s.id).unwrap().iter().map(|f| f.bytes).sum(),
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpeakError {
    NotDownloaded,
    Failed { error: String },
}

fn voices(dir: &Path) -> Vec<SpeechVoice> {
    if let Some(("fast", _)) = installed(dir) {
        return kitten::VOICES
            .iter()
            .map(|(id, name, _)| SpeechVoice {
                id: id.to_string(),
                name: name.to_string(),
                language: "en-US",
            })
            .collect();
    }
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
    pauses: Option<Vec<u32>>,
    rate: f32,
    voice: Option<String>,
) -> Result<u64, SpeakError> {
    let dir = dir();
    installed(&dir).ok_or(SpeakError::NotDownloaded)?;
    state
        .engine(&app)
        .speak(
            chunks,
            pauses.unwrap_or_default(),
            rate.clamp(0.5, 2.0),
            voice_or_default(&dir, voice),
        )
        .map_err(|error| SpeakError::Failed { error })
}

fn voice_or_default(dir: &Path, voice: Option<String>) -> String {
    let known = |v: &String| match installed(dir) {
        Some(("fast", _)) => kitten::VOICES.iter().any(|(id, _, _)| id == v),
        _ => dir.join("voices").join(format!("{v}.bin")).is_file(),
    };
    voice.filter(known).unwrap_or_else(|| default_voice(dir).into())
}

#[tauri::command]
pub fn speech_warm(app: AppHandle, state: State<SpeechState>) {
    if installed(&dir()).is_some() {
        state.engine(&app).warm();
    }
}

#[tauri::command]
pub fn speech_stop(state: State<SpeechState>) {
    if let Some(engine) = state.engine.get() {
        engine.stop();
    }
}

#[tauri::command]
pub fn speech_voices() -> Vec<SpeechVoice> {
    voices(&dir())
}

#[tauri::command]
pub fn speech_status(state: State<SpeechState>) -> SpeechStatus {
    let model = installed(&dir()).map(|(size, _)| size);
    SpeechStatus {
        installed: model.is_some(),
        model,
        downloading: state.download.lock().unwrap().as_ref().map(|r| r.progress.clone()),
        sizes: sizes(&download::VOICE),
        espeak: crate::env::resolve_binary("espeak-ng").is_some(),
        brew: crate::env::resolve_binary("brew").is_some(),
    }
}

struct Download {
    set: &'static download::Set,
    what: &'static str,
    event: &'static str,
    dir: fn() -> PathBuf,
}

const VOICE: Download = Download {
    set: &download::VOICE,
    what: "voice",
    event: "speech-download",
    dir,
};

const DICTATION: Download = Download {
    set: &download::DICTATION,
    what: "dictation model",
    event: "dictation-download",
    dir: dictation::dir,
};

fn begin(slot: &Mutex<Option<Running>>, what: &str, size: &'static str, total: u64) -> Result<Arc<AtomicBool>, String> {
    let mut slot = slot.lock().unwrap();
    if slot.is_some() {
        return Err(format!("A {what} is already downloading"));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *slot = Some(Running {
        progress: Progress { size, done: 0, total },
        cancel: cancel.clone(),
    });
    Ok(cancel)
}

fn start(which: Download, app: AppHandle, slot: &Slot, changed: &Arc<AtomicU64>, size: String) -> Result<(), String> {
    let size = which
        .set
        .size(&size)
        .map(|s| s.id)
        .ok_or_else(|| format!("no {} {size}", which.what))?;
    let files = which.set.manifest(size).unwrap();
    let cancel = begin(slot, which.what, size, files.iter().map(|f| f.bytes).sum())?;
    let running = slot.clone();
    let changed = changed.clone();
    std::thread::Builder::new()
        .name(which.event.into())
        .spawn(move || {
            let emit = |event: DownloadEvent| {
                let _ = app.emit(which.event, event);
            };
            let result = which.set.install(
                &(which.dir)(),
                &files,
                &download::fetch,
                &|| cancel.load(Ordering::SeqCst),
                &mut |done, total| {
                    let progress = Progress { size, done, total };
                    if let Some(running) = running.lock().unwrap().as_mut() {
                        running.progress = progress.clone();
                    }
                    emit(DownloadEvent::Progress(progress));
                },
            );
            running.lock().unwrap().take();
            match result {
                Ok(()) => {
                    changed.fetch_add(1, Ordering::SeqCst);
                    emit(DownloadEvent::Done { size });
                }
                Err(e) if e == download::CANCELLED => emit(DownloadEvent::Cancel),
                Err(error) => emit(DownloadEvent::Error { error }),
            }
        })
        .map_err(|e| {
            slot.lock().unwrap().take();
            e.to_string()
        })?;
    Ok(())
}

fn cancel(slot: &Slot) {
    if let Some(running) = slot.lock().unwrap().as_ref() {
        running.cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn speech_download(app: AppHandle, state: State<SpeechState>, size: String) -> Result<(), String> {
    start(VOICE, app, &state.download, &state.model_generation, size)
}

#[tauri::command]
pub fn speech_download_cancel(state: State<SpeechState>) {
    cancel(&state.download);
}

#[tauri::command]
pub fn speech_delete(state: State<SpeechState>) -> Result<(), String> {
    if state.download.lock().unwrap().is_some() {
        return Err("A voice is downloading".into());
    }
    if let Some(engine) = state.engine.get() {
        engine.stop();
    }
    download::VOICE.remove(&dir())?;
    state.model_generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn dictation_transcribe(app: AppHandle, state: State<SpeechState>, samples: Vec<f32>) -> Result<String, String> {
    state.dictation_with_tick(&app).transcribe(&samples)
}

#[tauri::command]
pub fn dictation_status(state: State<SpeechState>) -> DictationStatus {
    let model = download::DICTATION.installed(&dictation::dir()).map(|s| s.id);
    DictationStatus {
        installed: model.is_some(),
        model,
        downloading: state
            .dictation_download
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| r.progress.clone()),
        sizes: sizes(&download::DICTATION),
    }
}

#[tauri::command]
pub fn dictation_download(app: AppHandle, state: State<SpeechState>, size: String) -> Result<(), String> {
    start(
        DICTATION,
        app,
        &state.dictation_download,
        &state.dictation_generation,
        size,
    )
}

#[tauri::command]
pub fn dictation_download_cancel(state: State<SpeechState>) {
    cancel(&state.dictation_download);
}

#[tauri::command]
pub fn dictation_delete(state: State<SpeechState>) -> Result<(), String> {
    if state.dictation_download.lock().unwrap().is_some() {
        return Err("A dictation model is downloading".into());
    }
    download::DICTATION.remove(&dictation::dir())?;
    state.dictation_generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_download_is_refused_while_one_runs() {
        let slot = Mutex::new(None);
        begin(&slot, "voice", "int8", 10).unwrap();
        assert_eq!(
            begin(&slot, "voice", "full", 10).unwrap_err(),
            "A voice is already downloading"
        );
        slot.lock().unwrap().take();
        assert!(begin(&slot, "voice", "full", 10).is_ok());
    }

    #[test]
    fn a_voice_since_removed_falls_back_to_the_default() {
        let dir = std::env::temp_dir().join(format!("tori_speech_voice_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("voices")).unwrap();
        std::fs::write(dir.join("voices/bf_emma.bin"), []).unwrap();

        assert_eq!(voice_or_default(&dir, Some("bf_emma".into())), "bf_emma");
        assert_eq!(voice_or_default(&dir, Some("am_removed".into())), DEFAULT_VOICE);
        assert_eq!(voice_or_default(&dir, None), DEFAULT_VOICE);
        assert_eq!(
            voice_or_default(&dir, Some(kitten::DEFAULT_VOICE.into())),
            DEFAULT_VOICE
        );

        std::fs::write(dir.join(kitten::MODEL), []).unwrap();
        std::fs::write(dir.join(kitten::VOICES_FILE), []).unwrap();
        assert_eq!(voice_or_default(&dir, Some("bf_emma".into())), kitten::DEFAULT_VOICE);
        assert_eq!(voice_or_default(&dir, Some("expr-voice-3-m".into())), "expr-voice-3-m");
        assert_eq!(voices(&dir).len(), 8);
        assert_eq!(voices(&dir)[0].name, "Bella");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
