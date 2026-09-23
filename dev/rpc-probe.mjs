#!/usr/bin/env node
// Drive Tori's app socket end to end, the way the CLI will.
//
//   node dev/rpc-probe.mjs                 # list, tail, then wait for a chat session to start
//   node dev/rpc-probe.mjs --no-wait       # skip the wait for a `session.started` event
//   node dev/rpc-probe.mjs --timeout <ms>  # how long to wait for it (default 120000)
//
// Finds the socket the way a front must: `TORI_SOCK`/`TORI_CALLER` when run
// inside a Tori terminal, else `~/.config/tori/rpc.json`. Exits non-zero when any
// check fails, including a bad token that is not refused.
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const wait = !args.includes("--no-wait");
const timeoutAt = args.indexOf("--timeout");
const timeoutMs = timeoutAt >= 0 ? Number(args[timeoutAt + 1]) : 120_000;

function locate() {
  if (process.env.TORI_SOCK && process.env.TORI_CALLER) {
    return { sock: process.env.TORI_SOCK, token: process.env.TORI_CALLER, from: "env" };
  }
  const file = join(homedir(), ".config/tori/rpc.json");
  const { sock, token } = JSON.parse(readFileSync(file, "utf8"));
  return { sock, token, from: file };
}

// One connection: `call` resolves with the reply to its id, `events` collects
// notifications, `closed` resolves when the server hangs up.
function connect(sock) {
  const conn = createConnection(sock);
  const pending = new Map();
  const listeners = [];
  let buffer = "";
  let nextId = 1;
  const closed = new Promise((resolve) => conn.on("close", resolve));
  conn.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method === "event") {
        listeners.forEach((l) => l(msg.params));
      } else if (msg.id === null && msg.error) {
        // An error with no id belongs to the frame that was refused.
        pending.forEach((resolve) => resolve(msg));
        pending.clear();
      }
    }
  });
  conn.on("error", () => {});
  return {
    call(method, params = {}) {
      const id = nextId++;
      conn.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((resolve) => pending.set(id, resolve));
    },
    onEvent: (l) => listeners.push(l),
    closed,
    end: () => conn.end(),
  };
}

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const { sock, token, from } = locate();
console.log(`socket ${sock} (from ${from})`);

const c = connect(sock);
const auth = await c.call("auth", { token });
check(auth.result !== undefined, "auth with the right token", JSON.stringify(auth.error ?? auth.result));

const list = await c.call("sessions.list", { limit: 5 });
const rows = list.result ?? [];
check(Array.isArray(list.result), "sessions.list", `${rows.length} row(s)`);
for (const r of rows) console.log(`     ${r.live ? "live" : "    "} ${r.agent} ${r.id} ${r.title || r.cwd}`);

if (rows[0]) {
  const tail = await c.call("session.tail", { id: rows[0].id, agent: rows[0].agent, limit: 3 });
  check(Array.isArray(tail.result), "session.tail", (tail.result ?? []).map((e) => e.type).join(", ") || "empty");
}

const sub = await c.call("subscribe", { topic: "sessions" });
check(sub.result !== undefined, "subscribe sessions");

const bad = connect(sock);
const refused = await bad.call("auth", { token: "not-the-token" });
check(refused.error?.code === -32001, "a wrong token is refused", JSON.stringify(refused.error));
const hungUp = await Promise.race([bad.closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
check(hungUp, "and its connection is closed");

if (wait) {
  console.log(`waiting up to ${timeoutMs} ms: start a chat session in Tori`);
  const started = await Promise.race([
    new Promise((resolve) => c.onEvent((p) => p.topic === "sessions" && p.data.kind === "session.started" && resolve(p.data))),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  check(started !== null, "a started event arrives", JSON.stringify(started));
}

c.end();
process.exit(failures.length ? 1 : 0);
