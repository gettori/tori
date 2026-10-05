//! Newline delimited JSON-RPC 2.0: one message per line, both directions.

use std::io::{self, BufRead, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A hostile or runaway peer does not get to allocate without bound. Requests
/// are small; the large payloads (a tail) only ever travel outward.
pub const MAX_FRAME: usize = 256 * 1024;

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
pub const UNAUTHORIZED: i64 = -32001;
// Tori understood the call and said no, or the work behind it failed.
pub const REFUSED: i64 = -32002;

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    /// `None` makes it a notification, which gets no response. An explicit
    /// `null` id reads the same way; nothing here needs to tell them apart.
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Response {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(error),
        }
    }

    pub fn reply(id: Value, outcome: Result<Value, RpcError>) -> Self {
        match outcome {
            Ok(result) => Self::ok(id, result),
            Err(error) => Self::err(id, error),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Notification {
    jsonrpc: &'static str,
    method: &'static str,
    params: Value,
}

impl Notification {
    pub fn new(method: &'static str, params: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            method,
            params,
        }
    }
}

#[derive(Debug)]
pub enum ReadError {
    Io(io::Error),
    /// The rest of an over-long line is still in the stream, so the connection
    /// cannot find the next frame and has to be closed.
    TooLarge,
    /// A complete line that is not a request. The next line is still readable.
    Bad(RpcError),
}

impl ReadError {
    pub fn rpc(&self) -> RpcError {
        match self {
            ReadError::Io(e) => RpcError::new(PARSE_ERROR, e.to_string()),
            ReadError::TooLarge => RpcError::new(PARSE_ERROR, format!("frame larger than {MAX_FRAME} bytes")),
            ReadError::Bad(e) => e.clone(),
        }
    }
}

/// The next request, or `None` at a clean end of stream. Blank lines are skipped.
pub fn read_request(reader: &mut impl BufRead) -> Result<Option<Request>, ReadError> {
    loop {
        let mut line = Vec::new();
        let n = reader
            .by_ref()
            .take(MAX_FRAME as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(ReadError::Io)?;
        if n == 0 {
            return Ok(None);
        }
        if line.len() > MAX_FRAME {
            return Err(ReadError::TooLarge);
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        return parse(text).map(Some).map_err(ReadError::Bad);
    }
}

fn parse(text: &str) -> Result<Request, RpcError> {
    let value: Value = serde_json::from_str(text).map_err(|e| RpcError::new(PARSE_ERROR, e.to_string()))?;
    if value.is_array() {
        return Err(RpcError::new(INVALID_REQUEST, "batch requests are not supported"));
    }
    let req: Request = serde_json::from_value(value).map_err(|e| RpcError::new(INVALID_REQUEST, e.to_string()))?;
    if req.jsonrpc != "2.0" {
        return Err(RpcError::new(INVALID_REQUEST, "jsonrpc must be \"2.0\""));
    }
    Ok(req)
}

/// One message as a single line, newline included.
pub fn to_line(message: &impl Serialize) -> String {
    let mut line = serde_json::to_string(message).unwrap_or_default();
    line.push('\n');
    line
}

pub fn write_line(out: &mut impl Write, line: &str) -> io::Result<()> {
    out.write_all(line.as_bytes())?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn read_all(input: &str) -> Vec<Result<Option<Request>, ReadError>> {
        let mut reader = Cursor::new(input.as_bytes().to_vec());
        let mut out = Vec::new();
        loop {
            let next = read_request(&mut reader);
            let done = matches!(next, Ok(None) | Err(ReadError::TooLarge) | Err(ReadError::Io(_)));
            out.push(next);
            if done {
                return out;
            }
        }
    }

    #[test]
    fn a_request_and_a_notification_are_read_in_order() {
        let got = read_all(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\",\"params\":{\"x\":1}}\n\n{\"jsonrpc\":\"2.0\",\"method\":\"b\"}\n",
        );
        let first = got[0].as_ref().unwrap().as_ref().unwrap();
        assert_eq!(
            (first.id.clone(), first.method.as_str(), first.params.clone()),
            (Some(json!(1)), "a", json!({"x": 1}))
        );
        let second = got[1].as_ref().unwrap().as_ref().unwrap();
        assert_eq!(
            (second.id.clone(), second.method.as_str(), second.params.clone()),
            (None, "b", Value::Null)
        );
        assert!(matches!(got[2], Ok(None)));
    }

    #[test]
    fn a_malformed_line_is_a_parse_error_and_the_next_line_still_reads() {
        let got = read_all("not json\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"a\"}\n");
        assert!(matches!(&got[0], Err(ReadError::Bad(e)) if e.code == PARSE_ERROR));
        assert_eq!(got[1].as_ref().unwrap().as_ref().unwrap().method, "a");
    }

    #[test]
    fn wrong_version_and_batches_are_invalid_requests() {
        let got = read_all("{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"a\"}\n[]\n{\"id\":1}\n");
        for bad in &got[..3] {
            assert!(
                matches!(bad, Err(ReadError::Bad(e)) if e.code == INVALID_REQUEST),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn an_oversized_line_is_refused_without_reading_it_whole() {
        let huge = format!("{{\"jsonrpc\":\"2.0\",\"method\":\"{}\"}}\n", "x".repeat(MAX_FRAME));
        let got = read_all(&huge);
        assert!(matches!(got[0], Err(ReadError::TooLarge)));
        assert_eq!(got[0].as_ref().unwrap_err().rpc().code, PARSE_ERROR);
    }

    #[test]
    fn outgoing_frames_are_one_line_each() {
        let ok = to_line(&Response::ok(json!(1), json!({"a": 1})));
        let err = to_line(&Response::err(json!(2), RpcError::new(METHOD_NOT_FOUND, "nope")));
        let note = to_line(&Notification::new("event", json!({"topic": "sessions"})));
        for line in [&ok, &err, &note] {
            assert!(line.ends_with('\n') && line.matches('\n').count() == 1, "{line}");
        }
        assert_eq!(
            serde_json::from_str::<Value>(&ok).unwrap(),
            json!({"jsonrpc": "2.0", "id": 1, "result": {"a": 1}})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&err).unwrap(),
            json!({"jsonrpc": "2.0", "id": 2, "error": {"code": -32601, "message": "nope"}})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&note).unwrap(),
            json!({"jsonrpc": "2.0", "method": "event", "params": {"topic": "sessions"}})
        );
    }
}
