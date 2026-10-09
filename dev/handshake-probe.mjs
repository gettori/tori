#!/usr/bin/env node
// Measure a language server or debug adapter the way a pack's `verified_against`
// is measured: start it with the pack's own launch args and send `initialize`.
//
//   node dev/handshake-probe.mjs lsp <program> [args...]
//   node dev/handshake-probe.mjs dap <program> [args...]
//   node dev/handshake-probe.mjs dap-tcp <program> [args...]   # `{port}` in args is filled in
//
// Prints `OK` and what the server says about itself, or why it did not answer.
// A server whose `--version` prints nothing useful (lemminx, sourcekit-lsp)
// still answers here, and a reply proves the pack's launch args work, which a
// version flag never does.
//
// Env: INIT_OPTIONS (JSON) is sent as an LSP server's `initializationOptions`,
// for the ones that refuse without them (astro needs `typescript.tsdk`).
// INIT_TIMEOUT_MS (default 30000) is for servers that compile on first start
// (ElixirLS takes minutes). ACP agents are measured by dev/acp-probe.mjs.

import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, program, ...rawArgs] = process.argv.slice(2);
if (!["lsp", "dap", "dap-tcp"].includes(mode) || !program) {
  console.error("usage: node dev/handshake-probe.mjs lsp|dap|dap-tcp <program> [args...]");
  process.exit(2);
}

const timeoutMs = +(process.env.INIT_TIMEOUT_MS ?? 30000);
const port = 48000 + Math.floor(Math.random() * 2000);
const args = rawArgs.map((a) => a.replace("{port}", String(port)));
const root = mkdtempSync(join(tmpdir(), "handshake-probe-"));

const child = spawn(program, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
const finish = (line) => {
  console.log(line);
  child.kill("SIGKILL");
  process.exit(0);
};
child.on("error", (e) => finish(`SPAWN-ERROR ${e.message}`));
child.on("exit", (code) => finish(`EXITED ${code}`));
setTimeout(() => finish("TIMEOUT"), timeoutMs);

// Both protocols frame messages with a Content-Length header.
function onFrames(stream, handle) {
  let buf = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const head = buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const len = +/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())[1];
      if (buf.length < head + 4 + len) return;
      handle(JSON.parse(buf.subarray(head + 4, head + 4 + len).toString()));
      buf = buf.subarray(head + 4 + len);
    }
  });
}

const frame = (message) => {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

if (mode === "lsp") {
  onFrames(child.stdout, (m) => {
    if (m.id !== 1) return;
    finish(m.error ? `INIT-ERROR ${JSON.stringify(m.error)}` : `OK ${JSON.stringify(m.result.serverInfo ?? null)}`);
  });
  const initializationOptions = process.env.INIT_OPTIONS ? JSON.parse(process.env.INIT_OPTIONS) : undefined;
  child.stdin.write(
    frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: `file://${root}`,
        capabilities: {},
        initializationOptions,
        workspaceFolders: [{ uri: `file://${root}`, name: "probe" }],
      },
    }),
  );
} else {
  // The fields Tori's own client sends (src/utils/dapClient.ts): lldb-dap
  // refuses `initialize` without `pathFormat`.
  const initialize = frame({
    seq: 1,
    type: "request",
    command: "initialize",
    arguments: { adapterID: "probe", clientID: "tori", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" },
  });
  const onReply = (m) => {
    if (m.type !== "response") return;
    const detail = JSON.stringify(m.success ? (m.body?.$__lldb_version ?? "") : (m.message ?? m.body ?? ""));
    finish(`${m.success ? "OK" : "INIT-ERROR"} ${detail.slice(0, 300)}`);
  };
  if (mode === "dap") {
    onFrames(child.stdout, onReply);
    child.stdin.write(initialize);
  } else {
    // Give the adapter a moment to start listening before connecting.
    setTimeout(() => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", (e) => finish(`CONNECT-ERROR ${e.message}`));
      onFrames(socket, onReply);
      socket.write(initialize);
    }, 1500);
  }
}
