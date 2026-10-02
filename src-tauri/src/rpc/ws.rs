//! The WebSocket front: the same framing, auth and dispatcher as the unix
//! socket, reached over TCP on one address the user picked. One text message
//! carries one JSON-RPC line each way.
//!
//! tungstenite cannot split a socket between a reader and a writer thread, so
//! each direction gets its own `WebSocketContext`, and every byte either one
//! writes (replies, events, pongs) goes out whole under one lock.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, Role, WebSocketConfig, WebSocketContext};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Error as WsError, Message};

use super::frame::MAX_FRAME;
use super::transport::{Stream, Transport};

/// Live connections past this are closed at accept. The unix socket needs no
/// cap because only local processes reach it.
pub const MAX_CONNECTIONS: usize = 8;

// Until the server sets its own auth timeout, a client that opens TCP and says
// nothing is dropped after this.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

// The listener is polled rather than woken by a self-connect, which fails once
// the picked address has left the machine and would leave the port held.
const ACCEPT_POLL: Duration = Duration::from_millis(100);

type Live = Arc<Mutex<HashMap<u64, Weak<Shared>>>>;

pub struct WsTransport {
    listener: Mutex<Option<TcpListener>>,
    addr: SocketAddr,
    stopping: AtomicBool,
    live: Live,
    next: AtomicU64,
}

impl WsTransport {
    pub fn bind(addr: SocketAddr) -> io::Result<Self> {
        let listener = TcpListener::bind(addr)?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        Ok(Self { listener: Mutex::new(Some(listener)), addr, stopping: AtomicBool::new(false), live: Live::default(), next: AtomicU64::new(0) })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    fn live(&self) -> MutexGuard<'_, HashMap<u64, Weak<Shared>>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Transport for WsTransport {
    fn accept(&self) -> io::Result<Option<Box<dyn Stream>>> {
        loop {
            let accepted = match self.listener.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                None => return Ok(None),
                Some(listener) => listener.accept(),
            };
            let tcp = match accepted {
                Ok((tcp, _)) => tcp,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(ACCEPT_POLL);
                    continue;
                }
                Err(e) => return Err(e),
            };
            // Checked under the same lock `shutdown` closes them under, so a
            // connection is either recorded in time to be closed or never served.
            let mut live = self.live();
            if self.stopping.load(Ordering::SeqCst) {
                return Ok(None);
            }
            if live.len() >= MAX_CONNECTIONS {
                let _ = tcp.shutdown(Shutdown::Both);
                continue;
            }
            tcp.set_nonblocking(false)?;
            tcp.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
            let id = self.next.fetch_add(1, Ordering::Relaxed);
            let stream = WsStream::new(tcp, id, self.live.clone())?;
            live.insert(id, Arc::downgrade(&stream.0));
            return Ok(Some(Box::new(stream)));
        }
    }

    /// Idempotent. Frees the port at once and closes every stream it accepted,
    /// mid handshake included, so switching the front off drops everyone.
    fn shutdown(&self) {
        self.listener.lock().unwrap_or_else(|e| e.into_inner()).take();
        let streams: Vec<Arc<Shared>> = {
            let live = self.live();
            self.stopping.store(true, Ordering::SeqCst);
            live.values().filter_map(Weak::upgrade).collect()
        };
        // Outside the lock: the last handle going runs `Shared::drop`, which takes it.
        for shared in streams {
            WsStream(shared).close_with(CloseCode::Away);
        }
    }
}

/// The phone app's webview, per platform.
const APP_ORIGINS: [&str; 3] = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];

// A browser always names the page it runs, so any web page the user has open
// could reach this port. A client that is not a browser sends no origin. A dev
// build also takes the Vite page and `dev/remote-probe.html`.
fn origin_allowed(origin: Option<&str>, dev: bool) -> bool {
    match origin {
        None => true,
        Some(origin) => dev || APP_ORIGINS.contains(&origin),
    }
}

struct Shared {
    tcp: TcpStream,
    // Until the upgrade, a write would put a frame on a connection that is
    // still plain HTTP.
    upgraded: AtomicBool,
    // A close frame went out, the reply to the client's or our own; a second
    // one would break the closing handshake.
    closing: AtomicBool,
    reader: Mutex<Reader>,
    writer: Mutex<Writer>,
    id: u64,
    live: Live,
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.live.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

struct Reader {
    ctx: Option<WebSocketContext>,
    tcp: TcpStream,
    out: Out,
    rest_of_line: Vec<u8>,
}

struct Writer {
    ctx: WebSocketContext,
    out: Out,
    line: Vec<u8>,
}

/// One context's writes. Bytes are held until `flush`, which a context calls
/// only between whole frames, and then written under the socket's one lock, so
/// a pong from the reader never lands inside a reply from the writer.
struct Out {
    tcp: Arc<Mutex<TcpStream>>,
    held: Vec<u8>,
}

impl Write for Out {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.held.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        let result = self.tcp.lock().unwrap_or_else(|e| e.into_inner()).write_all(&self.held);
        self.held.clear();
        result
    }
}

// A context's stream must also read; the writer's never does.
impl Read for Out {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::ErrorKind::Unsupported.into())
    }
}

struct Io<'a> {
    tcp: &'a mut TcpStream,
    out: &'a mut Out,
}

impl Read for Io<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.tcp.read(buf)
    }
}

impl Write for Io<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.out.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME))
}

fn io_error(e: WsError) -> io::Error {
    match e {
        WsError::Io(e) => e,
        other => io::Error::other(other),
    }
}

#[derive(Clone)]
struct WsStream(Arc<Shared>);

impl WsStream {
    fn new(tcp: TcpStream, id: u64, live: Live) -> io::Result<Self> {
        let socket = Arc::new(Mutex::new(tcp.try_clone()?));
        let out = |tcp: &Arc<Mutex<TcpStream>>| Out { tcp: tcp.clone(), held: Vec::new() };
        let reader = Reader { ctx: None, tcp: tcp.try_clone()?, out: out(&socket), rest_of_line: Vec::new() };
        let writer = Writer { ctx: WebSocketContext::new(Role::Server, Some(config())), out: out(&socket), line: Vec::new() };
        Ok(Self(Arc::new(Shared { tcp, upgraded: AtomicBool::new(false), closing: AtomicBool::new(false), reader: Mutex::new(reader), writer: Mutex::new(writer), id, live })))
    }

    // A browser reports a connection that ends with no close frame as abnormal
    // (1006). The frame is skipped while a write holds the writer, since
    // waiting on a stalled client is what closing it is for.
    fn close_with(&self, code: CloseCode) {
        if self.0.upgraded.load(Ordering::SeqCst) && !self.0.closing.swap(true, Ordering::SeqCst) {
            if let Ok(mut writer) = self.0.writer.try_lock() {
                let Writer { ctx, out, .. } = &mut *writer;
                if ctx.write(out, Message::Close(Some(CloseFrame { code, reason: "".into() }))).is_ok() {
                    let _ = ctx.flush(out);
                }
            }
        }
        let _ = self.0.tcp.shutdown(Shutdown::Both);
    }

    fn handshake(reader: &mut Reader) -> io::Result<()> {
        let from_the_app = |request: &Request, response: Response| {
            let origin = request.headers().get("origin").and_then(|o| o.to_str().ok());
            if origin_allowed(origin, cfg!(debug_assertions)) {
                Ok(response)
            } else {
                Err(ErrorResponse::new(Some("this origin is not the Tori app".into())))
            }
        };
        // A browser waits for the 101 before it sends a frame, so nothing is
        // left buffered behind the request when the handshake hands back.
        tungstenite::accept_hdr(reader.tcp.try_clone()?, from_the_app).map_err(|e| io::Error::other(e.to_string()))?;
        reader.ctx = Some(WebSocketContext::new(Role::Server, Some(config())));
        Ok(())
    }
}

impl Read for WsStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut reader = self.0.reader.lock().unwrap_or_else(|e| e.into_inner());
        if reader.ctx.is_none() {
            Self::handshake(&mut reader)?;
            self.0.upgraded.store(true, Ordering::SeqCst);
        }
        while reader.rest_of_line.is_empty() {
            let Reader { ctx, tcp, out, rest_of_line } = &mut *reader;
            let ctx = ctx.as_mut().expect("handshake done above");
            match ctx.read(&mut Io { tcp, out }) {
                Ok(Message::Text(text)) => {
                    // A line break is whitespace between JSON tokens and is
                    // escaped inside strings, so a pretty-printed request stays one line.
                    rest_of_line.extend(text.as_str().as_bytes().iter().map(|&b| if b == b'\n' || b == b'\r' { b' ' } else { b }));
                    rest_of_line.push(b'\n');
                }
                Ok(Message::Close(_)) => {
                    // tungstenite queued the reply and there is no next read to
                    // send it. Its flush buffers the frame, then answers
                    // `ConnectionClosed` before flushing the stream, so `out` is
                    // flushed here or the reply never leaves.
                    self.0.closing.store(true, Ordering::SeqCst);
                    let _ = ctx.flush(&mut Io { tcp, out });
                    let _ = out.flush();
                    return Ok(0);
                }
                Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => return Ok(0),
                Ok(_) => {}
                Err(e) => return Err(io_error(e)),
            }
        }
        let n = buf.len().min(reader.rest_of_line.len());
        buf[..n].copy_from_slice(&reader.rest_of_line[..n]);
        reader.rest_of_line.drain(..n);
        Ok(n)
    }
}

impl Write for WsStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if !self.0.upgraded.load(Ordering::SeqCst) {
            return Err(io::ErrorKind::NotConnected.into());
        }
        let mut writer = self.0.writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.line.extend_from_slice(buf);
        while let Some(end) = writer.line.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = writer.line.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line[..end]).into_owned();
            let Writer { ctx, out, .. } = &mut *writer;
            ctx.write(out, Message::text(text)).map_err(io_error)?;
            ctx.flush(out).map_err(io_error)?;
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Stream for WsStream {
    fn try_clone_box(&self) -> io::Result<Box<dyn Stream>> {
        Ok(Box::new(self.clone()))
    }
    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.0.tcp.set_read_timeout(timeout)
    }
    fn close(&self) {
        self.close_with(CloseCode::Normal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::auth::Credential;
    use crate::rpc::devices::Devices;
    use crate::rpc::hub::{Channel, Hub};
    use crate::rpc::pairing::Pairing;
    use crate::rpc::server::tests::StubBackend;
    use crate::rpc::server::{serve, Server};
    use serde_json::{json, Value};
    use std::time::Instant;

    type Client = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

    struct Front {
        transport: Arc<WsTransport>,
        hub: Arc<Hub>,
        devices: Arc<Devices>,
        pairing: Arc<Pairing>,
        credential: String,
        dir: std::path::PathBuf,
    }

    impl Drop for Front {
        fn drop(&mut self) {
            self.transport.shutdown();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn front(auth_timeout: Duration) -> Front {
        let dir = std::env::temp_dir().join(format!("tori-ws-{}-{}", std::process::id(), crate::chat::approval::random_token()));
        let devices = Arc::new(Devices::open(dir.join("devices.json")));
        let credential = devices.mint("test").unwrap().1;
        let transport = Arc::new(WsTransport::bind("127.0.0.1:0".parse().unwrap()).unwrap());
        let hub = Arc::new(Hub::default());
        let server = Arc::new(Server { hub: hub.clone(), backend: Box::<StubBackend>::default(), auth_timeout });
        let pairing = Arc::new(Pairing::new(Box::new(|_| {})));
        serve(transport.clone(), Arc::new(Credential::Remote { devices: devices.clone(), pairing: pairing.clone() }), server);
        Front { transport, hub, devices, pairing, credential, dir }
    }

    fn connect(front: &Front) -> tungstenite::Result<Client> {
        let (client, _) = tungstenite::connect(format!("ws://{}", front.transport.addr()))?;
        Ok(client)
    }

    fn json_of(message: Message) -> Option<Value> {
        match message {
            Message::Text(text) => Some(serde_json::from_str(text.as_str()).expect("every text frame is one whole JSON line")),
            _ => None,
        }
    }

    fn call(client: &mut Client, id: u64, method: &str, params: Value) -> Value {
        client.send(Message::text(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string())).unwrap();
        loop {
            if let Some(reply) = json_of(client.read().unwrap()).filter(|v| v["id"] == json!(id)) {
                return reply;
            }
        }
    }

    fn authed(front: &Front) -> Client {
        let mut client = connect(front).unwrap();
        assert_eq!(call(&mut client, 0, "auth", json!({ "token": front.credential }))["result"], json!({}));
        client
    }

    fn closed(stream: &mut TcpStream, within: Duration) -> bool {
        stream.set_read_timeout(Some(within)).unwrap();
        let started = Instant::now();
        let mut buf = [0u8; 512];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => return started.elapsed() < within,
                Ok(_) => continue,
                Err(e) if e.kind() == io::ErrorKind::ConnectionReset => return true,
                Err(_) => return false,
            }
        }
    }

    fn wait_for(what: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if what() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn replies_events_and_pongs_share_the_socket_without_breaking_a_frame() {
        let front = front(Duration::from_secs(5));
        let mut client = authed(&front);
        assert_eq!(call(&mut client, 1, "subscribe", json!({"topic": "sessions"}))["result"], json!({}));

        let hub = front.hub.clone();
        let publisher = std::thread::spawn(move || {
            for n in 0..100 {
                hub.publish(&Channel::Sessions, json!({ "kind": "session.started", "n": n, "pad": "x".repeat(2000) }));
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        for id in 10..30 {
            client.send(Message::text(json!({"jsonrpc": "2.0", "id": id, "method": "sessions.list", "params": {}}).to_string())).unwrap();
            if id == 15 {
                client.send(Message::Ping("are you there".into())).unwrap();
            }
        }
        let (mut replies, mut events, mut pong) = (0, 0, false);
        while replies < 20 || events < 100 || !pong {
            match client.read().unwrap() {
                Message::Pong(data) => pong = data.as_ref() == b"are you there",
                message => match json_of(message) {
                    Some(v) if v["result"][0]["id"] == json!("s1") => replies += 1,
                    Some(v) if v["method"] == json!("event") => events += 1,
                    other => panic!("unexpected {other:?}"),
                },
            }
        }
        publisher.join().unwrap();
    }

    #[test]
    fn a_client_that_opens_tcp_and_says_nothing_is_closed() {
        let front = front(Duration::from_millis(200));
        let mut silent = TcpStream::connect(front.transport.addr()).unwrap();
        assert!(closed(&mut silent, Duration::from_secs(2)));
    }

    #[test]
    fn the_ninth_live_connection_is_refused_and_a_closed_one_frees_its_slot() {
        let front = front(Duration::from_secs(5));
        let mut live: Vec<Client> = (0..MAX_CONNECTIONS).map(|_| authed(&front)).collect();
        assert!(connect(&front).is_err(), "a ninth is refused while eight are live");

        live.drain(..).for_each(drop);
        assert!(wait_for(|| front.transport.live().is_empty()), "every closed connection gave its slot back");
        let mut ninth = authed(&front);
        assert_eq!(call(&mut ninth, 1, "sessions.list", json!({}))["result"][0]["id"], json!("s1"));
    }

    #[test]
    fn pairing_answers_then_closes_and_the_credential_authenticates_next_time() {
        let front = front(Duration::from_secs(5));
        let offer = front.pairing.start("ws://x", crate::owned_state::now_ms()).unwrap();
        let mut pairer = connect(&front).unwrap();
        let reply = call(&mut pairer, 0, "pair", json!({ "code": offer.code, "name": "probe" }));
        assert_eq!(reply["result"]["name"], json!("probe"));
        match pairer.read() {
            Ok(Message::Close(Some(frame))) => assert_eq!(u16::from(frame.code), 1000),
            other => panic!("the pairing connection is closed, got {other:?}"),
        }

        let mut device = connect(&front).unwrap();
        assert_eq!(call(&mut device, 0, "auth", json!({ "token": reply["result"]["credential"] }))["result"], json!({}));
        let mut again = connect(&front).unwrap();
        assert!(call(&mut again, 0, "pair", json!({ "code": offer.code }))["error"].is_object(), "a used code is refused");
    }

    #[test]
    fn revoking_a_device_drops_its_live_connection_and_refuses_it_after() {
        let front = front(Duration::from_secs(5));
        let mut client = authed(&front);
        let id = front.devices.list()[0].id.clone();
        assert_eq!(front.devices.revoke(&id), Ok(true));
        front.hub.close_device(&id);
        match client.read() {
            Ok(Message::Close(_)) => {}
            other => panic!("the revoked device is closed, got {other:?}"),
        }
        let mut back = connect(&front).unwrap();
        assert!(call(&mut back, 0, "auth", json!({ "token": front.credential }))["error"].is_object());
    }

    #[test]
    fn shutdown_drops_a_connection_still_in_its_handshake() {
        let front = front(Duration::from_secs(30));
        let mut pending = TcpStream::connect(front.transport.addr()).unwrap();
        assert!(wait_for(|| front.transport.live().len() == 1));
        front.transport.shutdown();
        assert!(closed(&mut pending, Duration::from_secs(2)));
    }
}
