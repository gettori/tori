//! Methods only the webview can answer today (spawn, open, quota): each call is
//! emitted as `rpc://request {rid, method, params}` and waits for the matching
//! `rpc_reply`. When #212 moves that state into Rust, the method stops coming
//! through here and the wire stays the same.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use super::frame::{RpcError, INTERNAL_ERROR, REFUSED};

pub const REQUEST_EVENT: &str = "rpc://request";
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(10);

type Emit = Box<dyn Fn(Value) -> Result<(), String> + Send + Sync>;

pub struct Bridge {
    emit: Emit,
    pending: Mutex<HashMap<u64, SyncSender<Result<Value, String>>>>,
    next: AtomicU64,
    timeout: Duration,
}

impl Bridge {
    pub fn new(emit: Emit, timeout: Duration) -> Self {
        Bridge { emit, pending: Mutex::default(), next: AtomicU64::new(1), timeout }
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let rid = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = sync_channel(1);
        self.pending().insert(rid, tx);
        if let Err(e) = (self.emit)(json!({ "rid": rid, "method": method, "params": params })) {
            self.pending().remove(&rid);
            return Err(RpcError::new(INTERNAL_ERROR, format!("could not reach the Tori window: {e}")));
        }
        let outcome = rx.recv_timeout(self.timeout);
        self.pending().remove(&rid);
        match outcome {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(message)) => Err(RpcError::new(REFUSED, message)),
            Err(_) => Err(RpcError::new(
                INTERNAL_ERROR,
                format!("the Tori window did not answer {method} within {}s", self.timeout.as_secs()),
            )),
        }
    }

    // A reply to a request that already timed out has nobody waiting, and is dropped.
    pub fn reply(&self, rid: u64, outcome: Result<Value, String>) {
        if let Some(tx) = self.pending().remove(&rid) {
            let _ = tx.try_send(outcome);
        }
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, SyncSender<Result<Value, String>>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, OnceLock};

    fn answering(answer: fn(&Value) -> Result<Value, String>) -> Arc<Bridge> {
        let slot: Arc<OnceLock<Arc<Bridge>>> = Arc::new(OnceLock::new());
        let to = slot.clone();
        let bridge = Arc::new(Bridge::new(
            Box::new(move |request| {
                let bridge = to.get().unwrap().clone();
                std::thread::spawn(move || bridge.reply(request["rid"].as_u64().unwrap(), answer(&request)));
                Ok(())
            }),
            Duration::from_secs(5),
        ));
        let _ = slot.set(bridge.clone());
        bridge
    }

    #[test]
    fn a_reply_answers_the_request_it_names() {
        let bridge = answering(|request| Ok(json!({ "echo": request["params"], "method": request["method"] })));
        let got = bridge.request("session.spawn", json!({ "folder": "/p" })).unwrap();
        assert_eq!(got, json!({ "echo": { "folder": "/p" }, "method": "session.spawn" }));
        assert!(bridge.pending().is_empty());
    }

    #[test]
    fn a_webview_error_comes_back_refused_with_its_message() {
        let bridge = answering(|_| Err("no agent enabled".into()));
        let err = bridge.request("session.spawn", json!({})).unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (REFUSED, "no agent enabled"));
    }

    #[test]
    fn nobody_answering_times_out_naming_the_window_and_a_late_reply_is_dropped() {
        let bridge = Bridge::new(Box::new(|_| Ok(())), Duration::from_millis(50));
        let err = bridge.request("window.open", json!({})).unwrap_err();
        assert!(err.message.contains("Tori window did not answer window.open"), "{}", err.message);
        assert!(bridge.pending().is_empty());
        bridge.reply(1, Ok(json!({})));
    }

    #[test]
    fn a_failed_emit_fails_the_call_at_once() {
        let bridge = Bridge::new(Box::new(|_| Err("no window".into())), Duration::from_secs(5));
        let err = bridge.request("window.open", json!({})).unwrap_err();
        assert!(err.message.contains("no window"), "{}", err.message);
        assert!(bridge.pending().is_empty());
    }
}
