use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

pub const IDLE: Duration = Duration::from_secs(5 * 60);

// Pieces synthesised but not yet played. Synthesis runs about four times
// faster than playback, so two keeps the next piece ready without spending
// the CPU on a whole reply that may be stopped a sentence in.
const AHEAD: usize = 2;

pub trait Voice: Send {
    fn pieces(&mut self, text: &str, opening: bool) -> Result<Vec<String>, String>;
    fn synth(&mut self, piece: &str, voice: &str, rate: f32) -> Result<Vec<f32>, String>;
    fn sample_rate(&self) -> u32;
}

impl Voice for Box<dyn Voice> {
    fn pieces(&mut self, text: &str, opening: bool) -> Result<Vec<String>, String> {
        (**self).pieces(text, opening)
    }

    fn synth(&mut self, piece: &str, voice: &str, rate: f32) -> Result<Vec<f32>, String> {
        (**self).synth(piece, voice, rate)
    }

    fn sample_rate(&self) -> u32 {
        (**self).sample_rate()
    }
}

pub trait Out: Send + Sync {
    fn play(&self, samples: Vec<f32>, stale: &dyn Fn() -> bool) -> Result<(), String>;
    fn stop(&self);
    fn release(&self);
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Start { read: u64, chunk: usize },
    Finish { read: u64, chunk: usize },
    Cancel { read: u64 },
    Error { read: u64, error: String },
}

type Emit = Arc<dyn Fn(Event) + Send + Sync>;
pub type Idle = Arc<dyn Fn(Instant) + Send + Sync>;
type Loader<V> = Box<dyn Fn() -> Result<V, String> + Send>;

pub struct Models<V> {
    load: Loader<V>,
    loaded: Option<V>,
    used: Instant,
    model_generation: Arc<AtomicU64>,
    seen: u64,
}

impl<V> Models<V> {
    pub fn new(load: Loader<V>, model_generation: Arc<AtomicU64>) -> Self {
        let seen = model_generation.load(Ordering::SeqCst);
        Models {
            load,
            loaded: None,
            used: Instant::now(),
            model_generation,
            seen,
        }
    }

    fn forget_replaced(&mut self) {
        let now = self.model_generation.load(Ordering::SeqCst);
        if now != self.seen {
            self.seen = now;
            self.loaded = None;
        }
    }

    pub fn get(&mut self, now: Instant) -> Result<&mut V, String> {
        self.used = now;
        self.forget_replaced();
        if self.loaded.is_none() {
            self.loaded = Some((self.load)()?);
        }
        Ok(self.loaded.as_mut().unwrap())
    }

    pub fn sweep(&mut self, now: Instant) {
        self.forget_replaced();
        if now.saturating_duration_since(self.used) >= IDLE {
            self.loaded = None;
        }
    }
}

enum Work {
    Read(Job),
    Warm,
}

struct Job {
    read: u64,
    chunks: Vec<String>,
    // Silence after each chunk, in milliseconds: a heading or a list item
    // gets more of a break than Kokoro's own tail.
    pauses: Vec<u32>,
    rate: f32,
    voice: String,
}

struct Item {
    read: u64,
    chunk: usize,
    audio: Vec<f32>,
    first: bool,
    last: bool,
    end: bool,
}

#[derive(Clone)]
struct Shared {
    current: Arc<AtomicU64>,
    active: Arc<Mutex<Option<u64>>>,
    emit: Emit,
}

impl Shared {
    fn stale(&self, read: u64) -> bool {
        self.current.load(Ordering::SeqCst) != read
    }

    fn done(&self, read: u64) {
        let mut active = self.active.lock().unwrap();
        if *active == Some(read) {
            *active = None;
        }
    }

    fn fail(&self, read: u64, error: String) {
        if self
            .current
            .compare_exchange(read, read + 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.done(read);
            (self.emit)(Event::Error { read, error });
        }
    }

    fn cancel(&self) {
        if let Some(read) = self.active.lock().unwrap().take() {
            (self.emit)(Event::Cancel { read });
        }
    }
}

pub struct Engine {
    jobs: Sender<Work>,
    out: Arc<dyn Out>,
    shared: Shared,
}

impl Engine {
    pub fn start<V: Voice + 'static>(
        models: Models<V>,
        out: Arc<dyn Out>,
        emit: Emit,
        tick: Duration,
        idle: Idle,
    ) -> Self {
        let shared = Shared {
            current: Arc::default(),
            active: Arc::default(),
            emit,
        };
        let (jobs, job_rx) = mpsc::channel();
        let (items, item_rx) = mpsc::sync_channel(AHEAD - 1);
        let synth = shared.clone();
        thread::Builder::new()
            .name("speech-synth".into())
            .spawn(move || synthesise(job_rx, items, models, synth, tick, idle))
            .expect("spawn speech-synth");
        let (player, sink) = (shared.clone(), out.clone());
        thread::Builder::new()
            .name("speech-play".into())
            .spawn(move || play(item_rx, sink, player))
            .expect("spawn speech-play");
        Engine { jobs, out, shared }
    }

    pub fn speak(&self, chunks: Vec<String>, pauses: Vec<u32>, rate: f32, voice: String) -> Result<u64, String> {
        let read = self.interrupt();
        if chunks.is_empty() {
            return Ok(read);
        }
        *self.shared.active.lock().unwrap() = Some(read);
        let job = Job {
            read,
            chunks,
            pauses,
            rate,
            voice,
        };
        if self.jobs.send(Work::Read(job)).is_err() {
            self.shared.done(read);
            return Err("the speech engine has stopped".into());
        }
        Ok(read)
    }

    pub fn warm(&self) {
        let _ = self.jobs.send(Work::Warm);
    }

    pub fn stop(&self) {
        self.interrupt();
    }

    fn interrupt(&self) -> u64 {
        let read = self.shared.current.fetch_add(1, Ordering::SeqCst) + 1;
        self.shared.cancel();
        self.out.stop();
        read
    }
}

fn synthesise<V: Voice>(
    jobs: Receiver<Work>,
    items: SyncSender<Item>,
    mut models: Models<V>,
    shared: Shared,
    tick: Duration,
    idle: Idle,
) {
    loop {
        let job = match jobs.recv_timeout(tick) {
            Ok(Work::Read(job)) => job,
            // A model that cannot load says so on the read that needs it.
            Ok(Work::Warm) => {
                let _ = models.get(Instant::now());
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                models.sweep(now);
                idle(now);
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if shared.stale(job.read) {
            continue;
        }
        if let Err(error) = run(&job, &mut models, &items, &shared) {
            shared.fail(job.read, error);
        }
        models.used = Instant::now();
    }
}

fn run<V: Voice>(job: &Job, models: &mut Models<V>, items: &SyncSender<Item>, shared: &Shared) -> Result<(), String> {
    let voice = models.get(Instant::now())?;
    let last_chunk = job.chunks.len().saturating_sub(1);
    for (chunk, text) in job.chunks.iter().enumerate() {
        let pieces = voice.pieces(text, chunk == 0)?;
        let count = pieces.len().max(1);
        for i in 0..count {
            if shared.stale(job.read) {
                return Ok(());
            }
            let mut audio = match pieces.get(i) {
                Some(piece) => voice.synth(piece, &job.voice, job.rate)?,
                None => Vec::new(),
            };
            let last = i == count - 1;
            if last {
                let pause = job.pauses.get(chunk).copied().unwrap_or(0) as usize;
                audio.extend(std::iter::repeat_n(0.0, voice.sample_rate() as usize * pause / 1000));
            }
            let item = Item {
                read: job.read,
                chunk,
                audio,
                first: i == 0,
                last,
                end: last && chunk == last_chunk,
            };
            if items.send(item).is_err() {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn play(items: Receiver<Item>, out: Arc<dyn Out>, shared: Shared) {
    loop {
        let item = match items.recv_timeout(IDLE) {
            Ok(item) => item,
            Err(RecvTimeoutError::Timeout) => {
                out.release();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let read = item.read;
        if shared.stale(read) {
            continue;
        }
        if item.first {
            (shared.emit)(Event::Start {
                read,
                chunk: item.chunk,
            });
        }
        if !item.audio.is_empty() {
            if let Err(error) = out.play(item.audio, &|| shared.stale(read)) {
                shared.fail(read, error);
                continue;
            }
        }
        if shared.stale(read) {
            continue;
        }
        if item.last {
            (shared.emit)(Event::Finish {
                read,
                chunk: item.chunk,
            });
        }
        if item.end {
            shared.done(read);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Condvar;

    use super::*;

    struct FakeVoice(Arc<Mutex<Vec<String>>>);

    impl Voice for FakeVoice {
        fn pieces(&mut self, text: &str, _opening: bool) -> Result<Vec<String>, String> {
            Ok(text.split('|').filter(|p| !p.is_empty()).map(String::from).collect())
        }
        fn synth(&mut self, piece: &str, _voice: &str, _rate: f32) -> Result<Vec<f32>, String> {
            self.0.lock().unwrap().push(piece.into());
            Ok(piece.bytes().map(f32::from).collect())
        }
        fn sample_rate(&self) -> u32 {
            1000
        }
    }

    #[derive(Default)]
    struct FakeOut {
        state: Mutex<(Vec<String>, bool, bool)>,
        changed: Condvar,
    }

    impl FakeOut {
        fn gated() -> Arc<Self> {
            let out = Arc::new(FakeOut::default());
            out.state.lock().unwrap().1 = true;
            out
        }
        fn open(&self) {
            self.state.lock().unwrap().1 = false;
            self.changed.notify_all();
        }
        fn played(&self) -> Vec<String> {
            self.state.lock().unwrap().0.clone()
        }
    }

    impl Out for FakeOut {
        fn play(&self, samples: Vec<f32>, stale: &dyn Fn() -> bool) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            state.0.push(samples.iter().map(|s| *s as u8 as char).collect());
            state.2 = false;
            while state.1 && !state.2 && !stale() {
                state = self.changed.wait_timeout(state, Duration::from_millis(5)).unwrap().0;
            }
            Ok(())
        }
        fn stop(&self) {
            self.state.lock().unwrap().2 = true;
            self.changed.notify_all();
        }
        fn release(&self) {}
    }

    struct Rig {
        engine: Engine,
        out: Arc<FakeOut>,
        synthesised: Arc<Mutex<Vec<String>>>,
        events: Arc<Mutex<Vec<Event>>>,
        loads: Arc<AtomicU64>,
    }

    fn rig(out: Arc<FakeOut>) -> Rig {
        let synthesised = Arc::new(Mutex::new(Vec::new()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let voice = synthesised.clone();
        let loads = Arc::new(AtomicU64::new(0));
        let counter = loads.clone();
        let load = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(FakeVoice(voice.clone()))
        });
        let models = Models::new(load, Default::default());
        let log = events.clone();
        let emit: Emit = Arc::new(move |e| log.lock().unwrap().push(e));
        let engine = Engine::start(models, out.clone(), emit, Duration::from_millis(10), Arc::new(|_| {}));
        Rig {
            engine,
            out,
            synthesised,
            events,
            loads,
        }
    }

    fn until(what: &str, cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn speak(r: &Rig, chunks: &[&str]) -> u64 {
        speak_paused(r, chunks, &[])
    }

    fn speak_paused(r: &Rig, chunks: &[&str], pauses: &[u32]) -> u64 {
        r.engine
            .speak(
                chunks.iter().map(|c| c.to_string()).collect(),
                pauses.to_vec(),
                1.0,
                "af_heart".into(),
            )
            .unwrap()
    }

    #[test]
    fn a_chunks_pause_is_silence_after_its_last_piece() {
        let r = rig(Arc::new(FakeOut::default()));
        let read = speak_paused(&r, &["ab|cd", "ef"], &[5, 0]);
        until("the last finish", || {
            events(&r).contains(&Event::Finish { read, chunk: 1 })
        });
        let played = r.out.played();
        assert_eq!(played[0], "ab");
        assert_eq!(played[1], format!("cd{}", "\0".repeat(5)));
        assert_eq!(played[2], "ef");
    }

    fn events(r: &Rig) -> Vec<Event> {
        r.events.lock().unwrap().clone()
    }

    #[test]
    fn a_warm_up_loads_the_model_once_and_the_read_after_it_loads_nothing() {
        let r = rig(Arc::new(FakeOut::default()));
        r.engine.warm();
        until("the warm up", || r.loads.load(Ordering::SeqCst) == 1);
        r.engine.warm();
        let read = speak(&r, &["a"]);
        until("the finish", || events(&r).contains(&Event::Finish { read, chunk: 0 }));
        assert_eq!(r.loads.load(Ordering::SeqCst), 1);
        assert_eq!(
            events(&r),
            [Event::Start { read, chunk: 0 }, Event::Finish { read, chunk: 0 }]
        );
    }

    #[test]
    fn chunks_play_in_order_each_between_its_start_and_finish() {
        let r = rig(Arc::new(FakeOut::default()));
        let read = speak(&r, &["a|b", "c"]);
        until("the last finish", || {
            events(&r).contains(&Event::Finish { read, chunk: 1 })
        });
        assert_eq!(r.out.played(), ["a", "b", "c"]);
        assert_eq!(
            events(&r),
            [
                Event::Start { read, chunk: 0 },
                Event::Finish { read, chunk: 0 },
                Event::Start { read, chunk: 1 },
                Event::Finish { read, chunk: 1 },
            ]
        );
    }

    #[test]
    fn a_chunk_cut_into_several_pieces_plays_them_all_under_one_id() {
        let r = rig(Arc::new(FakeOut::default()));
        let read = speak(&r, &["one|two|three|four"]);
        until("the finish", || events(&r).contains(&Event::Finish { read, chunk: 0 }));
        assert_eq!(r.out.played(), ["one", "two", "three", "four"]);
        assert_eq!(
            events(&r),
            [Event::Start { read, chunk: 0 }, Event::Finish { read, chunk: 0 }]
        );
    }

    #[test]
    fn a_new_read_cancels_the_one_playing() {
        let r = rig(FakeOut::gated());
        let first = speak(&r, &["a", "b"]);
        until("a to play", || r.out.played() == ["a"]);
        let second = speak(&r, &["x"]);
        r.out.open();
        until("x to finish", || {
            events(&r).contains(&Event::Finish { read: second, chunk: 0 })
        });
        assert!(!r.out.played().contains(&"b".to_string()));
        assert_eq!(
            events(&r),
            [
                Event::Start { read: first, chunk: 0 },
                Event::Cancel { read: first },
                Event::Start { read: second, chunk: 0 },
                Event::Finish { read: second, chunk: 0 },
            ]
        );
    }

    #[test]
    fn stop_drains_what_was_queued_and_says_cancel_once() {
        let r = rig(FakeOut::gated());
        let read = speak(&r, &["a", "b", "c"]);
        until("b to be ready", || r.synthesised.lock().unwrap().len() >= 2);
        r.engine.stop();
        r.engine.stop();
        r.out.open();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(r.out.played(), ["a"]);
        assert_eq!(events(&r), [Event::Start { read, chunk: 0 }, Event::Cancel { read }]);
    }

    #[test]
    fn synthesis_runs_ahead_of_playback() {
        let r = rig(FakeOut::gated());
        speak(&r, &["a", "b", "c", "d"]);
        until("a to play", || r.out.played() == ["a"]);
        until("the next pieces to be synthesised", || {
            r.synthesised.lock().unwrap().len() > AHEAD
        });
        thread::sleep(Duration::from_millis(50));
        assert_eq!(r.out.played(), ["a"]);
        assert_eq!(r.synthesised.lock().unwrap().len(), 1 + AHEAD);
    }

    #[test]
    fn the_model_is_dropped_after_five_idle_minutes_and_loaded_again_on_use() {
        let loads = Arc::new(AtomicU64::new(0));
        let counter = loads.clone();
        let mut models = Models::new(
            Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
            Default::default(),
        );
        let t0 = Instant::now();
        models.get(t0).unwrap();
        models.sweep(t0 + IDLE - Duration::from_secs(1));
        assert!(models.loaded.is_some());
        models.get(t0 + Duration::from_secs(60)).unwrap();
        models.sweep(t0 + IDLE);
        assert!(models.loaded.is_some(), "the minute-one read restarted the idle clock");
        models.sweep(t0 + Duration::from_secs(60) + IDLE);
        assert!(models.loaded.is_none());
        models.get(t0 + 2 * IDLE).unwrap();
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }
}
