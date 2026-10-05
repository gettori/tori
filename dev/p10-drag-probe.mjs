// Phase 10 task 1 verify: drive the TabDragCycle story with a real drag over
// CDP and print what came out. Same harness as dev/p8-move-probe.mjs, plus the
// drag itself: the mouse presses the tab and moves, Chrome intercepts the drag
// it starts (`Input.setInterceptDrags`), and the payload it hands back is what
// the drag events are dispatched with. Nothing here synthesizes a DOM event, so
// what runs in the page is the browser's own drag plumbing.
//
// Usage: node dev/p10-drag-probe.mjs [strip|edge]
import { spawn } from "node:child_process";
import { mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SB_PORT = 6007;
const SB_URL = `http://127.0.0.1:${SB_PORT}`;
const STORY = "dev-keepalivespike--tab-drag-cycle";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WHERE = process.argv[2] === "edge" ? "edge" : "strip";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sbUp() {
  try {
    const res = await fetch(`${SB_URL}/index.json`);
    if (res.ok) return null;
  } catch {}
  const log = openSync(join(tmpdir(), "p10-storybook.log"), "w");
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
const profile = mkdtempSync(join(tmpdir(), "p10-chrome-"));
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
const waiters = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method && waiters.has(msg.method)) {
    waiters.get(msg.method)(msg.params);
    waiters.delete(msg.method);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const nextEvent = (method, ms = 5000) =>
  new Promise((resolve) => {
    waiters.set(method, resolve);
    setTimeout(() => {
      waiters.delete(method);
      resolve(null);
    }, ms);
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};

await send("Page.enable");
let hook = false;
for (let i = 0; i < 60 && !hook; i++) {
  hook = (await evaluate("!!window.__spikePrep")) === true;
  if (!hook) await sleep(1000);
}
if (!hook) {
  console.error("story never exposed __spikePrep");
  chrome.kill();
  process.exit(1);
}

const at = await evaluate("window.__spikePrep().then((r) => JSON.stringify(r))").then(JSON.parse);
const drop = WHERE === "edge" ? at.edge : at.strip;

// A trace of what the page actually received, so a drop that never arrives
// (the usual failure: an operations mask the page's dropEffect is not in) says
// so rather than looking like a guard that refused.
await evaluate(
  "window.__log=[];addEventListener('drop',()=>window.__log.push('drop'),true);addEventListener('dragover',()=>window.__log.push('over'),true);addEventListener('dragleave',()=>window.__log.push('leave'),true);addEventListener('tori:move-tab-to-pane',(e)=>window.__log.push('move '+JSON.stringify(e.detail)));addEventListener('tori:split-pane',(e)=>window.__log.push('split '+JSON.stringify(e.detail)));true",
);
await send("Input.setInterceptDrags", { enabled: true });
const intercepted = nextEvent("Input.dragIntercepted");
const mouse = (type, x, y, extra = {}) =>
  send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: 1, clickCount: 1, ...extra });
await mouse("mousePressed", at.tab.x, at.tab.y);
// Past the drag threshold, in steps: one jump is not a drag gesture.
for (const dx of [4, 12, 30, 60]) await mouse("mouseMoved", at.tab.x + dx, at.tab.y + 2);
const drag = await intercepted;
if (!drag) {
  console.error("chrome never started a drag from the press (Input.dragIntercepted did not fire)");
  chrome.kill();
  if (sb) process.kill(-sb.pid, "SIGTERM");
  process.exit(1);
}
const data = drag.data;
const dragEvent = (type, x, y) =>
  // 17 = copy|move in Blink's mask (move is bit 16, not 4): a mask without it
  // makes Chrome reject the drop of a page that asked for `dropEffect = move`.
  send("Input.dispatchDragEvent", { type, x, y, data: { ...data, dragOperationsMask: 17 } });
await dragEvent("dragEnter", drop.x, drop.y);
await dragEvent("dragOver", drop.x, drop.y);
const zoneShown = await evaluate("document.querySelectorAll('[data-drop-zone]').length");
await dragEvent("drop", drop.x, drop.y);
await mouse("mouseReleased", drop.x, drop.y);
await send("Input.setInterceptDrags", { enabled: false });

const run = await evaluate("window.__spikeRun().then((r) => JSON.stringify(r))");
console.log("where:", WHERE);
console.log("prep:", JSON.stringify(at));
console.log("dragTypes:", JSON.stringify((data.items ?? []).map((i) => i.mimeType)));
console.log("zoneShownDuringDrag:", zoneShown);
console.log("pageEvents:", await evaluate("JSON.stringify(window.__log)"));
console.log("result:", run);
chrome.kill();
if (sb) process.kill(-sb.pid, "SIGTERM");
process.exit(0);
