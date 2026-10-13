//! The queue each end of the window link writes through. Bounded by bytes, not
//! lines: the link carries every proxied call and every event, so a burst of
//! small lines is normal, and dropping the link costs a reconnect.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Condvar, Mutex};

pub const OUTBOX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
struct Queue {
    lines: VecDeque<String>,
    bytes: usize,
    closed: bool,
}

pub struct Outbox {
    queue: Mutex<Queue>,
    ready: Condvar,
    cap: usize,
}

impl Outbox {
    pub fn new(cap: usize) -> Self {
        Self {
            queue: Mutex::default(),
            ready: Condvar::new(),
            cap,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Never blocks. `false` once closed, and closes it when `line` would take
    /// a backlog past its cap: the reader on the far end has stopped, and
    /// waiting for it would hand its stall to whoever is publishing. One line
    /// alone is always taken, since a big reply is not a stalled reader.
    pub fn push(&self, line: String) -> bool {
        let mut queue = self.lock();
        if queue.closed {
            return false;
        }
        if !queue.lines.is_empty() && queue.bytes + line.len() > self.cap {
            queue.closed = true;
            queue.lines.clear();
            drop(queue);
            self.ready.notify_all();
            return false;
        }
        queue.bytes += line.len();
        queue.lines.push_back(line);
        drop(queue);
        self.ready.notify_one();
        true
    }

    pub fn close(&self) {
        self.lock().closed = true;
        self.ready.notify_all();
    }

    pub fn is_closed(&self) -> bool {
        self.lock().closed
    }

    fn pop(&self) -> Option<String> {
        let mut queue = self.lock();
        loop {
            if let Some(line) = queue.lines.pop_front() {
                queue.bytes -= line.len();
                return Some(line);
            }
            if queue.closed {
                return None;
            }
            queue = self.ready.wait(queue).unwrap_or_else(|e| e.into_inner());
        }
    }

    pub fn drain(&self, out: &mut impl Write) {
        while let Some(line) = self.pop() {
            if out.write_all(line.as_bytes()).and_then(|()| out.flush()).is_err() {
                break;
            }
        }
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_lines_drain_in_order_before_a_close_ends_the_drain() {
        let outbox = Outbox::new(1024);
        let out = std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                let mut out = Vec::new();
                outbox.drain(&mut out);
                out
            });
            outbox.push("a\n".into());
            outbox.push("b\n".into());
            outbox.close();
            writer.join().unwrap()
        });
        assert_eq!(out, b"a\nb\n");
    }

    #[test]
    fn going_past_the_byte_cap_closes_rather_than_waits() {
        let outbox = Outbox::new(10);
        assert!(Outbox::new(10).push("a line past the cap\n".into()), "one line alone");
        assert!(outbox.push("12345\n".into()));
        assert!(!outbox.push("123456\n".into()), "past the cap");
        assert!(outbox.is_closed());
        assert!(!outbox.push("1\n".into()), "stays closed");
    }
}
