use std::f64::consts::PI;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use rodio::cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rodio::cpal::{self, SampleFormat};

use super::SAMPLE_RATE;

const LONGEST_SECONDS: usize = 15 * 60;
pub const QUIET: f32 = 0.01;
const TAPS_EACH_SIDE: usize = 32;
const LEVELS_PER_SECOND: usize = 30;

pub type Level = Box<dyn Fn(f32) + Send>;

pub struct Clip {
    pub samples: Vec<f32>,
    pub rate: u32,
}

pub struct Capture {
    stop: Sender<bool>,
    done: Receiver<Clip>,
}

// The stream lives on its own thread from start to stop: cpal's stream is not
// Send on every host, so it never leaves the thread that opened it.
pub fn start(level: Level) -> Result<Capture, String> {
    let (ready_tx, ready_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    thread::Builder::new()
        .name("dictation-capture".into())
        .spawn(move || {
            let buffer: Arc<Mutex<Vec<f32>>> = Arc::default();
            let (stream, rate) = match open(buffer.clone(), level) {
                Ok(opened) => opened,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));
            let keep = stop_rx.recv().unwrap_or(false);
            drop(stream);
            let samples = if keep {
                std::mem::take(&mut *buffer.lock().unwrap())
            } else {
                Vec::new()
            };
            let _ = done_tx.send(Clip { samples, rate });
        })
        .map_err(|e| e.to_string())?;
    ready_rx
        .recv()
        .map_err(|_| "the capture thread stopped".to_string())??;
    Ok(Capture {
        stop: stop_tx,
        done: done_rx,
    })
}

pub fn stop(capture: Capture, keep: bool) -> Result<Clip, String> {
    capture.stop.send(keep).map_err(|_| "the capture thread stopped")?;
    capture
        .done
        .recv()
        .map_err(|_| "the capture thread stopped".to_string())
}

fn open(buffer: Arc<Mutex<Vec<f32>>>, level: Level) -> Result<(cpal::Stream, u32), String> {
    let device = cpal::default_host().default_input_device().ok_or("no microphone")?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let channels = supported.channels() as usize;
    let rate = supported.sample_rate();
    let config = supported.config();
    let longest = LONGEST_SECONDS * rate as usize;
    let mut meter = Meter::new(rate as usize / LEVELS_PER_SECOND, level);
    let mut keep = move |frames: &mut dyn Iterator<Item = f32>| {
        let mut buffer = buffer.lock().unwrap();
        let room = longest.saturating_sub(buffer.len());
        let from = buffer.len();
        buffer.extend(frames.take(room));
        meter.feed(&buffer[from..]);
    };
    let err = |e: cpal::Error| eprintln!("dictation capture: {e}");
    let stream = match supported.sample_format() {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _: &_| keep(&mut mono(data.iter().copied(), channels)),
            err,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _: &_| keep(&mut mono(data.iter().map(|s| *s as f32 / 32_768.0), channels)),
            err,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _: &_| {
                keep(&mut mono(
                    data.iter().map(|s| (*s as f32 - 32_768.0) / 32_768.0),
                    channels,
                ))
            },
            err,
            None,
        ),
        SampleFormat::I32 => device.build_input_stream(
            config,
            move |data: &[i32], _: &_| keep(&mut mono(data.iter().map(|s| *s as f32 / 2_147_483_648.0), channels)),
            err,
            None,
        ),
        other => return Err(format!("the microphone gives {other} samples")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate))
}

struct Meter {
    every: usize,
    squares: f32,
    count: usize,
    level: Level,
}

impl Meter {
    fn new(every: usize, level: Level) -> Self {
        Meter {
            every: every.max(1),
            squares: 0.0,
            count: 0,
            level,
        }
    }

    fn feed(&mut self, samples: &[f32]) {
        for s in samples {
            self.squares += s * s;
            self.count += 1;
            if self.count == self.every {
                (self.level)((self.squares / self.count as f32).sqrt());
                self.squares = 0.0;
                self.count = 0;
            }
        }
    }
}

fn mono(samples: impl Iterator<Item = f32>, channels: usize) -> impl Iterator<Item = f32> {
    let channels = channels.max(1);
    let mut frame = Vec::with_capacity(channels);
    samples.filter_map(move |s| {
        frame.push(s);
        if frame.len() < channels {
            return None;
        }
        let sum: f32 = frame.drain(..).sum();
        Some(sum / channels as f32)
    })
}

// A real microphone never gives exact zeros, even in a silent room; macOS does,
// when it has not let this app listen and has not asked either.
pub fn withheld(samples: &[f32]) -> bool {
    !samples.is_empty() && samples.iter().all(|s| *s == 0.0)
}

pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0, |m, s| m.max(s.abs()))
}

pub fn to_engine_rate(clip: &Clip) -> Vec<f32> {
    lowpass_resample(&clip.samples, clip.rate, SAMPLE_RATE as u32)
}

pub fn lowpass_resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let step = from as f64 / to as f64;
    let cutoff = 0.45 * from.min(to) as f64 / from as f64;
    let half = TAPS_EACH_SIDE as f64;
    let out_len = (input.len() as f64 / step).floor() as usize;
    (0..out_len)
        .map(|i| {
            let centre = i as f64 * step;
            let lo = (centre - half).ceil().max(0.0) as usize;
            let hi = ((centre + half).floor() as usize).min(input.len() - 1);
            let (mut acc, mut norm) = (0.0f64, 0.0f64);
            for (k, sample) in input.iter().enumerate().take(hi + 1).skip(lo) {
                let tap = windowed_sinc_tap(k as f64 - centre, cutoff, half);
                acc += *sample as f64 * tap;
                norm += tap;
            }
            (acc / norm) as f32
        })
        .collect()
}

fn windowed_sinc_tap(x: f64, cutoff: f64, half: f64) -> f64 {
    let blackman = 0.42 + 0.5 * (PI * x / half).cos() + 0.08 * (2.0 * PI * x / half).cos();
    sinc(2.0 * cutoff * x) * blackman
}

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    }
}

#[cfg(target_os = "macos")]
mod permission {
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {}

    const NOT_DETERMINED: isize = 0;
    const RESTRICTED: isize = 1;
    const DENIED: isize = 2;

    fn status() -> isize {
        let audio = NSString::from_str("soun");
        unsafe { msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: &*audio] }
    }

    pub fn denied() -> bool {
        matches!(status(), RESTRICTED | DENIED)
    }

    // macOS lists an app under Privacy & Security only once it has asked, so
    // the first press asks rather than waiting for capture to maybe prompt.
    // A dev build is not asked: macOS puts the question to the app that
    // launched it, and one without a microphone entry is killed for asking.
    pub fn ask() -> bool {
        if status() != NOT_DETERMINED || cfg!(debug_assertions) {
            return !denied();
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let answered = block2::RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let audio = NSString::from_str("soun");
        let _: () = unsafe {
            msg_send![class!(AVCaptureDevice), requestAccessForMediaType: &*audio, completionHandler: &*answered]
        };
        rx.recv().unwrap_or(false)
    }
}

#[cfg(not(target_os = "macos"))]
mod permission {
    pub fn denied() -> bool {
        false
    }

    pub fn ask() -> bool {
        true
    }
}

pub use permission::{ask as ask_for_microphone, denied as microphone_denied};

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f64, rate: u32, seconds: f64) -> Vec<f32> {
        (0..(rate as f64 * seconds) as usize)
            .map(|i| (2.0 * PI * hz * i as f64 / rate as f64).sin() as f32)
            .collect()
    }

    fn hertz(samples: &[f32], rate: u32) -> f64 {
        let crossings = samples.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        crossings as f64 / 2.0 * rate as f64 / samples.len() as f64
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn a_1_khz_tone_comes_out_at_1_khz_from_48_and_44_1_khz_and_a_10_khz_tone_is_gone() {
        for rate in [48_000, 44_100] {
            let out = lowpass_resample(&tone(1_000.0, rate, 1.0), rate, 16_000);
            assert_eq!(out.len(), 16_000);
            let hz = hertz(&out, 16_000);
            assert!((hz - 1_000.0).abs() < 10.0, "{rate}: {hz} Hz");
            assert!(
                (rms(&out) - rms(&tone(1_000.0, 16_000, 1.0))).abs() < 0.02,
                "{rate}: level changed"
            );

            let high = lowpass_resample(&tone(10_000.0, rate, 1.0), rate, 16_000);
            assert!(
                rms(&high) < 0.02,
                "{rate}: a 10 kHz tone came through at {}",
                rms(&high)
            );
        }
        assert_eq!(lowpass_resample(&[0.5, 0.25], 16_000, 16_000), [0.5, 0.25]);
    }
}
