#!/usr/bin/env node
// Drive `tori browser-host` the way Chrome does: started with the extension's
// origin, a native endian length then JSON each way on stdin and stdout.
//
//   node dev/browser-host-probe.mjs [--bin <tori>] [--mint] <step>...
//
// A step is `method`, `method=<params json>`, `tab=<url>` (sent with every later
// frame, as the extension does), or `wait=<ms>`, which pauses so the daemon can be
// stopped or started by hand. `--mint` first calls `browser.mint` on the bridge
// file's socket as a local caller, which is what Settings > Browser > Install does.
// Defaults to the debug binary, so it reaches Tori Dev.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const binAt = args.indexOf("--bin");
const bin = binAt >= 0 ? args.splice(binAt, 2)[1] : new URL("../src-tauri/target/debug/tori", import.meta.url).pathname;
const mint = args.includes("--mint");
const steps = args.filter((a) => a !== "--mint");
const configDir = join(homedir(), ".config", bin.includes("/debug/") ? "tori-dev" : "tori");

async function mintCredential() {
  const { sock, token } = JSON.parse(readFileSync(join(configDir, "rpc.json"), "utf8"));
  const socket = createConnection(sock);
  const lines = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  const call = (id, method, params) =>
    new Promise((resolve) => {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      const poll = setInterval(() => {
        const reply = lines.find((l) => l.id === id);
        if (reply) {
          clearInterval(poll);
          resolve(reply);
        }
      }, 10);
    });
  await call(1, "auth", { token });
  console.log("browser.mint", JSON.stringify(await call(2, "browser.mint", {})));
  socket.end();
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
}

if (mint) await mintCredential();

const host = spawn(bin, ["chrome-extension://probe/"], { stdio: ["pipe", "pipe", "inherit"] });
let pending = Buffer.alloc(0);
const waiting = new Map();
host.stdout.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
    const len = pending.readUInt32LE(0);
    const message = JSON.parse(pending.subarray(4, 4 + len));
    pending = pending.subarray(4 + len);
    waiting.get(message.id)?.(message);
  }
});
let gone = false;
const exited = new Promise((resolve) => host.on("exit", (code) => ((gone = true), resolve(code))));
host.stdin.on("error", () => {});

let tab;
let id = 0;
for (const step of steps) {
  const [name, value] = step.split(/=(.*)/s);
  if (name === "wait") {
    console.log(`waiting ${value} ms`);
    await new Promise((r) => setTimeout(r, Number(value)));
    continue;
  }
  if (name === "tab") {
    tab = { id: 1, url: value };
    continue;
  }
  if (gone) {
    console.log(name, "not sent, the host has exited");
    continue;
  }
  id += 1;
  const sent = id;
  const reply = new Promise((resolve) => waiting.set(sent, resolve));
  host.stdin.write(frame({ jsonrpc: "2.0", id: sent, method: name, params: value ? JSON.parse(value) : {}, tab }));
  const outcome = await Promise.race([reply, exited.then((code) => ({ exited: code }))]);
  console.log(name, JSON.stringify(outcome.error ?? outcome.result ?? outcome).slice(0, 300));
}
host.stdin.end();
console.log(
  "host exited",
  await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 2000))]),
);
