#!/usr/bin/env node
// Find how much Tori holds before it slows down, one dimension at a time.
//
// Every step is its own launch: a throwaway HOME (seeded repos, a fake `claude`
// first on the login PATH), a capacity build started into it with
// `TORI_RECIPE=capacity`, the dimension raised to the step, then an idle window
// and a busy window (every session streaming) while the in-app probe switches
// worktrees and tabs. A fresh launch per step keeps uptime and every chat's
// history the same at every step, so the only thing that differs is the step.
//
// A step is slow when a metric in dev/capacity/thresholds.json gets `ratio`
// times worse than the same window at the first step, and by at least `floor`.
// The last step before that is the capacity. Relative rather than absolute, so
// the answer holds on any Mac and no budget has to be guessed.
//
//   CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true CARGO_TARGET_DIR=$PWD/src-tauri/target/capacity \
//     pnpm tauri build --no-bundle --config dev/capacity/tauri.capacity.conf.json
//   node dev/capacity/run.mjs sessions                     # chat sessions, each --history tool calls long
//   node dev/capacity/run.mjs history                      # tool calls in one chat
//   node dev/capacity/run.mjs projects --steps 8,32,128    # projects in one space
//   node dev/capacity/run.mjs spaces                       # spaces of one project each
//   node dev/capacity/run.mjs files                        # files open in the editor
//
// Options: --steps a,b,c   --window <s> per window (default 60)   --history <n> tool
// calls in every chat before measuring (default 20)   --keep-going past the first
// slow step   --keep the scratch HOMEs   --census to time which region of the window
// layout is spent on (once, slow)   --out <file.md> for the report   --app
// <binary> (default the capacity build above).
//
// The build is optimised but keeps debug assertions, which is what keeps it off
// launchd and out of ~/.config/tori: a plain release build would replace the
// real Tori's daemon. Leave the Mac alone while it runs. An occluded window
// gets no frames, so every switch would time out and read as slow.

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");

const DIMENSIONS = {
  sessions: { steps: [2, 4, 8, 16, 32, 64], unit: "chat sessions" },
  history: { steps: [50, 100, 200, 400, 800, 1600], unit: "tool calls in one chat" },
  projects: { steps: [4, 8, 16, 32, 64, 128], unit: "projects" },
  spaces: { steps: [2, 4, 8, 16, 32, 64], unit: "spaces beyond the two the probe uses" },
  files: { steps: [5, 10, 20, 40, 80], unit: "open files" },
};
const BASE_PROJECTS = 4;
const FILES_PER_REPO = 200;
const SETTLE_MS = 8000;
const SAMPLE_MS = 2000;
const SWITCH_TIMEOUT_MS = 5000;
const FILL_TIMEOUT_MS = 10 * 60_000;

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const dimension = argv.find((a) => a in DIMENSIONS);
if (!dimension) {
  console.error(`usage: node dev/capacity/run.mjs <${Object.keys(DIMENSIONS).join("|")}> [options]`);
  process.exit(2);
}
const steps = opt("--steps", null)?.split(",").map(Number) ?? DIMENSIONS[dimension].steps;
const windowMs = Number(opt("--window", 60)) * 1000;
const history = Number(opt("--history", 20));
const keepGoing = argv.includes("--keep-going");
const keep = argv.includes("--keep");
const census = argv.includes("--census");
const outFile = opt("--out", null);
const app = opt("--app", join(repo, "src-tauri/target/capacity/release/tori"));
const thresholds = JSON.parse(readFileSync(join(here, "thresholds.json"), "utf8"));
const fake = join(here, "fake-claude.mjs");

if (!existsSync(app)) {
  console.error(`no capacity build at ${app}; build it with the command in this file's header`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const pad = (n) => String(n).padStart(3, "0");

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=capacity", "-c", "user.email=capacity@localhost", ...args], {
    cwd,
    stdio: "ignore",
  });
}

// Built once and copied, so seeding a hundred projects costs a hundred `cp`s.
const template = realpathSync(mkdtempSync("/tmp/tori-cap-template-"));
function makeTemplate() {
  for (let i = 0; i < FILES_PER_REPO; i++) {
    const dir = join(template, "src", `mod${i % 20}`);
    mkdirSync(dir, { recursive: true });
    const body = Array.from({ length: 40 }, (_, l) => `export const v${l} = ${i * 40 + l};`).join("\n");
    writeFileSync(join(dir, `file${i}.ts`), `${body}\n`);
  }
  writeFileSync(join(template, "README.md"), "# capacity\n");
  git(template, "init", "-q", "-b", "main");
  git(template, "add", "-A");
  git(template, "commit", "-q", "-m", "seed");
}

function makeRepo(path) {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync("cp", ["-R", template, path]);
}

function seed(ctx, step) {
  const { home, config, projects } = ctx;
  const bin = join(home, ".capacity/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(home, ".zshrc"), `export PATH="${bin}:$PATH"\n`);
  writeFileSync(join(home, ".capacity/fake.json"), JSON.stringify({ turnSeconds: 0 }));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "tori.toml"), `space_order = ["probe", "load"]\n\n[discovery]\nroots = ["~/Projects"]\n`);
  writeFileSync(join(config, "state.json"), JSON.stringify({ introSeen: true }));
  writeFileSync(join(config, "trusted.json"), JSON.stringify({ trusted: [projects] }));
  makeRepo(join(projects, "probe/a"));
  makeRepo(join(projects, "probe/b"));
  const load = dimension === "projects" ? step : BASE_PROJECTS;
  for (let i = 1; i <= load; i++) makeRepo(join(projects, "load", `p${pad(i)}`));
  if (dimension === "spaces") for (let i = 1; i <= step; i++) makeRepo(join(projects, `s${pad(i)}`, "app"));
}

function processes() {
  const out = execFileSync("ps", ["-axww", "-o", "pid=,rss=,time=,args="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [, pid, rss, time, args] = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/) ?? [];
      const cpu = (time ?? "0").split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
      return { pid: Number(pid), rssKb: Number(rss), cpu, args: args ?? "" };
    });
}

const webkitPids = () =>
  new Set(
    processes()
      .filter((p) => p.args.includes("com.apple.WebKit"))
      .map((p) => p.pid),
  );

function connect(sock) {
  const conn = createConnection(sock);
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  conn.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  return new Promise((resolve, reject) => {
    conn.on("error", reject);
    conn.on("connect", () =>
      resolve({
        async call(method, params = {}) {
          const id = nextId++;
          conn.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
          const reply = await new Promise((r) => pending.set(id, r));
          if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
          return reply.result;
        },
        end: () => conn.end(),
      }),
    );
  });
}

async function attach(config) {
  const bridge = join(config, "rpc.json");
  for (let i = 0; i < 120; i++) {
    if (existsSync(bridge)) {
      try {
        const { sock, token } = JSON.parse(readFileSync(bridge, "utf8"));
        const rpc = await connect(sock);
        await rpc.call("auth", { token });
        return rpc;
      } catch {
        // The bridge file lands before the socket listens.
      }
    }
    await sleep(500);
  }
  throw new Error("the app socket never came up");
}

async function units(rpc) {
  const tree = await rpc.call("projects.list");
  return tree.spaces.flatMap((s) =>
    s.projects.flatMap((p) => p.units.map((u) => ({ space: s.name, folder: u.folder }))),
  );
}

async function waitFor(what, check, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const doneFile = (ctx, id) => join(ctx.home, ".capacity/done", id);

async function waitTurns(ctx, ids) {
  await waitFor(
    `${ids.length} turns to finish`,
    () => ids.every((id) => existsSync(doneFile(ctx, id))),
    FILL_TIMEOUT_MS,
  );
}

async function spawnSessions(ctx, n) {
  const all = await units(ctx.rpc);
  const probe = all.filter((u) => u.space === "probe").map((u) => u.folder);
  const load = all.filter((u) => u.space === "load").map((u) => u.folder);
  const fresh = [];
  while (ctx.sessions.length < n) {
    // One chat per probe worktree and the rest elsewhere, so every step probes
    // the same tabs and only the load around them grows.
    const i = ctx.sessions.length;
    const folder = i < probe.length ? probe[i] : load[(i - probe.length) % load.length];
    const prompt = `capacity tools=${history}`;
    const { id } = await ctx.rpc.call("session.spawn", { agent: "claude", folder, prompt });
    ctx.sessions.push(id);
    fresh.push(id);
    // A spawned session runs in the background with no tab, and a chat nobody
    // has open costs nothing to render.
    await ctx.rpc.call("window.reveal", { id }).catch(() => {});
    await sleep(300);
  }
  await waitTurns(ctx, fresh);
}

async function grow(ctx, step) {
  if (dimension === "sessions") return spawnSessions(ctx, step);
  if (dimension === "history") {
    const [id] = ctx.sessions;
    rmSync(doneFile(ctx, id), { force: true });
    await ctx.rpc.call("session.steer", { id, text: `capacity tools=${step}` });
    return waitTurns(ctx, [id]);
  }
  if (dimension === "files") {
    for (let i = 0; i < step; i++) {
      await ctx.rpc.call("window.open", { path: join(ctx.projects, "probe/a/src", `mod${i % 20}`, `file${i}.ts`) });
      await sleep(200);
    }
  }
}

function readTrace(ctx, name) {
  try {
    return readFileSync(join(ctx.config, "trace", name), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function quantile(values, q) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return Math.round(v[Math.min(v.length - 1, Math.floor(v.length * q))] * 10) / 10;
}

function measureWindow(ctx, t0, t1, samples) {
  const front = readTrace(ctx, "frontend.jsonl");
  const back = readTrace(ctx, "backend.jsonl");
  const inside = (t) => t >= t0 && t <= t1;
  const switches = front.filter((r) => r.t === "switch" && inside(r.start));
  const worktree = switches.filter((r) => r.kind === "worktree");
  const tab = switches.filter((r) => r.kind === "tab");
  const orTimeout = (v) => v ?? SWITCH_TIMEOUT_MS;
  const probes = front
    .filter((r) => r.t === "note" && r.name === "capacity-probe" && inside(r.data.at))
    .map((r) => r.data);
  const enter = new Map(back.filter((r) => r.t === "cmd" && r.id != null).map((r) => [r.id, r.enter]));
  const queue = front
    .filter((r) => r.t === "invoke" && inside(r.call) && enter.has(r.id))
    .map((r) => Math.max(0, enter.get(r.id) - r.call));

  const first = samples[0];
  const last = samples.at(-1);
  let cpu = null;
  if (first && last && last.at > first.at) {
    let spent = 0;
    for (const [pid, after] of last.cpu) if (first.cpu.has(pid)) spent += after - first.cpu.get(pid);
    cpu = Math.round((spent / ((last.at - first.at) / 1000)) * 1000) / 10;
  }
  return {
    "switch.worktree.settled.p95": quantile(
      worktree.map((r) => orTimeout(r.settled)),
      0.95,
    ),
    "switch.worktree.paint.p95": quantile(
      worktree.map((r) => orTimeout(r.paint)),
      0.95,
    ),
    "switch.tab.paint.p95": quantile(
      tab.map((r) => orTimeout(r.paint)),
      0.95,
    ),
    "frames.p90": quantile(
      probes.map((p) => p.p90).filter((v) => v != null),
      0.5,
    ),
    "frames.p99": quantile(
      probes.map((p) => p.p99).filter((v) => v != null),
      0.5,
    ),
    "invoke.queue.p95": quantile(queue, 0.95),
    cpu,
    rssMb: Math.round(Math.max(0, ...samples.map((s) => s.rssKb)) / 1024),
    agents: Math.max(0, ...samples.map((s) => s.agents)),
    dom: Math.max(0, ...probes.map((p) => p.dom ?? 0)),
    counts: { worktree: worktree.length, tab: tab.length, timeouts: worktree.filter((r) => r.settled == null).length },
    raw: {
      settled: worktree.map((r) => r.settled),
      paint: worktree.map((r) => r.paint),
      tab: tab.map((r) => r.paint),
    },
  };
}

async function observe(ctx) {
  const ours = (p) => p.args.startsWith(app) || ctx.webkit.has(p.pid);
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < windowMs) {
    const all = processes();
    const mine = all.filter(ours);
    samples.push({
      at: Date.now(),
      cpu: new Map(mine.map((p) => [p.pid, p.cpu])),
      rssKb: mine.reduce((sum, p) => sum + p.rssKb, 0),
      agents: all.filter((p) => p.args.includes(fake)).length,
    });
    await sleep(SAMPLE_MS);
  }
  await sleep(1000);
  return measureWindow(ctx, t0, Date.now(), samples);
}

async function stream(ctx) {
  writeFileSync(join(ctx.home, ".capacity/fake.json"), JSON.stringify({ turnSeconds: windowMs / 1000 + 10 }));
  for (const id of ctx.sessions) await ctx.rpc.call("session.steer", { id, text: "capacity stream" }).catch(() => {});
  await sleep(3000);
}

function judge(idle, busy, base) {
  const failed = [];
  for (const row of thresholds) {
    const windows =
      row.window === "idle"
        ? [["idle", idle]]
        : [
            ["idle", idle],
            ["busy", busy],
          ];
    for (const [label, m] of windows) {
      const value = m[row.name];
      const was = base[label][row.name];
      if (value == null || was == null) continue;
      if (value > was * row.ratio && value - was > row.floor) {
        failed.push(`${row.name} ${label} ${value}${row.unit}, was ${was} at step ${base.step}`);
      }
    }
  }
  return failed;
}

function stopAll() {
  for (const p of processes()) {
    if (p.args.startsWith(app) || p.args.includes(fake)) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}

async function shutdown(ctx) {
  ctx.rpc?.end();
  ctx.child?.kill("SIGTERM");
  stopAll();
  await waitFor("the app to exit", () => !processes().some((p) => p.args.startsWith(app)), 20_000).catch(() => {
    for (const p of processes()) {
      if (!p.args.startsWith(app)) continue;
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  if (!keep) rmSync(ctx.home, { recursive: true, force: true });
}

let current = null;

async function runStep(step, launches) {
  const home = realpathSync(mkdtempSync("/tmp/tori-cap-"));
  const ctx = { home, config: join(home, ".config/tori-dev"), projects: join(home, "Projects"), sessions: [] };
  current = ctx;
  log(`step ${step}: seeding ${home}`);
  seed(ctx, step);

  const env = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/zsh",
    TORI_TRACE: "1",
    TORI_RECIPE: census ? "capacity:census" : "capacity",
  };
  for (const k of ["ZDOTDIR", "TORI_SOCK", "TORI_CALLER"]) delete env[k];
  const before = webkitPids();
  const out = openSync(join(home, "app.log"), "a");
  ctx.child = spawn(app, [], { env, stdio: ["ignore", out, out] });
  try {
    ctx.rpc = await attach(ctx.config);
    await waitFor("the probe space", async () => (await units(ctx.rpc)).filter((u) => u.space === "probe").length >= 2);
    await sleep(SETTLE_MS);
    ctx.webkit = new Set([...webkitPids()].filter((pid) => !before.has(pid)));
    launches.push(ctx.webkit.size);

    // The probe clicks tabs that are not selected, so each probe worktree needs two.
    for (const unit of ["a", "b"]) {
      for (const file of ["src/mod19/file199.ts", "src/mod18/file198.ts"]) {
        await ctx.rpc.call("window.open", { path: join(ctx.projects, "probe", unit, file) });
        await sleep(300);
      }
    }
    await spawnSessions(ctx, 2);
    log(`step ${step}: growing`);
    await grow(ctx, step);
    writeFileSync(join(home, ".capacity/fake.json"), JSON.stringify({ turnSeconds: 0 }));
    await sleep(SETTLE_MS);
    log(`step ${step}: idle window`);
    const idle = await observe(ctx);
    log(`step ${step}: busy window, ${ctx.sessions.length} sessions streaming`);
    await stream(ctx);
    const busy = await observe(ctx);
    return { step, idle, busy };
  } finally {
    await shutdown(ctx);
    current = null;
  }
}

function machine() {
  const sh = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  };
  return {
    model: sh("sysctl", ["-n", "hw.model"]),
    chip: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    macos: sh("sw_vers", ["-productVersion"]),
    tori: sh("git", ["-C", repo, "describe", "--always", "--dirty"]),
  };
}

const fmt = (v) => (v == null ? "n/a" : String(v));

function markdown(report) {
  const m = report.machine;
  const unit = DIMENSIONS[report.dimension].unit;
  const lines = [
    `# Capacity: ${report.dimension}`,
    "",
    `${m.chip}, ${m.cores} cores, ${m.memoryGb} GB, macOS ${m.macos}, Tori ${m.tori}, ${report.date}`,
    "",
    `Steps are ${unit}. Every chat holds ${report.history} tool calls before a step is measured, and every step is a fresh launch.`,
    "",
    report.capacity == null
      ? `No step finished.`
      : `Capacity: ${report.capacity} ${unit}${report.limit ? `, slow at ${report.limit.step}: ${report.limit.failed.join("; ")}` : ", every step passed"}.`,
    "",
    "| step | window | worktree settled p95 | worktree paint p95 | tab paint p95 | frame p90 | frame p99 | queue p95 | cpu % | rss MB | agents | dom | switches |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const s of report.steps) {
    for (const [label, w] of [
      ["idle", s.idle],
      ["busy", s.busy],
    ]) {
      lines.push(
        `| ${s.step} | ${label} | ${fmt(w["switch.worktree.settled.p95"])} | ${fmt(w["switch.worktree.paint.p95"])} | ${fmt(w["switch.tab.paint.p95"])} | ${fmt(w["frames.p90"])} | ${fmt(w["frames.p99"])} | ${fmt(w["invoke.queue.p95"])} | ${fmt(w.cpu)} | ${w.rssMb} | ${w.agents} | ${w.dom} | ${w.counts.worktree}w ${w.counts.tab}t ${w.counts.timeouts} timed out |`,
      );
    }
  }
  lines.push(
    "",
    `Times in ms. Slow means ${report.thresholds[0].ratio}x worse than the first step, past a floor per metric (dev/capacity/thresholds.json).`,
  );
  return `${lines.join("\n")}\n`;
}

process.on("SIGINT", async () => {
  if (current) await shutdown(current);
  rmSync(template, { recursive: true, force: true });
  process.exit(130);
});

async function main() {
  makeTemplate();
  const report = { dimension, history, date: new Date().toISOString(), machine: machine(), thresholds, steps: [] };
  const launches = [];
  for (const step of steps) {
    const result = await runStep(step, launches);
    const base = report.steps[0] ?? result;
    result.failed = judge(result.idle, result.busy, base);
    report.steps.push(result);
    log(
      `step ${step}: ${result.failed.length ? `slow (${result.failed.join("; ")})` : "no slower than the first step"}`,
    );
    if (result.failed.length && !keepGoing) break;
  }
  report.webkitPerLaunch = launches;

  const firstFail = report.steps.find((s) => s.failed.length);
  const passed = report.steps.filter((s) => !s.failed.length && (!firstFail || s.step < firstFail.step));
  report.capacity = passed.at(-1)?.step ?? null;
  report.limit = firstFail ? { step: firstFail.step, failed: firstFail.failed } : null;

  const md = markdown(report);
  if (outFile) {
    writeFileSync(outFile, md);
    writeFileSync(outFile.replace(/\.md$/, "") + ".json", JSON.stringify(report, null, 2));
  }
  console.log(`\n${md}`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => rmSync(template, { recursive: true, force: true }));
