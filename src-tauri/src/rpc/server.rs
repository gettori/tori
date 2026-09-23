//! Connection handling and dispatch, written against [`Transport`] and
//! [`Stream`] only. One thread reads a connection and one writes it; the writer
//! drains the connection's queue, which is the only thing that ever touches the
//! socket's write half after auth.

use std::io::BufReader;
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::auth::{authenticate, Credential};
use super::frame::{
    read_request, to_line, write_line, ReadError, Request, Response, RpcError, INVALID_PARAMS, INVALID_REQUEST,
    METHOD_NOT_FOUND, UNAUTHORIZED,
};
use super::hub::{Channel, ConnId, Hub, QUEUE_CAP};
use super::transport::{Stream, Transport};

pub const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListParams {
    pub cwd: Option<String>,
    pub live: Option<bool>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TailParams {
    pub id: String,
    pub agent: String,
    pub limit: Option<usize>,
}

/// What the methods read. Tauri state in the app, a stub in tests.
pub trait Backend: Send + Sync {
    fn sessions_list(&self, params: ListParams) -> Result<Value, RpcError>;
    fn session_tail(&self, params: TailParams) -> Result<Value, RpcError>;
}

pub struct Server {
    pub credential: Credential,
    pub hub: Arc<Hub>,
    pub backend: Box<dyn Backend>,
    pub auth_timeout: Duration,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TopicParams {
    topic: String,
}

fn params<T: DeserializeOwned>(value: &Value) -> Result<T, RpcError> {
    let value = if value.is_null() { json!({}) } else { value.clone() };
    serde_json::from_value(value).map_err(|e| RpcError::new(INVALID_PARAMS, e.to_string()))
}

fn channel(value: &Value) -> Result<Channel, RpcError> {
    let TopicParams { topic } = params(value)?;
    Channel::parse(&topic).ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("unknown topic {topic}")))
}

impl Server {
    pub fn dispatch(&self, conn: ConnId, req: &Request) -> Result<Value, RpcError> {
        match req.method.as_str() {
            "subscribe" => {
                self.hub.subscribe(conn, channel(&req.params)?);
                Ok(json!({}))
            }
            "unsubscribe" => {
                self.hub.unsubscribe(conn, &channel(&req.params)?);
                Ok(json!({}))
            }
            "sessions.list" => self.backend.sessions_list(params(&req.params)?),
            "session.tail" => self.backend.session_tail(params(&req.params)?),
            "auth" => Err(RpcError::new(INVALID_REQUEST, "already authenticated")),
            other => Err(RpcError::new(METHOD_NOT_FOUND, format!("no method {other}"))),
        }
    }
}

/// Accept on its own thread until the transport shuts down.
pub fn serve(transport: Arc<dyn Transport>, server: Arc<Server>) {
    thread::spawn(move || loop {
        match transport.accept() {
            Ok(Some(stream)) => {
                let server = server.clone();
                thread::spawn(move || handle(&server, stream));
            }
            Ok(None) => break,
            // A failed accept (a client that hung up mid handshake) is that
            // client's problem, not a reason to stop listening.
            Err(_) => continue,
        }
    });
}

fn handle(server: &Server, mut stream: Box<dyn Stream>) {
    let Ok(read_half) = stream.try_clone_box() else { return };
    let mut reader = BufReader::new(read_half);

    // Bounded, so a client that connects and says nothing does not hold a
    // thread forever.
    let _ = stream.set_read_timeout(Some(server.auth_timeout));
    let refused = match read_request(&mut reader) {
        Ok(Some(first)) => match authenticate(&first, &server.credential) {
            Ok(_) => {
                let reply = Response::ok(first.id.clone().unwrap_or(Value::Null), json!({}));
                if write_line(&mut stream, &to_line(&reply)).is_err() {
                    return;
                }
                None
            }
            Err(e) => Some(Response::err(first.id.clone().unwrap_or(Value::Null), e.rpc())),
        },
        Ok(None) => return,
        Err(ReadError::Io(_)) => Some(Response::err(Value::Null, RpcError::new(UNAUTHORIZED, "no auth frame in time"))),
        Err(e) => Some(Response::err(Value::Null, e.rpc())),
    };
    if let Some(reply) = refused {
        let _ = write_line(&mut stream, &to_line(&reply));
        stream.close();
        return;
    }
    let _ = stream.set_read_timeout(None);

    let (tx, rx) = sync_channel::<String>(QUEUE_CAP);
    let Ok(closer) = stream.try_clone_box() else { return };
    let conn = server.hub.register(tx.clone(), Box::new(move || closer.close()));
    let writer = thread::spawn(move || {
        for line in rx {
            if write_line(&mut stream, &line).is_err() {
                break;
            }
        }
        stream.close();
    });

    loop {
        let reply = match read_request(&mut reader) {
            Ok(None) | Err(ReadError::Io(_)) => break,
            Ok(Some(req)) => {
                let outcome = server.dispatch(conn, &req);
                match req.id {
                    Some(id) => Response::reply(id, outcome),
                    None => continue,
                }
            }
            Err(ReadError::TooLarge) => {
                let _ = tx.send(to_line(&Response::err(Value::Null, ReadError::TooLarge.rpc())));
                break;
            }
            Err(ReadError::Bad(e)) => Response::err(Value::Null, e),
        };
        // Blocking is fine here: it only ever stalls this client's own reader.
        if tx.send(to_line(&reply)).is_err() {
            break;
        }
    }
    server.hub.remove(conn);
    drop(tx);
    let _ = writer.join();
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::rpc::transport::UnixTransport;
    use std::io::{BufRead, Write};
    use std::os::unix::net::UnixStream;

    pub struct StubBackend;

    impl Backend for StubBackend {
        fn sessions_list(&self, p: ListParams) -> Result<Value, RpcError> {
            Ok(json!([{ "id": "s1", "limit": p.limit }]))
        }
        fn session_tail(&self, p: TailParams) -> Result<Value, RpcError> {
            Ok(json!([{ "id": p.id }]))
        }
    }

    pub struct Running {
        pub transport: Arc<UnixTransport>,
        pub hub: Arc<Hub>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.transport.shutdown();
        }
    }

    pub fn start(timeout: Duration) -> Running {
        let transport = Arc::new(UnixTransport::bind().unwrap());
        let hub = Arc::new(Hub::default());
        let server = Arc::new(Server {
            credential: Credential::Token("tok".into()),
            hub: hub.clone(),
            backend: Box::new(StubBackend),
            auth_timeout: timeout,
        });
        serve(transport.clone(), server);
        Running { transport, hub }
    }

    pub struct Client {
        out: UnixStream,
        input: BufReader<UnixStream>,
    }

    impl Client {
        pub fn connect(r: &Running) -> Self {
            let out = UnixStream::connect(r.transport.sock_path()).unwrap();
            out.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let input = BufReader::new(out.try_clone().unwrap());
            Self { out, input }
        }
        pub fn send(&mut self, v: Value) {
            self.out.write_all(format!("{v}\n").as_bytes()).unwrap();
        }
        pub fn send_raw(&mut self, raw: &str) {
            self.out.write_all(raw.as_bytes()).unwrap();
        }
        /// The next line, or `None` once the server has closed.
        pub fn recv(&mut self) -> Option<Value> {
            let mut line = String::new();
            match self.input.read_line(&mut line) {
                Ok(0) | Err(_) => None,
                Ok(_) => Some(serde_json::from_str(&line).unwrap()),
            }
        }
        pub fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
            self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
            self.recv().expect("a reply")
        }
    }

    fn authed(r: &Running) -> Client {
        let mut c = Client::connect(r);
        let ok = c.call(0, "auth", json!({"token": "tok"}));
        assert_eq!(ok["result"], json!({}), "{ok}");
        c
    }

    fn refused(c: &mut Client) {
        let reply = c.recv().expect("an error before the close");
        assert_eq!(reply["error"]["code"], json!(UNAUTHORIZED), "{reply}");
        assert!(c.recv().is_none(), "then the connection closes");
    }

    #[test]
    fn a_correct_token_allows_the_next_call() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(c.call(1, "sessions.list", json!({"limit": 3}))["result"], json!([{"id": "s1", "limit": 3}]));
        assert_eq!(c.call(2, "session.tail", json!({"id": "s9", "agent": "claude"}))["result"], json!([{"id": "s9"}]));
    }

    #[test]
    fn wrong_or_missing_tokens_and_a_non_auth_first_frame_are_closed() {
        let r = start(AUTH_TIMEOUT);
        for first in [
            json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {"token": "nope"}}),
            json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {}}),
            json!({"jsonrpc": "2.0", "id": 0, "method": "sessions.list", "params": {"token": "tok"}}),
        ] {
            let mut c = Client::connect(&r);
            c.send(first);
            refused(&mut c);
        }
    }

    #[test]
    fn a_silent_client_is_closed_after_the_timeout() {
        let r = start(Duration::from_millis(100));
        let mut c = Client::connect(&r);
        refused(&mut c);
    }

    #[test]
    fn unknown_methods_bad_params_and_malformed_lines_answer_without_closing() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(c.call(1, "nope", json!({}))["error"]["code"], json!(METHOD_NOT_FOUND));
        assert_eq!(c.call(2, "session.tail", json!({"id": 1}))["error"]["code"], json!(INVALID_PARAMS));
        assert_eq!(c.call(3, "subscribe", json!({"topic": "topics"}))["error"]["code"], json!(INVALID_PARAMS));
        c.send_raw("not json\n");
        assert_eq!(c.recv().unwrap()["error"]["code"], json!(crate::rpc::frame::PARSE_ERROR));
        assert_eq!(c.call(4, "sessions.list", Value::Null)["result"][0]["id"], json!("s1"));
    }

    #[test]
    fn a_subscriber_gets_events_and_a_disconnect_clears_it() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(c.call(1, "subscribe", json!({"topic": "sessions"}))["result"], json!({}));
        r.hub.publish(&Channel::Sessions, json!({"kind": "started", "id": "s1"}));
        let event = c.recv().unwrap();
        assert_eq!(event["method"], json!("event"));
        assert_eq!(event["params"]["data"]["id"], json!("s1"));

        drop(c);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while r.hub.subscriptions() > 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(r.hub.subscriptions(), 0);
    }
}
