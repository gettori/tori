//! `tori browser-host`: the native messaging host Chrome starts for the
//! extension, as `tori chrome-extension://<id>/`. It relays each frame to the
//! daemon as the Browser caller, tagged with the tab's worktree.
//!
//! One request at a time over one connection: the extension sends a frame and
//! waits, and nothing it may call streams.

use std::io::{self, Read, Write};

use serde_json::{json, Value};

use crate::rpc::client::{Client, ClientError, Endpoint, Found};
use crate::rpc::frame::REFUSED;

/// What Chrome accepts from a host in one message.
const TO_BROWSER_MAX: usize = 1024 * 1024;
/// What Chrome may send, so a corrupt length cannot ask for gigabytes.
const FROM_BROWSER_MAX: usize = 64 * 1024 * 1024;

const NOT_SET_UP: &str = "not set up: Tori > Settings > Browser > Install";
const NOT_RUNNING: &str = "Tori is not running";
const CLOSED: &str = "Tori closed the connection";
const REPLACED: &str = "this browser's credential was replaced or revoked: Tori > Settings > Browser > Install";

pub fn is_origin(arg: &str) -> bool {
    arg.starts_with("chrome-extension://")
}

pub fn run() -> i32 {
    let (mut stdin, mut stdout) = (io::stdin().lock(), io::stdout().lock());
    let mut daemon: Option<Client> = None;
    loop {
        let frame = match read_frame(&mut stdin) {
            Ok(Some(frame)) => frame,
            Ok(None) => return 0,
            Err(e) => {
                eprintln!("tori browser-host: {e}");
                return 1;
            }
        };
        let id = frame.get("id").cloned();
        let relayed = match daemon.as_mut() {
            Some(client) => relay(client, &frame),
            None => match connect() {
                Ok(client) => relay(daemon.insert(client), &frame),
                Err(refused) => Relayed::Answer(Err(refused)),
            },
        };
        let (outcome, lost) = match relayed {
            Relayed::Answer(outcome) => (outcome, false),
            Relayed::Lost(error) => (Err(error), true),
        };
        if let Some(id) = id {
            if write_frame(&mut stdout, &reply(id, outcome)).is_err() {
                return 0;
            }
        }
        // The extension starts a fresh host on the disconnect, which finds a
        // daemon that may have restarted or revoked this one.
        if lost {
            return 0;
        }
    }
}

enum Relayed {
    Answer(Result<Value, Value>),
    Lost(Value),
}

fn relay(client: &mut Client, frame: &Value) -> Relayed {
    let worktree = match frame["tab"]["url"].as_str().and_then(local_port) {
        Some(port) => match client.call("worktree.at", json!({ "port": port })) {
            Ok(unit) => unit["folder"].clone(),
            Err(ClientError::Rpc(_)) => Value::Null,
            Err(_) => return Relayed::Lost(refusal(CLOSED)),
        },
        None => Value::Null,
    };
    let method = frame["method"].as_str().unwrap_or_default();
    let tags = json!({ "tab": frame["tab"], "worktree": worktree });
    match client.call_tagged(method, frame["params"].clone(), &tags) {
        Ok(result) => Relayed::Answer(Ok(result)),
        Err(ClientError::Rpc(e)) => Relayed::Answer(Err(json!(e))),
        Err(_) => Relayed::Lost(refusal(CLOSED)),
    }
}

fn connect() -> Result<Client, Value> {
    let token = crate::rpc::browsers::read_token().ok_or_else(|| refusal(NOT_SET_UP))?;
    // The bridge file only, never TORI_SOCK: a browser opened from a Tori
    // terminal inherits that tab's own token in its environment.
    let (sock, _) =
        crate::credential::socket_in_file(&crate::rpc::bridge_path()).ok_or_else(|| refusal(NOT_RUNNING))?;
    let endpoint = Endpoint {
        sock,
        token,
        found: Found::File,
    };
    Client::connect(&endpoint).map_err(|e| match e {
        ClientError::Rpc(_) => refusal(REPLACED),
        _ => refusal(NOT_RUNNING),
    })
}

fn refusal(message: &str) -> Value {
    json!({ "code": REFUSED, "message": message })
}

fn reply(id: Value, outcome: Result<Value, Value>) -> Value {
    let message = match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    };
    if message.to_string().len() <= TO_BROWSER_MAX {
        return message;
    }
    json!({ "jsonrpc": "2.0", "id": message["id"], "error": refusal("the reply is over the 1 MB a browser accepts") })
}

fn local_port(url: &str) -> Option<u16> {
    let rest = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let (host, port) = authority.rsplit_once(':')?;
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
        .then(|| port.parse().ok())
        .flatten()
}

fn read_frame(input: &mut impl Read) -> io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        other => other?,
    }
    let len = u32::from_ne_bytes(len) as usize;
    if len > FROM_BROWSER_MAX {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame over 64 MiB"));
    }
    let mut body = vec![0u8; len];
    input.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn write_frame(output: &mut impl Write, message: &Value) -> io::Result<()> {
    let body = message.to_string();
    let len = u32::try_from(body.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame too long"))?;
    output.write_all(&len.to_ne_bytes())?;
    output.write_all(body.as_bytes())?;
    output.flush()
}
