//! `tori mcp`: an MCP stdio server whose tools are the socket's method table.
//! It holds no logic of its own; every tool call is one socket call. See
//! [[adr_one_protocol_several_fronts]].

use std::io::{self, BufRead, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Map, Value};

use crate::rpc::client::{self, Client, ClientError};
use crate::rpc::frame::{to_line, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};
use crate::rpc::table::{self, Method};

// Under codex-acp's 300s kill of a tool call, see [[concept_blocking_tool_call_ceiling]].
const BLOCKING_CALL_TIMEOUT_SECS: u64 = 240;
const PATH_ARGS: [&str; 4] = ["folder", "project", "path", "worktree"];

pub type Connect = Arc<dyn Fn() -> Result<Client, ClientError> + Send + Sync>;
type Out = Arc<Mutex<dyn Write + Send>>;

pub fn run() -> io::Result<()> {
    let connect: Connect = Arc::new(|| {
        let endpoint = client::locate().ok_or_else(|| {
            let message = "Tori is not running: no TORI_SOCK in the environment and no ~/.config/tori/rpc.json";
            ClientError::Io(io::Error::new(io::ErrorKind::NotFound, message))
        })?;
        Client::connect(&endpoint)
    });
    // Calls still running when the client hangs up have nobody to answer.
    serve(io::stdin().lock(), Arc::new(Mutex::new(io::stdout())), connect).map(drop)
}

pub fn serve(input: impl BufRead, out: Out, connect: Connect) -> io::Result<Vec<thread::JoinHandle<()>>> {
    let mut calls = Vec::new();
    for line in input.lines() {
        let Ok(message) = serde_json::from_str::<Value>(&line?) else {
            continue;
        };
        let Some(id) = message.get("id").filter(|id| !id.is_null()).cloned() else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match message["method"].as_str().unwrap_or("") {
            "initialize" => {
                let version = params["protocolVersion"].as_str().unwrap_or("2025-06-18");
                let result = json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "tori", "version": env!("CARGO_PKG_VERSION") },
                });
                reply(&out, id, Ok(result));
            }
            "ping" => reply(&out, id, Ok(json!({}))),
            "tools/list" => reply(&out, id, tools_list(&connect)),
            // Each on its own thread and its own connection: the socket answers one
            // request at a time per connection, and a blocking ask must not hold up
            // a call made beside it.
            "tools/call" => {
                let (out, connect) = (out.clone(), connect.clone());
                calls.push(thread::spawn(move || reply(&out, id, tools_call(&connect, &params))));
            }
            other => reply(&out, id, Err((METHOD_NOT_FOUND, format!("no method {other}")))),
        }
    }
    Ok(calls)
}

fn reply(out: &Out, id: Value, outcome: Result<Value, (i64, String)>) {
    let message = match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    };
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    let _ = out.write_all(to_line(&message).as_bytes()).and_then(|()| out.flush());
}

fn tool_name(method: &Method) -> String {
    method.name.replace('.', "_")
}

fn internal(e: ClientError) -> (i64, String) {
    (INTERNAL_ERROR, e.to_string())
}

// Read per request rather than once at startup, since a session's kind can
// change after its MCP server has started.
fn tools_list(connect: &Connect) -> Result<Value, (i64, String)> {
    let me = connect()
        .and_then(|mut c| c.call("caller", Value::Null))
        .map_err(internal)?;
    let kind = me["kind"].as_str().unwrap_or("local");
    let tools: Vec<Value> = table::METHODS
        .iter()
        .filter(|m| m.callers.iter().any(|k| k.name() == kind) && table::offered(m))
        .map(|m| {
            let mut schema = (m.params)().to_value();
            if let Some(schema) = schema.as_object_mut() {
                schema.remove("$schema");
            }
            json!({ "name": tool_name(m), "description": m.description, "inputSchema": schema })
        })
        .collect();
    Ok(json!({ "tools": tools }))
}

fn tools_call(connect: &Connect, params: &Value) -> Result<Value, (i64, String)> {
    let name = params["name"].as_str().unwrap_or("");
    let method = table::METHODS
        .iter()
        .find(|m| tool_name(m) == name)
        .ok_or_else(|| (INVALID_PARAMS, format!("no tool {name}")))?;
    let mut args = params["arguments"].as_object().cloned().unwrap_or_default();
    if matches!(
        method.name,
        "ask.create" | "ask.wait" | "session.wait" | "topic.member.promote"
    ) && !args.contains_key("timeout")
    {
        args.insert("timeout".into(), json!(BLOCKING_CALL_TIMEOUT_SECS));
    }
    let mut socket = connect().map_err(internal)?;
    if has_relative_path(&args) {
        let me = socket.call("caller", Value::Null).map_err(internal)?;
        let cwd = match me["identity"]["cwd"].as_str() {
            Some(cwd) => cwd.into(),
            None => std::env::current_dir().map_err(|e| (INTERNAL_ERROR, e.to_string()))?,
        };
        absolutize(&mut args, &cwd);
    }
    let text = |body: String| json!({ "type": "text", "text": body });
    Ok(match socket.call(method.name, Value::Object(args)) {
        Ok(result) => json!({ "content": [text(result.to_string())] }),
        Err(ClientError::Rpc(e)) => json!({ "content": [text(e.message)], "isError": true }),
        Err(e) => json!({ "content": [text(e.to_string())], "isError": true }),
    })
}

fn relative(value: &Value) -> bool {
    value.as_str().is_some_and(|p| Path::new(p).is_relative())
}

fn has_relative_path(args: &Map<String, Value>) -> bool {
    PATH_ARGS.iter().any(|key| args.get(*key).is_some_and(relative))
        || args
            .get("attach")
            .and_then(Value::as_array)
            .is_some_and(|all| all.iter().any(relative))
}

// The same rule the CLI applies, against the caller's folder rather than this
// process's, which an ACP agent may have started anywhere.
fn absolutize(args: &mut Map<String, Value>, cwd: &Path) {
    let join = |value: &mut Value| {
        if let Some(path) = value.as_str().filter(|p| Path::new(p).is_relative()) {
            *value = json!(cwd.join(path).to_string_lossy());
        }
    };
    for key in PATH_ARGS {
        if let Some(value) = args.get_mut(key) {
            join(value);
        }
    }
    if let Some(all) = args.get_mut("attach").and_then(Value::as_array_mut) {
        all.iter_mut().for_each(join);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::ipc::UnixListener;
    use crate::rpc::client::{Endpoint, Found};
    use std::io::{BufReader, Cursor};
    use std::time::Duration;

    struct Fake {
        sock: std::path::PathBuf,
        seen: Arc<Mutex<Vec<(String, Value)>>>,
        connections: Arc<Mutex<usize>>,
    }

    impl Fake {
        fn start(kind: &'static str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tori-mcp-{}-{kind}-{:?}",
                std::process::id(),
                thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let sock = dir.join("s");
            let listener = UnixListener::bind(&sock).unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let connections = Arc::new(Mutex::new(0));
            let (seen2, connections2) = (seen.clone(), connections.clone());
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    *connections2.lock().unwrap() += 1;
                    let seen = seen2.clone();
                    thread::spawn(move || {
                        let mut out = stream.try_clone().unwrap();
                        for line in BufReader::new(stream).lines().map_while(Result::ok) {
                            let req: Value = serde_json::from_str(&line).unwrap();
                            let method = req["method"].as_str().unwrap().to_string();
                            let reply = match method.as_str() {
                                "auth" => json!({ "result": {} }),
                                "caller" => {
                                    let caller = if kind == "worker" { "chat" } else { kind };
                                    json!({ "result": { "caller": { "kind": caller, "id": "x" }, "kind": kind, "identity": { "cwd": "/w" } } })
                                }
                                "ask.create" => {
                                    thread::sleep(Duration::from_millis(400));
                                    json!({ "result": { "id": "a1", "answer": null } })
                                }
                                "window.open" => json!({ "error": { "code": -32002, "message": "no window" } }),
                                _ => json!({ "result": { "method": method } }),
                            };
                            seen.lock().unwrap().push((method, req["params"].clone()));
                            let mut reply = reply;
                            reply["jsonrpc"] = json!("2.0");
                            reply["id"] = req["id"].clone();
                            if out.write_all(format!("{reply}\n").as_bytes()).is_err() {
                                break;
                            }
                        }
                    });
                }
            });
            Fake {
                sock,
                seen,
                connections,
            }
        }

        fn connect(&self) -> Connect {
            let sock = self.sock.to_string_lossy().into_owned();
            Arc::new(move || {
                Client::connect(&Endpoint {
                    sock: sock.clone(),
                    token: "t".into(),
                    found: Found::Env,
                })
            })
        }

        fn params_of(&self, method: &str) -> Vec<Value> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _)| m == method)
                .map(|(_, p)| p.clone())
                .collect()
        }
    }

    fn run(fake: &Fake, lines: &[Value]) -> Vec<Value> {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        for call in serve(Cursor::new(input), out.clone(), fake.connect()).unwrap() {
            call.join().unwrap();
        }
        let bytes = out.lock().unwrap().clone();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn call(id: u64, tool: &str, arguments: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": arguments } })
    }

    #[test]
    fn a_blocking_call_does_not_hold_up_the_one_after_it() {
        let fake = Fake::start("chat");
        let replies = run(
            &fake,
            &[
                call(1, "ask_create", json!({ "question": "q" })),
                call(2, "sessions_list", json!({})),
            ],
        );
        let order: Vec<u64> = replies.iter().map(|r| r["id"].as_u64().unwrap()).collect();
        assert_eq!(order, [2, 1]);
    }

    #[test]
    fn the_handshake_echoes_the_version_and_notifications_get_no_reply() {
        let fake = Fake::start("chat");
        let replies = run(
            &fake,
            &[
                json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }),
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 9 } }),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }),
            ],
        );
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["result"]["protocolVersion"], json!("2025-03-26"));
        assert_eq!(replies[0]["result"]["capabilities"], json!({ "tools": {} }));
        assert_eq!(replies[1]["result"], json!({}));
    }

    fn listed(kind: &'static str) -> Vec<String> {
        let fake = Fake::start(kind);
        let replies = run(&fake, &[json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })]);
        let tools = replies[0]["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == json!("object")));
        tools.iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn the_list_is_the_table_trimmed_to_the_callers_kind() {
        let chat = listed("chat");
        for tool in ["sessions_list", "session_spawn", "ask_create", "ask_wait"] {
            assert!(chat.iter().any(|t| t == tool), "{tool} missing from {chat:?}");
        }
        let terminal = listed("terminal");
        assert!(
            !terminal.iter().any(|t| t == "ask_create"),
            "a terminal was offered ask_create"
        );
        let worker = listed("worker");
        assert!(worker.iter().any(|t| t == "ask_create"), "{worker:?}");
        assert!(
            !worker.iter().any(|t| t == "session_spawn"),
            "a worker was offered session_spawn"
        );
    }

    #[test]
    fn each_call_is_its_own_connection_with_the_arguments_as_params() {
        let fake = Fake::start("chat");
        let replies = run(
            &fake,
            &[
                call(1, "sessions_list", json!({ "limit": 3 })),
                call(2, "ask_wait", json!({ "id": "a1" })),
                call(3, "window_open", json!({ "path": "/f" })),
                call(4, "session_wait", json!({ "id": "w1" })),
            ],
        );
        assert_eq!(*fake.connections.lock().unwrap(), 4);
        assert_eq!(fake.params_of("sessions.list"), [json!({ "limit": 3 })]);
        assert_eq!(
            fake.params_of("ask.wait"),
            [json!({ "id": "a1", "timeout": BLOCKING_CALL_TIMEOUT_SECS })]
        );
        assert_eq!(
            fake.params_of("session.wait"),
            [json!({ "id": "w1", "timeout": BLOCKING_CALL_TIMEOUT_SECS })]
        );
        let refused = replies.iter().find(|r| r["id"] == json!(3)).unwrap();
        assert_eq!(refused["result"]["isError"], json!(true));
        assert_eq!(refused["result"]["content"][0]["text"], json!("no window"));
        let listed = replies.iter().find(|r| r["id"] == json!(1)).unwrap();
        assert!(listed["result"].get("isError").is_none());
    }

    #[test]
    fn relative_paths_resolve_against_the_callers_folder() {
        let fake = Fake::start("chat");
        run(
            &fake,
            &[call(
                1,
                "session_spawn",
                json!({ "attach": ["notes/a.md", "/abs/b.md"], "folder": "wt" }),
            )],
        );
        assert_eq!(
            fake.params_of("session.spawn"),
            [json!({ "attach": ["/w/notes/a.md", "/abs/b.md"], "folder": "/w/wt" })]
        );
    }
}
