//! Subscriptions. `publish` runs on whatever thread noticed the event, which
//! for a chat session is the agent's stdout reader, so it must never block on a
//! client: each connection has a bounded outbound queue, and a client that lets
//! its queue fill is dropped rather than waited for.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::Mutex;

use serde_json::{json, Value};

use super::frame::{to_line, Notification};

/// Lines a connection may have queued before it counts as not reading.
pub const QUEUE_CAP: usize = 256;

/// What the wire calls a topic. Named apart from it because "Topic" already
/// means a feature workspace in this codebase.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Channel {
    Sessions,
    Session(String),
    Accounts,
    Autopilot,
}

impl Channel {
    pub fn parse(topic: &str) -> Option<Self> {
        match topic {
            "sessions" => Some(Channel::Sessions),
            "accounts" => Some(Channel::Accounts),
            "autopilot" => Some(Channel::Autopilot),
            _ => topic.strip_prefix("session:").filter(|id| !id.is_empty()).map(|id| Channel::Session(id.to_string())),
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
}

#[derive(Default)]
pub struct Hub {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next: ConnId,
    conns: HashMap<ConnId, Conn>,
}

impl Hub {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        }
    }

    pub fn register(&self, tx: SyncSender<String>, close: Box<dyn Fn() + Send>) -> ConnId {
        let mut inner = self.lock();
        inner.next += 1;
        let id = inner.next;
        inner.conns.insert(id, Conn { tx, close, channels: HashSet::new() });
        id
    }

    pub fn remove(&self, conn: ConnId) {
        self.lock().conns.remove(&conn);
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
        let line = to_line(&Notification::new("event", json!({ "topic": channel.to_string(), "data": data })));
        let mut inner = self.lock();
        let mut dropped = Vec::new();
        for (id, conn) in inner.conns.iter().filter(|(_, c)| c.channels.contains(channel)) {
            match conn.tx.try_send(line.clone()) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => dropped.push(*id),
            }
        }
        for id in dropped {
            if let Some(conn) = inner.conns.remove(&id) {
                (conn.close)();
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::events::{session_event, Place};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::sync::Arc;

    #[test]
    fn channels_round_trip_through_their_wire_names() {
        for topic in ["sessions", "session:abc", "accounts", "autopilot"] {
            assert_eq!(Channel::parse(topic).unwrap().to_string(), topic);
        }
        assert_eq!(Channel::parse("session:"), None);
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
    fn removing_a_connection_leaves_no_subscription_behind() {
        let hub = Hub::default();
        let (tx, _rx) = sync_channel(QUEUE_CAP);
        let id = hub.register(tx, Box::new(|| {}));
        hub.subscribe(id, Channel::Sessions);
        hub.subscribe(id, Channel::Session("s1".into()));
        hub.remove(id);
        assert_eq!(hub.subscriptions(), 0);
    }
}
