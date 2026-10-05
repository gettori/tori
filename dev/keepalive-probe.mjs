// Phase 1 keep-alive spike driver. Boots Storybook (or reuses a running one on
// 6007), drives the Dev/KeepAliveSpike stories in headless Chrome over CDP, and
// judges the raw measurements against the criteria recorded in the plan.
// Usage: node dev/keepalive-probe.mjs [--out <dir>]

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SB_PORT = 6007;
const SB_URL = `http://127.0.0.1:${SB_PORT}`;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : join(tmpdir(), "keepalive-spike");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function storybookUp() {
  try {
    await fetchJson(`${SB_URL}/index.json`);
    return null;
  } catch {
    /* not running, spawn below */
  }
  const log = openSync(join(OUT, "storybook.log"), "w");
  const child = spawn(
    join(ROOT, "node_modules", ".bin", "storybook"),
    ["dev", "-p", String(SB_PORT), "--no-open", "--quiet"],
    { cwd: ROOT, stdio: ["ignore", log, log], detached: true },
  );
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`${SB_URL}/index.json`);
      return child;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("storybook did not answer /index.json within 180s");
}

function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "keepalive-chrome-"));
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("chrome: no DevTools line within 30s")), 30_000);
    child.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on("exit", () => reject(new Error("chrome exited before DevTools was ready")));
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.pageError = null;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        this.pageError =
          msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "page exception";
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error(`ws connect failed: ${url}`)));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
}

async function runStory(cdpPort, storyId, firstStory) {
  const pageUrl = `${SB_URL}/iframe.html?id=${storyId}&viewMode=story`;
  const target = await fetchJson(`http://127.0.0.1:${cdpPort}/json/new`, { method: "PUT" });
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: pageUrl });
    const readyDeadline = Date.now() + (firstStory ? 120_000 : 30_000);
    for (;;) {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: "typeof window.__spikeRun",
        returnByValue: true,
      });
      if (result.value === "function") break;
      if (cdp.pageError) throw new Error(`${storyId}: page threw before ready: ${cdp.pageError}`);
      if (Date.now() > readyDeadline) throw new Error(`${storyId}: __spikeRun never appeared`);
      await sleep(500);
    }
    const evaled = await cdp.send("Runtime.evaluate", {
      expression: "window.__spikeRun()",
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaled.exceptionDetails) {
      throw new Error(`${storyId}: ${evaled.exceptionDetails.exception?.description ?? "run threw"}`);
    }
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${storyId.split("--")[1]}.png`), Buffer.from(shot.data, "base64"));
    return evaled.result.value;
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`).catch(() => {});
  }
}

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const JUDGES = {
  xterm(r) {
    const scrollOk = r.natural.viewportY === r.before.viewportY || r.restoredViewportY === r.before.viewportY;
    return {
      pass:
        r.natural.length === r.before.length &&
        r.natural.markerLine === r.before.markerLine &&
        scrollOk &&
        r.rendered &&
        r.postMoveMarkerFound &&
        r.contextLost === 0 &&
        r.cleanups === 0 &&
        r.errors === 0 &&
        r.hostParent === "b",
      note: `webgl=${r.webglActive} scrollNatural=${r.natural.viewportY === r.before.viewportY} rendered=${r.rendered}`,
    };
  },
  editor(r) {
    const scrollOk = near(r.naturalScrollTop, r.before.scrollTop) || near(r.restoredScrollTop, r.before.scrollTop);
    return {
      pass:
        r.after.doc === r.before.doc + "post-move ".length &&
        r.readBack === "post-move" &&
        scrollOk &&
        r.cleanups === 0 &&
        r.errors === 0 &&
        r.hostParent === "b",
      note: `scrollNatural=${near(r.naturalScrollTop, r.before.scrollTop)} restored=${r.restoredScrollTop}`,
    };
  },
  chat(r) {
    const scrollOk = near(r.naturalScrollTop, r.before.scrollTop) || near(r.restoredScrollTop, r.before.scrollTop);
    return {
      pass: scrollOk && r.restoredFocused && r.cleanups === 0 && r.errors === 0 && r.hostParent === "b",
      note: `scrollNatural=${near(r.naturalScrollTop, r.before.scrollTop)} focusNatural=${r.naturalFocused}`,
    };
  },
  stage(r) {
    const onlyP1Disposed = r.disposedSlots.length === 1 && r.disposedSlots[0] === "p1";
    return {
      pass:
        r.sameElement &&
        r.hostConnected &&
        r.hostSlot === "p2" &&
        onlyP1Disposed &&
        r.rendered &&
        r.after.length === r.before.length + 1 &&
        r.after.markerLine === r.before.markerLine &&
        r.contextLost === 0 &&
        r.errors === 0,
      note: `disposedSlots=${JSON.stringify(r.disposedSlots)} rendered=${r.rendered}`,
    };
  },
  registry(r) {
    return {
      pass:
        r.reorderAlive &&
        r.r3DetachedRetained &&
        r.redetachAlive &&
        r.markerLine.startsWith("line-0042") &&
        r.hostsConnected.every(Boolean) &&
        r.hostsUnderOwnRow.every(Boolean) &&
        r.contextLost === 0 &&
        r.errors === 0,
      note: `reorderScroll=${r.scrollBefore}->${r.reorderScrollNatural} readdScroll=${r.readdScrollNatural} termDetached=${r.termDetached}`,
    };
  },
  viewport(r) {
    return {
      pass:
        r.initialDelta <= 1 &&
        r.patchDelta <= 1 &&
        r.resizeDelta <= 1 &&
        r.scrollAfter === r.scrollBefore &&
        r.hostsConnected.every(Boolean) &&
        r.errors === 0,
      note: `deltas=${r.initialDelta}/${r.patchDelta}/${r.resizeDelta} scroll=${r.scrollBefore}->${r.scrollAfter}`,
    };
  },
  forowned(r) {
    // Adversarial probe: "pass" here means the failure mode was measured, not
    // that the shape is usable. The verdict field is what the plan records.
    const survived = r.afterReorder.parent === "outside" && r.afterRemove.parent === "outside";
    return {
      pass: true,
      note: `survived=${survived} afterReorder=${JSON.stringify(r.afterReorder)} afterRemove=${JSON.stringify(r.afterRemove)} threw=${JSON.stringify([r.reorderThrew, r.removeThrew])} errors=${r.errors}`,
    };
  },
};

async function main() {
  const sb = await storybookUp();
  const { child: chrome, port } = await launchChrome();
  const cleanup = () => {
    try {
      chrome.kill();
    } catch {}
    if (sb) {
      try {
        process.kill(-sb.pid);
      } catch {}
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(130));

  const index = await fetchJson(`${SB_URL}/index.json`);
  const ids = Object.keys(index.entries).filter(
    (id) => id.startsWith("dev-keepalivespike--") && index.entries[id].type === "story",
  );
  if (ids.length === 0) throw new Error("no dev-keepalivespike stories in index.json");

  const results = [];
  let first = true;
  for (const id of ids) {
    process.stdout.write(`running ${id} ... `);
    try {
      const r = await runStory(port, id, first);
      const judge = JUDGES[r.scenario] ?? (() => ({ pass: false, note: "no judge" }));
      const verdict = judge(r);
      results.push({ id, ...r, ...verdict });
      console.log(`${verdict.pass ? "PASS" : "FAIL"}  ${verdict.note}`);
    } catch (e) {
      results.push({ id, pass: false, note: String(e) });
      console.log(`ERROR ${e}`);
    }
    first = false;
  }

  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\nresults + screenshots: ${OUT}`);
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
