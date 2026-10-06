//! The calling side of the app socket, for the `tori` CLI. Blocking and one
//! connection per command: a CLI run is short, and `events` is the only one
//! that stays.

use std::collections::VecDeque;
use std::fmt;
use std::io::{self, BufRead, BufReader, Write};

use serde_json::{json, Value};

use super::frame::{to_line, RpcError};
use super::{bridge_path, ENV_CALLER, ENV_SOCK};
use crate::platform::ipc::{self, UnixStream};

// `File` means Tori did not start this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Found {
    Env,
    File,
}

pub struct Endpoint {
    pub sock: String,
    pub token: String,
    pub found: Found,
}

// Env first, the bridge file second, the same order every front uses.
pub fn locate() -> Option<Endpoint> {
    let env = |key| std::env::var(key).ok().filter(|v: &String| !v.is_empty());
    if let (Some(sock), Some(token)) = (env(ENV_SOCK), env(ENV_CALLER)) {
        return Some(Endpoint {
            sock,
            token,
            found: Found::Env,
        });
    }
    let (sock, token) = crate::credential::socket_in_file(&bridge_path())?;
    Some(Endpoint {
        sock,
        token,
        found: Found::File,
    })
}

#[derive(Debug)]
pub enum ClientError {
    Io(io::Error),
    Rpc(RpcError),
    Closed,
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Io(e) => write!(f, "{e}"),
            ClientError::Rpc(e) => write!(f, "{} ({})", e.message, e.code),
            ClientError::Closed => write!(f, "Tori closed the connection"),
        }
    }
}

impl From<io::Error> for ClientError {
    fn from(e: io::Error) -> Self {
        ClientError::Io(e)
    }
}

pub struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: u64,
    // Events that arrived while a call was waiting for its reply.
    events: VecDeque<Value>,
}

impl Client {
    pub fn connect(endpoint: &Endpoint) -> Result<Self, ClientError> {
        let writer = ipc::connect(&endpoint.sock)?;
        let reader = BufReader::new(writer.try_clone()?);
        let mut client = Client {
            reader,
            writer,
            next_id: 0,
            events: VecDeque::new(),
        };
        client.call("auth", json!({ "token": endpoint.token }))?;
        Ok(client)
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, ClientError> {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.writer.write_all(to_line(&request).as_bytes())?;
        loop {
            let message = self.read()?.ok_or(ClientError::Closed)?;
            if message.get("method").and_then(Value::as_str) == Some("event") {
                self.events.push_back(message["params"].clone());
                continue;
            }
            // A null id answers a frame the server could not read, and a refused
            // auth, so it belongs to the call in flight.
            let answers = message.get("id").is_some_and(|v| v.is_null() || v.as_u64() == Some(id));
            if !answers {
                continue;
            }
            if let Some(error) = message.get("error") {
                let error =
                    serde_json::from_value(error.clone()).unwrap_or_else(|_| RpcError::new(0, error.to_string()));
                return Err(ClientError::Rpc(error));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    pub fn next_event(&mut self) -> Result<Option<Value>, ClientError> {
        if let Some(event) = self.events.pop_front() {
            return Ok(Some(event));
        }
        while let Some(message) = self.read()? {
            if message.get("method").and_then(Value::as_str) == Some("event") {
                return Ok(Some(message["params"].clone()));
            }
        }
        Ok(None)
    }

    fn read(&mut self) -> Result<Option<Value>, ClientError> {
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = self.reader.read_until(b'\n', &mut line)?;
            if n == 0 {
                return Ok(None);
            }
            let text = String::from_utf8_lossy(&line);
            if text.trim().is_empty() {
                continue;
            }
            return serde_json::from_str(text.trim())
                .map(Some)
                .map_err(|e| ClientError::Io(e.into()));
        }
    }
}
