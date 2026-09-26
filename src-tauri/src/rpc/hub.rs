//! Subscriptions. `publish` runs on whatever thread noticed the event, which
//! for a chat session is the agent's stdout reader, so it must never block on a
//! client: each connection has a bounded outbound queue, and a client that lets
//! its queue fill is dropped rather than waited for. A chat stream is the
//! exception: it has its own queue, and falling behind on it costs a resync,
//! not the connection.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::frame::{to_line, Notification};

/// Lines a connection may have queued before it counts as not reading.
pub const QUEUE_CAP: usize = 256;

/// Chat lines a connection may have queued before its chat queue is cleared.
pub const CHAT_CAP: usize = 256;

/// The empty line a publisher sends through the main queue to wake a writer
/// blocked on it when only the chat queue has lines. Never written.
pub const WAKE: &str = "";

/// What the wire calls a topic. Named apart from it because "Topic" already
/// means a feature workspace in this codebase.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Channel {
    Sessions,
    Session(String),
    Accounts,
    Autopilot,
    Chat(String),
}

impl Channel {
    pub fn parse(topic: &str) -> Option<Self> {
        match topic {
            "sessions" => Some(Channel::Sessions),
            "accounts" => Some(Channel::Accounts),
            "autopilot" => Some(Channel::Autopilot),
            _ => {
                let id = |prefix| topic.strip_prefix(prefix).filter(|id| !id.is_empty()).map(str::to_string);
                id("session:").map(Channel::Session).or_else(|| id("chat:").map(Channel::Chat))
            }
        }
    }
}

impl fmt::Display for Channel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Channel::Sessions => f.write_str("sessions"),
            Channel::Session(id) => write!(f, "session:{id}"),
            Channel::Accounts => f.write_str("accounts"),
            Channel::Autopilot => f.write_str("autopilot"),
            Channel::Chat(id) => write!(f, "chat:{id}"),
        }
    }
}

pub type ConnId = u64;

struct Conn {
    tx: SyncSender<String>,
    /// Called when the connection is dropped for falling behind, so the client
    /// sees a closed socket instead of silently missing events.
    close: Box<dyn Fn() + Send>,
    channels: HashSet<Channel>,
    /// The paired device on the other end, so revoking it can drop the connection.
    device: Option<String>,
    chat: Arc<ChatOutbox>,
}

/// A connection's chat lines, drained by its writer only when the main queue
/// is empty, so replies and other topics never wait behind a stream.
#[derive(Default)]
pub struct ChatOutbox {
    lines: Mutex<VecDeque<(String, String)>>,
    woken: AtomicBool,
}

impl ChatOutbox {
    pub fn pop(&self) -> Option<String> {
        self.lock().pop_front().map(|(_, line)| line)
    }

    pub fn clear_wake(&self) {
        self.woken.store(false, Ordering::SeqCst);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<(String, String)>> {
        self.lines.lock().unwrap_or_else(|e| e.into_inner())
    }

    // Past the cap the queued stream is useless to the client, so every
    // session in it gets one resync in place of its lines, this one included.
    fn push(&self, id: &str, line: String) {
        let mut lines = self.lock();
        if lines.len() < CHAT_CAP {
            lines.push_back((id.to_string(), line));
            return;
        }
        let mut ids: Vec<String> = lines.drain(..).map(|(id, _)| id).collect();
        ids.push(id.to_string());
        ids.sort();
        ids.dedup();
        lines.extend(ids.into_iter().map(|id| {
            let line = event_line(&Channel::Chat(id.clone()), json!({ "kind": "chat.resync", "id": id }));
            (id, line)
        }));
    }

    fn wake(&self, tx: &SyncSender<String>) {
        if !self.woken.swap(true, Ordering::SeqCst) && tx.try_send(WAKE.to_string()).is_err() {
            // A full main queue has a line coming anyway, and the writer
            // checks this queue between lines.
            self.woken.store(false, Ordering::SeqCst);
        }
    }
}

fn event_line(channel: &Channel, data: Value) -> String {
    to_line(&Notification::new("event", json!({ "topic": channel.to_string(), "data": data })))
}

#[derive(Default)]
pub struct Hub {
    inner: Mutex<Inner>,
    on_devices: Mutex<Option<Box<dyn Fn() + Send>>>,
}

#[derive(Default)]
struct Inner {
    next: ConnId,
    conns: HashMap<ConnId, Conn>,
}

fn devices_of(inner: &Inner) -> HashSet<String> {
    inner.conns.values().filter_map(|c| c.device.clone()).collect()
}

impl Hub {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        }
    }

    /// Called, outside the lock, whenever a device gains its first connection or loses its last.
    pub fn watch_devices(&self, watcher: Box<dyn Fn() + Send>) {
        *self.on_devices.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
    }

    pub fn connected_devices(&self) -> HashSet<String> {
        devices_of(&self.lock())
    }

    fn with_devices<T>(&self, change: impl FnOnce(&mut Inner) -> T) -> T {
        let (out, moved) = {
            let mut inner = self.lock();
            let before = devices_of(&inner);
            let out = change(&mut inner);
            (out, devices_of(&inner) != before)
        };
        if moved {
            if let Some(watcher) = &*self.on_devices.lock().unwrap_or_else(|e| e.into_inner()) {
                watcher();
            }
        }
        out
    }

    pub fn register(&self, tx: SyncSender<String>, close: Box<dyn Fn() + Send>) -> ConnId {
        let mut inner = self.lock();
        inner.next += 1;
        let id = inner.next;
        inner.conns.insert(id, Conn { tx, close, channels: HashSet::new(), device: None, chat: Arc::default() });
        id
    }

    /// The queue a connection's writer drains after its main one.
    pub fn chat_outbox(&self, conn: ConnId) -> Option<Arc<ChatOutbox>> {
        self.lock().conns.get(&conn).map(|c| c.chat.clone())
    }

    /// Whether anyone reads `chat:<id>`, so the stream is not serialised for nobody.
    pub fn watches_chat(&self, id: &str) -> bool {
        let channel = Channel::Chat(id.to_string());
        self.lock().conns.values().any(|c| c.channels.contains(&channel))
    }

    pub fn tag_device(&self, conn: ConnId, device: &str) {
        self.with_devices(|inner| {
            if let Some(c) = inner.conns.get_mut(&conn) {
                c.device = Some(device.to_string());
            }
        });
    }

    /// Drops every connection held by `device`.
    pub fn close_device(&self, device: &str) {
        self.with_devices(|inner| {
            let ids: Vec<ConnId> = inner.conns.iter().filter(|(_, c)| c.device.as_deref() == Some(device)).map(|(id, _)| *id).collect();
            close_all(inner, ids);
        });
    }

    pub fn remove(&self, conn: ConnId) {
        self.with_devices(|inner| inner.conns.remove(&conn));
    }

    /// `false` when the connection is already gone.
    pub fn subscribe(&self, conn: ConnId, channel: Channel) -> bool {
        self.lock().conns.get_mut(&conn).map(|c| c.channels.insert(channel)).is_some()
    }

    pub fn unsubscribe(&self, conn: ConnId, channel: &Channel) {
        if let Some(c) = self.lock().conns.get_mut(&conn) {
            c.channels.remove(channel);
        }
    }

    pub fn publish(&self, channel: &Channel, data: Value) {
        let line = event_line(channel, data);
        let mut inner = self.lock();
        if let Channel::Chat(session) = channel {
            for conn in inner.conns.values().filter(|c| c.channels.contains(channel)) {
                conn.chat.push(session, line.clone());
                conn.chat.wake(&conn.tx);
            }
            return;
        }
        let mut dropped = Vec::new();
        for (id, conn) in inner.conns.iter().filter(|(_, c)| c.channels.contains(channel)) {
            match conn.tx.try_send(line.clone()) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => dropped.push(*id),
            }
        }
        drop(inner);
        if !dropped.is_empty() {
            self.with_devices(|inner| close_all(inner, dropped));
        }
    }

    pub fn publish_session(&self, id: &str, data: Value) {
        self.publish(&Channel::Session(id.to_string()), data.clone());
        self.publish(&Channel::Sessions, data);
    }

    #[cfg(test)]
    pub fn subscriptions(&self) -> usize {
        self.lock().conns.values().map(|c| c.channels.len()).sum()
    }
}

fn close_all(inner: &mut Inner, ids: Vec<ConnId>) {
    for id in ids {
        if let Some(conn) = inner.conns.remove(&id) {
            (conn.close)();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::events::{session_event, Place};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::sync::Arc;

    #[test]
    fn channels_round_trip_through_their_wire_names() {
        for topic in ["sessions", "session:abc", "accounts", "autopilot", "chat:abc"] {
            assert_eq!(Channel::parse(topic).unwrap().to_string(), topic);
        }
        assert_eq!(Channel::parse("session:"), None);
        assert_eq!(Channel::parse("chat:"), None);
        assert_eq!(Channel::parse("topics"), None);
    }

    #[test]
    fn an_event_reaches_subscribers_only_and_stops_after_unsubscribe() {
        let hub = Hub::default();
        let (tx_a, rx_a) = sync_channel(QUEUE_CAP);
        let (tx_b, rx_b) = sync_channel(QUEUE_CAP);
        let a = hub.register(tx_a, Box::new(|| {}));
        hub.register(tx_b, Box::new(|| {}));
        assert!(hub.subscribe(a, Channel::Sessions));

        hub.publish(&Channel::Sessions, json!({"kind": "started"}));
        hub.publish(&Channel::Autopilot, json!({}));
        let got: Value = serde_json::from_str(&rx_a.try_recv().unwrap()).unwrap();
        assert_eq!(got["params"], json!({"topic": "sessions", "data": {"kind": "started"}}));
        assert!(rx_a.try_recv().is_err(), "nothing from a channel it did not subscribe to");
        assert!(rx_b.try_recv().is_err());

        hub.unsubscribe(a, &Channel::Sessions);
        hub.publish(&Channel::Sessions, json!({}));
        assert!(rx_a.try_recv().is_err());
    }

    #[test]
    fn a_session_event_reaches_the_firehose_and_its_own_topic() {
        let hub = Hub::default();
        let (tx_all, rx_all) = sync_channel(QUEUE_CAP);
        let (tx_one, rx_one) = sync_channel(QUEUE_CAP);
        let (tx_other, rx_other) = sync_channel(QUEUE_CAP);
        hub.subscribe(hub.register(tx_all, Box::new(|| {})), Channel::Sessions);
        hub.subscribe(hub.register(tx_one, Box::new(|| {})), Channel::Session("s1".into()));
        hub.subscribe(hub.register(tx_other, Box::new(|| {})), Channel::Session("s2".into()));

        let place = Place { project: Some("/p".into()), folder: Some("/p/wt".into()) };
        hub.publish_session("s1", session_event("session.started", "s1", &place, json!({})));
        for (rx, topic) in [(&rx_all, "sessions"), (&rx_one, "session:s1")] {
            let got: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
            assert_eq!(got["params"]["topic"], topic);
            let data = &got["params"]["data"];
            assert_eq!(data["kind"], "session.started");
            assert_eq!(data["id"], "s1");
            assert_eq!(data["project"], "/p");
            assert_eq!(data["folder"], "/p/wt");
            assert!(data["ts"].is_u64());
        }
        assert!(rx_other.try_recv().is_err());
    }

    #[test]
    fn a_client_that_never_reads_is_dropped_not_waited_for() {
        let hub = Hub::default();
        let (tx, _never_read) = sync_channel(2);
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        let id = hub.register(tx, Box::new(move || flag.store(true, Ordering::SeqCst)));
        hub.subscribe(id, Channel::Sessions);

        let start = std::time::Instant::now();
        for _ in 0..10 {
            hub.publish(&Channel::Sessions, json!({}));
        }
        assert!(start.elapsed() < std::time::Duration::from_millis(100));
        assert!(closed.load(Ordering::SeqCst), "the stalled client is closed");
        assert_eq!(hub.subscriptions(), 0);
        assert!(!hub.subscribe(id, Channel::Sessions), "and gone from the hub");
    }

    #[test]
    fn a_stalled_chat_reader_gets_a_resync_and_keeps_its_connection() {
        let hub = Hub::default();
        let (tx, rx) = sync_channel(QUEUE_CAP);
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        let id = hub.register(tx, Box::new(move || flag.store(true, Ordering::SeqCst)));
        hub.subscribe(id, Channel::Sessions);
        hub.subscribe(id, Channel::Chat("s1".into()));
        let chat = hub.chat_outbox(id).unwrap();

        for n in 0..CHAT_CAP + 10 {
            hub.publish(&Channel::Chat("s1".into()), json!({ "n": n }));
        }
        hub.publish(&Channel::Sessions, json!({ "kind": "session.dot" }));
        assert!(!closed.load(Ordering::SeqCst), "a chat flood does not cost the connection");

        let main: Vec<String> = rx.try_iter().collect();
        assert_eq!(main[0], WAKE, "one wake, however many chat lines");
        assert_eq!(main.len(), 2);
        let sessions: Value = serde_json::from_str(&main[1]).unwrap();
        assert_eq!(sessions["params"]["data"]["kind"], "session.dot");

        chat.clear_wake();
        let queued: Vec<Value> = std::iter::from_fn(|| chat.pop()).map(|l| serde_json::from_str(&l).unwrap()).collect();
        let resyncs: Vec<&Value> = queued.iter().filter(|l| l["params"]["data"]["kind"] == "chat.resync").collect();
        assert_eq!(resyncs.len(), 1);
        assert_eq!(resyncs[0]["params"]["topic"], "chat:s1");
        assert!(queued.len() < CHAT_CAP, "the backlog is gone");

        hub.publish(&Channel::Chat("s1".into()), json!({ "n": "after" }));
        assert_eq!(rx.try_recv().unwrap(), WAKE, "the next line wakes the writer again");
    }

    #[test]
    fn a_chat_event_is_not_serialised_for_nobody() {
        let hub = Hub::default();
        let (tx, _rx) = sync_channel(QUEUE_CAP);
        let id = hub.register(tx, Box::new(|| {}));
        assert!(!hub.watches_chat("s1"));
        hub.subscribe(id, Channel::Chat("s1".into()));
        assert!(hub.watches_chat("s1"));
        assert!(!hub.watches_chat("s2"));
    }

    #[test]
    fn removing_a_connection_leaves_no_subscription_behind() {
        let hub = Hub::default();
        let (tx, _rx) = sync_channel(QUEUE_CAP);
        let id = hub.register(tx, Box::new(|| {}));
        hub.subscribe(id, Channel::Sessions);
        hub.subscribe(id, Channel::Session("s1".into()));
        hub.remove(id);
        assert_eq!(hub.subscriptions(), 0);
    }

    #[test]
    fn a_device_goes_connected_on_tag_and_disconnected_on_remove_with_one_notice_each() {
        let hub = Hub::default();
        let notices = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = notices.clone();
        hub.watch_devices(Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }));
        let (tx, _rx) = sync_channel(QUEUE_CAP);
        let conn = hub.register(tx, Box::new(|| {}));
        assert_eq!(notices.load(Ordering::SeqCst), 0, "an untagged connection is nobody's device");
        hub.tag_device(conn, "phone");
        assert!(hub.connected_devices().contains("phone"));
        assert_eq!(notices.load(Ordering::SeqCst), 1);
        hub.remove(conn);
        assert!(hub.connected_devices().is_empty());
        assert_eq!(notices.load(Ordering::SeqCst), 2);
    }
}
