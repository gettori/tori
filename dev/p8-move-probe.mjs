// Phase 8 tasks 1 and 4 verify: drive the PaneMoveCycle story over CDP and print
// its measurements (a live xterm moved between real panes, then merged back).
// Same harness as dev/p7-rehost-probe.mjs. Usage: node dev/p8-move-probe.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SB_PORT = 6007;
const SB_URL = `http://127.0.0.1:${SB_PORT}`;
const STORY = "dev-keepalivespike--pane-move-cycle";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sbUp() {
  try {
    const res = await fetch(`${SB_URL}/index.json`);
    if (res.ok) return null;
  } catch {}
  const log = openSync(join(tmpdir(), "p8-storybook.log"), "w");
  const child = spawn(
    join(ROOT, "node_modules", ".bin", "storybook"),
    ["dev", "-p", String(SB_PORT), "--no-open", "--quiet"],
    {
      cwd: ROOT,
      stdio: ["ignore", log, log],
      detached: true,
    },
  );
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SB_URL}/index.json`);
      if (res.ok) return child;
    } catch {}
    await sleep(1000);
  }
  throw new Error("storybook did not come up");
}

const sb = await sbUp();
const profile = mkdtempSync(join(tmpdir(), "p8-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--window-size=1200,800",
  "about:blank",
]);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error("no devtools line")), 15000);
});
const port = new URL(wsUrl).port;
const pageUrl = `${SB_URL}/iframe.html?id=${STORY}&viewMode=story`;
const target = await new Promise((resolve, reject) => {
  const req = http.request(
    { host: "127.0.0.1", port, path: `/json/new?${encodeURIComponent(pageUrl)}`, method: "PUT" },
    (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(JSON.parse(b)));
    },
  );
  req.on("error", reject);
  req.end();
});
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
// Wait for the story to expose the hook, then run it.
let hook = false;
for (let i = 0; i < 60 && !hook; i++) {
  const r = await send("Runtime.evaluate", { expression: "!!window.__spikeRun", returnByValue: true });
  hook = r.result?.result?.value === true;
  if (!hook) await sleep(1000);
}
if (!hook) {
  console.error("story never exposed __spikeRun");
  chrome.kill();
  process.exit(1);
}
const run = await send("Runtime.evaluate", {
  expression: "window.__spikeRun().then((r) => JSON.stringify(r))",
  awaitPromise: true,
  returnByValue: true,
});
console.log("result:", run.result?.result?.value ?? JSON.stringify(run));
chrome.kill();
if (sb) process.kill(-sb.pid, "SIGTERM");
process.exit(0);
