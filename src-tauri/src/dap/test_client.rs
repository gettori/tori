// A DAP client for Rust tests. It starts a real adapter through
// `start_adapter`, drives it with the handshake `dapSessions.ts` uses, and
// returns the first breakpoint stop. The frontend's tests fake the adapter, so
// this is what proves a launch config binds a breakpoint in the real one.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::registry::{self, DapAdapter, Launch};
use super::{connect_retry, locate, next_id, pump_frames, start_adapter, stop, write_frame, Server, CONNECT_TIMEOUT};

/// Room for a cold adapter and a source map, short enough that a breakpoint
/// that never binds fails the run rather than hanging it.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);

/// Where `bundled_entry` finds the bundled script in a dev tree.
pub(super) fn dev_bundled(rel: &str) -> Option<PathBuf> {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/dap/")).join(rel);
    path.exists().then_some(path)
}

/// Start `adapter` at `root`, launch `config` with a breakpoint at
/// `file:line`, and return the body of the `stopped` event it hits. The adapter
/// and its debuggee are stopped either way.
pub(super) fn run_to_breakpoint(
    adapter: &DapAdapter,
    root: &Path,
    file: &Path,
    line: u32,
    config: Value,
) -> Result<Value, String> {
    let started = start_adapter(adapter, &root.to_string_lossy(), &locate(adapter, dev_bundled)?)?;
    let (tx, rx) = mpsc::channel();
    let mut client = Client {
        adapter,
        socket: started.socket.clone(),
        file,
        line,
        tx,
        rx,
        conns: Vec::new(),
        output: String::new(),
    };
    let result = client
        .open(started.reader, started.writer, config)
        .and_then(|()| client.run());
    stop(&mut Server {
        child: started.child,
        socket: started.socket,
        child_sessions: adapter.child_sessions,
        sessions: HashMap::new(),
    });
    result
}

struct Conn {
    writer: Box<dyn Write + Send>,
    seq: u64,
    /// Sent as `launch` or `attach` once `initialize` is answered.
    config: Value,
    configured: bool,
    breakpoints_seq: Option<u64>,
}

struct Client<'a> {
    adapter: &'a DapAdapter,
    socket: Option<PathBuf>,
    file: &'a Path,
    line: u32,
    tx: mpsc::Sender<(usize, Value)>,
    rx: mpsc::Receiver<(usize, Value)>,
    conns: Vec<Conn>,
    /// The adapter's `output` events, to explain a failure.
    output: String,
}

impl Client<'_> {
    /// Add a session over `reader` and `writer` and send its `initialize`.
    fn open(
        &mut self,
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        config: Value,
    ) -> Result<(), String> {
        let id = self.conns.len();
        let tx = self.tx.clone();
        pump_frames(reader, move |body| {
            if let Ok(msg) = serde_json::from_str(&body) {
                let _ = tx.send((id, msg));
            }
        });
        self.conns.push(Conn {
            writer,
            seq: 0,
            config,
            configured: false,
            breakpoints_seq: None,
        });
        // `initializeArguments` in dapClient.ts.
        let args = json!({
            "clientID": "tori",
            "clientName": "Tori",
            "adapterID": self.adapter.id,
            "locale": "en",
            "linesStartAt1": true,
            "columnsStartAt1": true,
            "pathFormat": "path",
            "supportsVariableType": true,
            "supportsVariablePaging": true,
            "supportsRunInTerminalRequest": false,
            "supportsStartDebuggingRequest": self.adapter.child_sessions,
        });
        self.request(id, "initialize", args).map(drop)
    }

    fn send(&mut self, id: usize, mut msg: Value) -> Result<u64, String> {
        let conn = &mut self.conns[id];
        conn.seq += 1;
        msg["seq"] = conn.seq.into();
        write_frame(&mut conn.writer, &msg.to_string())?;
        Ok(conn.seq)
    }

    fn request(&mut self, id: usize, command: &str, arguments: Value) -> Result<u64, String> {
        self.send(
            id,
            json!({ "type": "request", "command": command, "arguments": arguments }),
        )
    }

    fn fail(&self, what: String) -> String {
        format!("{what}. Adapter output:\n{}", self.output)
    }

    fn run(&mut self) -> Result<Value, String> {
        let deadline = Instant::now() + STOP_TIMEOUT;
        loop {
            let (id, msg) = self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| self.fail(format!("no breakpoint stop within {}s", STOP_TIMEOUT.as_secs())))?;
            match msg["type"].as_str() {
                Some("response") => self.on_response(id, &msg)?,
                Some("request") => self.on_request(id, &msg)?,
                Some("event") => {
                    if let Some(stop) = self.on_event(id, &msg)? {
                        return Ok(stop);
                    }
                }
                _ => {}
            }
        }
    }

    fn on_response(&mut self, id: usize, res: &Value) -> Result<(), String> {
        let command = res["command"].as_str().unwrap_or_default();
        if res["success"] != true {
            return Err(self.fail(format!("`{command}` failed: {}", res["message"])));
        }
        let conn = &self.conns[id];
        if command == "initialize" {
            // Not awaited, as in `handshake`: js-debug answers `launch` only
            // after `configurationDone`, which waits on `initialized`.
            let config = conn.config.clone();
            let verb = if config["request"] == "attach" {
                "attach"
            } else {
                "launch"
            };
            self.request(id, verb, config)?;
        } else if command == "setBreakpoints" && res["request_seq"].as_u64() == conn.breakpoints_seq {
            self.request(id, "configurationDone", json!({}))?;
        }
        Ok(())
    }

    fn on_request(&mut self, id: usize, req: &Value) -> Result<(), String> {
        let command = req["command"].as_str().unwrap_or_default();
        let child = command == "startDebugging" && self.adapter.child_sessions;
        self.send(
            id,
            json!({ "type": "response", "request_seq": req["seq"], "command": command, "success": child }),
        )?;
        if !child {
            return Ok(());
        }
        // Relayed verbatim, as `connectChild` does: js-debug's
        // `__pendingTargetId` in it is what pairs this connection with a target.
        let args = &req["arguments"];
        let mut config = args["configuration"].clone();
        if config.get("request").is_none() {
            config["request"] = args.get("request").cloned().unwrap_or_else(|| "launch".into());
        }
        let socket = self
            .socket
            .clone()
            .ok_or("startDebugging from an adapter with no socket")?;
        let stream = connect_retry(&socket, CONNECT_TIMEOUT)?;
        let reader = stream.try_clone().map_err(|e| e.to_string())?;
        self.open(Box::new(reader), Box::new(stream), config)
    }

    fn on_event(&mut self, id: usize, event: &Value) -> Result<Option<Value>, String> {
        let body = &event["body"];
        match event["event"].as_str().unwrap_or_default() {
            // Once per session: js-debug repeats `initialized`, and a second
            // `setBreakpoints` wipes the first (`configureOnce`).
            "initialized" if !self.conns[id].configured => {
                self.conns[id].configured = true;
                let args = json!({ "source": { "path": self.file }, "breakpoints": [{ "line": self.line }] });
                self.conns[id].breakpoints_seq = Some(self.request(id, "setBreakpoints", args)?);
            }
            "stopped" if body["reason"] == "breakpoint" => return Ok(Some(body.clone())),
            // Tori's own entry pause, continued straight through as
            // `wireSession` does.
            "stopped" if body["reason"] == "entry" => {
                self.request(id, "continue", json!({ "threadId": body["threadId"] }))?;
            }
            "output" => self.output.push_str(body["output"].as_str().unwrap_or_default()),
            "terminated" if id == 0 => {
                return Err(self.fail(format!("the program ended without stopping at line {}", self.line)))
            }
            _ => {}
        }
        Ok(None)
    }
}

#[test]
fn it_hits_a_breakpoint_in_a_js_file_under_the_real_js_debug() {
    let js = registry::find("js-debug").expect("js-debug is registered");
    let Launch::BundledNodeSocket { entry, .. } = &js.launch else {
        panic!("js-debug should be bundled_node_socket, got {:?}", js.launch);
    };
    if dev_bundled(entry).is_none() || crate::env::resolve_binary("node").is_none() {
        eprintln!("skipping: js-debug is not installed (run `pnpm dap:install`) or node is not on PATH");
        return;
    }

    let dir = std::env::temp_dir().join(format!("tori-dap-client-{}-{}", std::process::id(), next_id("t")));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("sample.js");
    std::fs::write(
        &file,
        "let total = 0;\nfor (let i = 0; i < 3; i++) {\n  total += i;\n}\nconsole.log(total);\n",
    )
    .unwrap();

    // `fileConfig` in debugTargets.ts.
    let config = json!({
        "type": "pwa-node",
        "request": "launch",
        "name": "Debug sample.js",
        "program": file,
        "cwd": dir,
        "console": "internalConsole",
        "stopOnEntry": true,
    });
    let stopped = run_to_breakpoint(js, &dir, &file, 3, config);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(stopped.expect("the breakpoint is hit")["reason"], "breakpoint");
}

#[test]
#[ignore = "installs debugpy from PyPI"]
fn it_hits_a_breakpoint_in_a_python_file_whose_venv_has_no_debugpy() {
    let debugpy = registry::find("debugpy").expect("debugpy is registered");
    let dir = std::env::temp_dir().join(format!("tori-dap-client-{}-{}", std::process::id(), next_id("t")));
    let installed = super::managed::install(debugpy, &dir.join("debuggers")).expect("debugpy installs");

    // Another Python than the adapter's when the machine has one: a Homebrew
    // venv for Tori and a project on some other version is the common case.
    let project_base = Some(PathBuf::from("/usr/local/bin/python3"))
        .filter(|p| p.exists())
        .or_else(|| crate::env::resolve_binary("python3"))
        .expect("python3 is on PATH");
    let project = dir.join("project");
    let status = std::process::Command::new(project_base)
        .args(["-m", "venv"])
        .arg(project.join(".venv"))
        .status();
    assert!(status.is_ok_and(|s| s.success()), "the project venv is created");
    let python = project.join(".venv/bin/python3");
    let module = debugpy.launch.module().unwrap();
    assert_eq!(
        super::managed::package_version(&python, "debugpy", module),
        None,
        "the project venv has no debugpy"
    );

    let file = project.join("sample.py");
    std::fs::write(&file, "total = 0\nfor i in range(3):\n    total += i\nprint(total)\n").unwrap();

    // Pointed at the temp install: `resolve = "managed"` looks in the real home.
    let Launch::Stdio { args, .. } = &debugpy.launch else {
        panic!("{:?}", debugpy.launch)
    };
    let mut adapter = debugpy.clone();
    adapter.launch = Launch::Stdio {
        program: dir
            .join("debuggers/debugpy")
            .join(&installed.bin)
            .to_string_lossy()
            .into_owned(),
        args: args.clone(),
        resolve: registry::Resolve::Path,
    };

    // `pythonConfigFor` in debugTargets.ts.
    let config = json!({
        "type": "debugpy",
        "request": "launch",
        "name": "Debug sample.py",
        "program": file,
        "python": python,
        "cwd": project,
        "console": "internalConsole",
        "justMyCode": true,
    });
    let stopped = run_to_breakpoint(&adapter, &project, &file, 3, config);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(stopped.expect("the breakpoint is hit")["reason"], "breakpoint");
}

#[test]
fn it_hits_a_breakpoint_in_a_go_package_and_in_its_test() {
    let delve = registry::find("delve").expect("delve is registered");
    if crate::env::resolve_binary("dlv").is_none() || crate::env::resolve_binary("go").is_none() {
        eprintln!("skipping: `dlv` or `go` is not on your login PATH");
        return;
    }

    let dir = std::env::temp_dir().join(format!("tori-dap-client-{}-{}", std::process::id(), next_id("t")));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("go.mod"), "module sample\n\ngo 1.21\n").unwrap();
    let main = dir.join("main.go");
    std::fs::write(
        &main,
        "package main\n\nimport \"fmt\"\n\nfunc sum(n int) int {\n\ttotal := 0\n\tfor i := 0; i < n; i++ {\n\t\ttotal += i\n\t}\n\treturn total\n}\n\nfunc main() {\n\tfmt.Println(sum(3))\n}\n",
    )
    .unwrap();
    let test = dir.join("main_test.go");
    std::fs::write(
        &test,
        "package main\n\nimport \"testing\"\n\nfunc TestSum(t *testing.T) {\n\tgot := sum(3)\n\tif got != 3 {\n\t\tt.Fatal(got)\n\t}\n}\n",
    )
    .unwrap();

    // `goConfigFor` in debugTargets.ts.
    let launch = |mode: &str, name: &str| {
        json!({
            "type": "go",
            "request": "launch",
            "name": name,
            "mode": mode,
            "program": dir,
            "cwd": dir,
            "outputMode": "remote",
        })
    };
    let package = run_to_breakpoint(delve, &dir, &main, 8, launch("debug", "Debug sample"));
    let tests = run_to_breakpoint(delve, &dir, &test, 7, launch("test", "Debug tests in sample"));
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(
        package.expect("the package's breakpoint is hit")["reason"],
        "breakpoint"
    );
    assert_eq!(tests.expect("the test's breakpoint is hit")["reason"], "breakpoint");
}

#[test]
fn it_hits_a_breakpoint_in_a_c_binary_built_with_cc() {
    let lldb = registry::find("lldb").expect("lldb is registered");
    if locate(lldb, dev_bundled).is_err() || crate::env::resolve_binary("cc").is_none() {
        eprintln!("skipping: lldb-dap or `cc` is not installed");
        return;
    }

    let dir = std::env::temp_dir().join(format!("tori-dap-client-{}-{}", std::process::id(), next_id("t")));
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("sample.c");
    std::fs::write(
        &source,
        "#include <stdio.h>\n\nint main(void) {\n  int total = 0;\n  for (int i = 0; i < 3; i++) {\n    total += i;\n  }\n  printf(\"%d\\n\", total);\n  return 0;\n}\n",
    )
    .unwrap();
    let binary = dir.join("sample");
    let built = std::process::Command::new("cc")
        .args(["-g", "-O0", "-o"])
        .arg(&binary)
        .arg(&source)
        .status();
    assert!(built.is_ok_and(|s| s.success()), "the sample builds");

    let config = json!({
        "type": "lldb-dap",
        "request": "launch",
        "name": "Debug sample",
        "program": binary,
        "cwd": dir,
    });
    let stopped = run_to_breakpoint(lldb, &dir, &source, 6, config);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(stopped.expect("the breakpoint is hit")["reason"], "breakpoint");
}

#[test]
fn it_hits_a_breakpoint_in_a_cargo_binary_it_built() {
    let lldb = registry::find("lldb").expect("lldb is registered");
    if locate(lldb, dev_bundled).is_err() || crate::env::resolve_binary("cargo").is_none() {
        eprintln!("skipping: lldb-dap or cargo is not installed");
        return;
    }

    let dir = std::env::temp_dir().join(format!("tori-dap-client-{}-{}", std::process::id(), next_id("t")));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    // rustc records the physical path, and the temp dir sits under a symlink.
    let dir = std::fs::canonicalize(&dir).unwrap();
    std::fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    let main = dir.join("src/main.rs");
    std::fs::write(&main, "fn main() {\n    let mut total = 0;\n    for i in 0..3 {\n        total += i;\n    }\n    println!(\"{total}\");\n}\n").unwrap();
    assert_eq!(super::cargo::bins(&dir).expect("cargo metadata runs"), ["sample"]);
    let built = super::cargo::build(&dir, "sample", &next_id("b"), |_| {}).expect("the sample builds");
    let sysroot = built.sysroot.expect("rustc names its sysroot");

    // `lldbConfigFor` in debugTargets.ts.
    let config = json!({
        "type": "lldb-dap",
        "request": "launch",
        "name": "Debug sample",
        "program": built.executable,
        "cwd": dir,
        "initCommands": [
            format!("command script import \"{sysroot}/lib/rustlib/etc/lldb_lookup.py\""),
            format!("command source -s 1 \"{sysroot}/lib/rustlib/etc/lldb_commands\""),
        ],
    });
    let stopped = run_to_breakpoint(lldb, &dir, &main, 4, config);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(stopped.expect("the breakpoint is hit")["reason"], "breakpoint");
}
