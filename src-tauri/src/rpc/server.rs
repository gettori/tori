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
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use super::auth::{authenticate, Credential, Principal};
use super::frame::{
    read_request, to_line, write_line, ReadError, Request, Response, RpcError, INVALID_PARAMS, INVALID_REQUEST,
    METHOD_NOT_FOUND, REFUSED, UNAUTHORIZED,
};
use super::hub::{Channel, ConnId, Hub, QUEUE_CAP};
use super::table::{self, CallerKind};
use super::transport::{Stream, Transport};

pub const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListParams {
    /// Only sessions whose folder is this one or inside it.
    pub cwd: Option<String>,
    /// Only sessions running in this Tori right now.
    pub live: Option<bool>,
    /// At most this many rows, newest first (default 50).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TailParams {
    /// The session id.
    pub id: String,
    /// The session's agent, looked up from the live claims, then the index, when left out.
    pub agent: Option<String>,
    /// At most this many events, the last ones (default 50).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SteerParams {
    /// The live chat session to send to.
    pub id: String,
    /// The message, delivered as a steer mid turn or as the next turn otherwise.
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorktreeParams {
    /// The new branch, created in a new worktree.
    pub branch: String,
    /// The project folder, the caller's own project when left out.
    pub project: Option<String>,
    /// The ref the new branch starts from.
    pub from: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckpointsParams {
    /// The session id.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckpointParams {
    /// The session id.
    pub id: String,
    /// The turn, 1 based, in the order `checkpoints.list` returns.
    pub turn: usize,
    /// Revert even with other live sessions in the same folder.
    pub force: Option<bool>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnParams {
    /// The agent id, the caller's own agent when left out.
    pub agent: Option<String>,
    /// The agent account, the caller's own when the agent is the caller's.
    pub account: Option<String>,
    /// The folder to start in, the caller's own folder when left out.
    pub folder: Option<String>,
    /// The first message of the new session.
    pub prompt: Option<String>,
    /// Paths of files attached to the first message.
    pub attach: Option<Vec<String>>,
    /// Start in a new worktree on this new branch instead of `folder`.
    pub new_worktree: Option<String>,
    /// The project a `new_worktree` is made in, the caller's own when left out.
    pub project: Option<String>,
    /// The ref a `new_worktree` branches from.
    pub from: Option<String>,
    /// Mark the session as running unattended; `sessions.list` flags it `background`.
    pub background: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OpenParams {
    /// Path of the file to open in the editor.
    pub path: String,
    /// The 1 based line to put the cursor on.
    pub line: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BudgetParams {
    /// The session to report, the calling chat session when left out.
    pub id: Option<String>,
    /// The folder whose usage to report, the session's folder when left out.
    pub folder: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AskParams {
    /// The question shown to the user in the calling chat.
    pub question: String,
    /// Answers offered as buttons; the user can still type their own.
    pub options: Option<Vec<String>>,
    /// Seconds to wait for an answer before returning the id to poll with `ask.wait`.
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AskWaitParams {
    /// The id `ask.create` returned.
    pub id: String,
    /// Seconds to wait for the answer before returning null again.
    pub timeout: Option<u64>,
}

/// What the methods read. Tauri state in the app, a stub in tests.
pub trait Backend: Send + Sync {
    fn sessions_list(&self, params: ListParams) -> Result<Value, RpcError>;
    fn session_tail(&self, params: TailParams) -> Result<Value, RpcError>;
    fn caller(&self, principal: &Principal) -> Result<Value, RpcError>;
    fn session_steer(&self, principal: &Principal, params: SteerParams) -> Result<Value, RpcError>;
    fn worktree_new(&self, principal: &Principal, params: WorktreeParams) -> Result<Value, RpcError>;
    fn checkpoints_list(&self, params: CheckpointsParams) -> Result<Value, RpcError>;
    fn checkpoint_diff(&self, params: CheckpointParams) -> Result<Value, RpcError>;
    fn checkpoint_revert(&self, principal: &Principal, params: CheckpointParams) -> Result<Value, RpcError>;
    fn session_spawn(&self, principal: &Principal, params: SpawnParams) -> Result<Value, RpcError>;
    fn window_open(&self, params: OpenParams) -> Result<Value, RpcError>;
    fn budget(&self, principal: &Principal, params: BudgetParams) -> Result<Value, RpcError>;
    fn ask_create(&self, session: &str, params: AskParams) -> Result<Value, RpcError>;
    fn ask_wait(&self, params: AskWaitParams) -> Result<Value, RpcError>;
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

pub(super) fn params<T: DeserializeOwned>(value: &Value) -> Result<T, RpcError> {
    let value = if value.is_null() { json!({}) } else { value.clone() };
    serde_json::from_value(value).map_err(|e| RpcError::new(INVALID_PARAMS, e.to_string()))
}

fn channel(value: &Value) -> Result<Channel, RpcError> {
    let TopicParams { topic } = params(value)?;
    Channel::parse(&topic).ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("unknown topic {topic}")))
}

impl Server {
    pub fn dispatch(&self, conn: ConnId, principal: &Principal, req: &Request) -> Result<Value, RpcError> {
        match req.method.as_str() {
            "subscribe" => {
                self.hub.subscribe(conn, channel(&req.params)?);
                Ok(json!({}))
            }
            "unsubscribe" => {
                self.hub.unsubscribe(conn, &channel(&req.params)?);
                Ok(json!({}))
            }
            "auth" => Err(RpcError::new(INVALID_REQUEST, "already authenticated")),
            name => {
                let method = table::find(name).ok_or_else(|| RpcError::new(METHOD_NOT_FOUND, format!("no method {name}")))?;
                let kind = CallerKind::of(principal);
                if !method.callers.contains(&kind) {
                    let why = method.refusal.map(|r| format!(": {r}")).unwrap_or_default();
                    return Err(RpcError::new(REFUSED, format!("{name} is not open to a {} caller{why}", kind.name())));
                }
                (method.call)(self.backend.as_ref(), principal, &req.params)
            }
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
    let authed = match read_request(&mut reader) {
        Ok(Some(first)) => match authenticate(&first, &server.credential) {
            Ok(principal) => {
                let reply = Response::ok(first.id.clone().unwrap_or(Value::Null), json!({}));
                if write_line(&mut stream, &to_line(&reply)).is_err() {
                    return;
                }
                Ok(principal)
            }
            Err(e) => Err(Response::err(first.id.clone().unwrap_or(Value::Null), e.rpc())),
        },
        Ok(None) => return,
        Err(ReadError::Io(_)) => Err(Response::err(Value::Null, RpcError::new(UNAUTHORIZED, "no auth frame in time"))),
        Err(e) => Err(Response::err(Value::Null, e.rpc())),
    };
    let principal = match authed {
        Ok(principal) => principal,
        Err(reply) => {
            let _ = write_line(&mut stream, &to_line(&reply));
            stream.close();
            return;
        }
    };
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
                let outcome = server.dispatch(conn, &principal, &req);
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
    use crate::rpc::auth::{Caller, Children};
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
        fn caller(&self, principal: &Principal) -> Result<Value, RpcError> {
            Ok(match principal {
                Principal::Local => json!("local"),
                Principal::Session(caller) => json!(caller),
            })
        }
        fn session_steer(&self, _: &Principal, p: SteerParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn worktree_new(&self, _: &Principal, p: WorktreeParams) -> Result<Value, RpcError> {
            Ok(json!({ "branch": p.branch }))
        }
        fn checkpoints_list(&self, p: CheckpointsParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn checkpoint_diff(&self, p: CheckpointParams) -> Result<Value, RpcError> {
            Ok(json!({ "turn": p.turn }))
        }
        fn checkpoint_revert(&self, _: &Principal, p: CheckpointParams) -> Result<Value, RpcError> {
            Ok(json!({ "turn": p.turn }))
        }
        fn session_spawn(&self, _: &Principal, p: SpawnParams) -> Result<Value, RpcError> {
            Ok(json!({ "folder": p.folder }))
        }
        fn window_open(&self, p: OpenParams) -> Result<Value, RpcError> {
            Ok(json!({ "path": p.path }))
        }
        fn budget(&self, _: &Principal, p: BudgetParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
        fn ask_create(&self, _: &str, p: AskParams) -> Result<Value, RpcError> {
            Ok(json!({ "question": p.question }))
        }
        fn ask_wait(&self, p: AskWaitParams) -> Result<Value, RpcError> {
            Ok(json!({ "id": p.id }))
        }
    }

    pub struct Running {
        pub transport: Arc<UnixTransport>,
        pub hub: Arc<Hub>,
        pub children: Arc<Children>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.transport.shutdown();
        }
    }

    pub fn start(timeout: Duration) -> Running {
        let transport = Arc::new(UnixTransport::bind().unwrap());
        let hub = Arc::new(Hub::default());
        let children = Arc::new(Children::default());
        let server = Arc::new(Server {
            credential: Credential { process: "tok".into(), children: children.clone() },
            hub: hub.clone(),
            backend: Box::new(StubBackend),
            auth_timeout: timeout,
        });
        serve(transport.clone(), server);
        Running { transport, hub, children }
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
    fn each_connection_keeps_the_caller_its_token_was_minted_for() {
        let r = start(AUTH_TIMEOUT);
        let tab = r.children.mint(Caller::Terminal("t1".into()));
        let chat = r.children.mint(Caller::Chat("s1".into()));
        let as_caller = |token: &str| {
            let mut c = Client::connect(&r);
            assert_eq!(c.call(0, "auth", json!({ "token": token }))["result"], json!({}));
            c.call(1, "caller", Value::Null)["result"].clone()
        };
        assert_eq!(as_caller(&tab), json!({"kind": "terminal", "id": "t1"}));
        assert_eq!(as_caller(&chat), json!({"kind": "chat", "id": "s1"}));
        assert_eq!(as_caller("tok"), json!("local"));

        r.children.revoke_token(&tab);
        let mut c = Client::connect(&r);
        c.send(json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {"token": tab}}));
        refused(&mut c);
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

    fn stub_server() -> Server {
        Server {
            credential: Credential { process: "tok".into(), children: Arc::default() },
            hub: Arc::default(),
            backend: Box::new(StubBackend),
            auth_timeout: AUTH_TIMEOUT,
        }
    }

    fn request(method: &str, params: Value) -> Request {
        serde_json::from_value(json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})).unwrap()
    }

    #[test]
    fn every_spawn_param_is_optional_and_described() {
        let schema = schemars::schema_for!(SpawnParams).to_value();
        let properties = schema["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 9);
        for (name, field) in properties {
            assert!(field["description"].as_str().is_some_and(|d| !d.is_empty()), "{name} has no description");
        }
        assert!(schema["required"].as_array().is_none_or(|r| r.is_empty()), "{schema}");
    }

    // Params built from each row's own schema, so a row added later is covered
    // without touching this test.
    #[test]
    fn every_row_dispatches_to_the_backend() {
        let server = stub_server();
        for method in table::METHODS {
            let schema = (method.params)().to_value();
            let mut sample = serde_json::Map::new();
            for field in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                let value = match schema["properties"][field]["type"].as_str() {
                    Some("integer") => json!(1),
                    Some("array") => json!([]),
                    Some("boolean") => json!(false),
                    _ => json!("x"),
                };
                sample.insert(field.to_string(), value);
            }
            let principal = match method.callers[0] {
                CallerKind::Local => Principal::Local,
                CallerKind::Terminal => Principal::Session(Caller::Terminal("t1".into())),
                CallerKind::Chat | CallerKind::Worker => Principal::Session(Caller::Chat("s1".into())),
            };
            let outcome = server.dispatch(0, &principal, &request(method.name, Value::Object(sample)));
            assert!(outcome.is_ok(), "{}: {outcome:?}", method.name);
        }
    }

    #[test]
    fn the_dispatcher_refuses_a_caller_kind_the_row_leaves_out() {
        let server = stub_server();
        let tab = Principal::Session(Caller::Terminal("t1".into()));
        let err = server.dispatch(0, &tab, &request("ask.create", json!({"question": "q"}))).unwrap_err();
        assert_eq!(err.code, REFUSED);
        assert!(err.message.contains("terminal") && err.message.contains("ask.create"), "{}", err.message);
        let chat = Principal::Session(Caller::Chat("s1".into()));
        assert!(server.dispatch(0, &chat, &request("ask.create", json!({"question": "q"}))).is_ok());
    }

    #[test]
    fn a_subscriber_gets_events_and_a_disconnect_clears_it() {
        let r = start(AUTH_TIMEOUT);
        let mut c = authed(&r);
        assert_eq!(c.call(1, "subscribe", json!({"topic": "sessions"}))["result"], json!({}));
        r.hub.publish(&Channel::Sessions, json!({"kind": "session.started", "id": "s1"}));
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
