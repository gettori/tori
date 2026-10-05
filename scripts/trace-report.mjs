#!/usr/bin/env node
// Joins the two trace files written under TORI_TRACE and prints what the plan's
// targets are read from: a row per switch with paint and settled, and a per
// invoke breakdown carrying queue wait.
//
// Queue wait is backend arrival minus the moment JS asked, joined on the id the
// frontend puts in each invoke's argument map. It is the number that says
// whether a command was waiting for the IPC thread or doing work.
//
//   node scripts/trace-report.mjs [--dir ~/.config/tori/trace] [--invokes]
//
// --invokes prints every invoke of every switch, not just the slowest few.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir");
const dir = dirArg >= 0 ? args[dirArg + 1] : join(homedir(), ".config/tori/trace");
const allInvokes = args.includes("--invokes");

const read = (name) => {
  try {
    return readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    console.error(`cannot read ${join(dir, name)}: ${e.message}`);
    process.exit(1);
  }
};

const front = read("frontend.jsonl");
const back = read("backend.jsonl");

const backById = new Map();
for (const r of back) if (r.t === "cmd" && r.id != null) backById.set(r.id, r);

// Body spans (phase 2): a command moved off the IPC thread returns from the
// handler at spawn time, so its `cmd` line measures dispatch and a separate
// `body` line carries the real work. Bodies have no id (the id lives in the
// payload the handler consumed), so each cmd greedily claims the first
// unclaimed body of its name that starts at or after its arrival.
const bodiesByName = new Map();
for (const r of back) {
  if (r.t !== "body") continue;
  if (!bodiesByName.has(r.name)) bodiesByName.set(r.name, []);
  bodiesByName.get(r.name).push(r);
}
for (const list of bodiesByName.values()) list.sort((a, b) => a.enter - b.enter);
const bodyOf = new Map(); // cmd line -> body line
{
  const cmds = back.filter((r) => r.t === "cmd").sort((a, b) => a.enter - b.enter);
  const cursors = new Map();
  for (const c of cmds) {
    const list = bodiesByName.get(c.name);
    if (!list) continue;
    let i = cursors.get(c.name) ?? 0;
    while (i < list.length && list[i].enter < c.enter - 1) i++;
    if (i < list.length) {
      bodyOf.set(c, list[i]);
      cursors.set(c.name, i + 1);
    }
  }
}

const jsById = new Map();
for (const r of front) if (r.t === "invoke") jsById.set(r.id, r);

const ms = (n) => (n == null ? "  n/a" : `${n.toFixed(1)}ms`.padStart(8));

// Concurrency: real work overlaps when two spans intersect on different
// threads. Work spans are body lines where a command has one (async bodies)
// and the cmd line itself where it does not (still-sync commands). Before
// phase 2 this was always zero.
const spans = back
  .filter((r) => r.t === "cmd")
  .map((c) => bodyOf.get(c) ?? c)
  .sort((a, b) => a.enter - b.enter);
let overlaps = 0;
for (let i = 0; i < spans.length; i++) {
  for (let j = i + 1; j < spans.length && spans[j].enter < spans[i].ret; j++) {
    if (spans[j].thread !== spans[i].thread) overlaps++;
  }
}

// Walked in order so each switch carries the pass it happened in: the recipe
// writes a note before each pass, and "first visit" and "warm" are the same
// event distinguished only by what came before.
const switches = [];
let pass = "adhoc";
for (const r of front) {
  if (r.t === "note" && r.name === "pass") pass = r.data.name;
  if (r.t === "switch") switches.push({ ...r, pass });
}
const notes = front.filter((r) => r.t === "note" && r.name !== "chat-open");

// `size` is what counting `bytes` cost inside the round trip, so it comes out
// of IPC. Joined by time, not order: autopilot reads a session's history too,
// and its backend line has no frontend twin.
const backOpens = back.filter((r) => r.t === "chat-open");
const opens = front
  .filter((r) => r.t === "note" && r.name === "chat-open")
  .map((r) => {
    const f = r.data;
    const b = backOpens.find((o) => o.session === f.session && o.at >= f.start && o.at <= f.start + f.invoke);
    const ipc = b ? f.invoke - b.read - b.size : null;
    return { ...f, events: b?.events, bytes: b?.bytes, read: b?.read, ipc };
  });

console.log(`trace dir: ${dir}`);
console.log(`switches: ${switches.length}   backend commands: ${spans.length}   overlapping pairs: ${overlaps}\n`);

if (opens.length) {
  console.log("chat opens");
  for (const o of opens) {
    const mb = o.bytes == null ? "     n/a" : `${(o.bytes / 1048576).toFixed(1)}MB`.padStart(8);
    console.log(
      `  ${o.session}  events ${String(o.events ?? "n/a").padStart(6)}  ${mb}  read ${ms(o.read)}  ipc ${ms(o.ipc)}  fold ${ms(o.fold)}  paint ${ms(o.paint)}`,
    );
  }
  console.log("");
}

if (notes.length) {
  console.log("recipe");
  for (const n of notes) console.log(`  ${n.name.padEnd(16)} ${JSON.stringify(n.data)}`);
  console.log("");
}

for (const s of switches) {
  const label = s.kind === "tab" ? "tab" : "worktree";
  console.log(`${label.padEnd(8)} ${s.key}`);
  console.log(`  paint ${ms(s.paint)}   settled ${ms(s.settled)}   invokes ${s.invokes.length}`);

  const rows = s.invokes
    .map((iv) => {
      const b = backById.get(iv.id);
      const js = jsById.get(iv.id);
      const wait = b && js ? b.enter - js.call : null;
      const work = b ? (bodyOf.get(b) ?? b) : null;
      const body = work ? work.ret - work.enter : null;
      return { name: iv.name, at: iv.call, js: iv.dur, wait, body, thread: work?.thread ?? "?" };
    })
    .sort((a, b) => b.js - a.js);

  for (const r of allInvokes ? rows : rows.slice(0, 8)) {
    console.log(
      `    ${r.name.padEnd(28)} at ${ms(r.at)}  js ${ms(r.js)}  wait ${ms(r.wait)}  body ${ms(r.body)}  ${r.thread}`,
    );
  }
  if (!allInvokes && rows.length > 8) console.log(`    ... ${rows.length - 8} more (--invokes)`);
  // Marks in order, each with the interval since the one before it: an invoke
  // says when the backend answered, a gap between two marks says which code the
  // main thread was inside while it did not hear the answer.
  if (s.marks?.length) {
    let prev = 0;
    const line = s.marks
      .map((m) => {
        const step = m.at - prev;
        prev = m.at;
        return `${m.name} ${m.at.toFixed(0)}(+${step.toFixed(0)})`;
      })
      .join("  ");
    console.log(`    marks: ${line}`);
  }
  console.log("");
}

// The summary the baseline table is filled from.
const stat = (list, pick) => {
  const v = list
    .map(pick)
    .filter((n) => n != null)
    .sort((a, b) => a - b);
  if (!v.length) return "n/a";
  const p = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))];
  return `n=${v.length} median ${p(0.5).toFixed(1)}ms  p90 ${p(0.9).toFixed(1)}ms  max ${v[v.length - 1].toFixed(1)}ms`;
};
console.log("summary (baseline table rows)");
const passes = [...new Set(switches.map((s) => s.pass))];
for (const p of passes) {
  for (const kind of ["worktree", "tab"]) {
    const rows = switches.filter((s) => s.pass === p && s.kind === kind);
    if (!rows.length) continue;
    console.log(`  ${p}/${kind} paint    ${stat(rows, (s) => s.paint)}`);
    if (kind === "worktree") console.log(`  ${p}/${kind} settled  ${stat(rows, (s) => s.settled)}`);
  }
}

// Whether the run is usable at all, before any of its numbers are read. Two
// signatures discard it: a switch that reported no paint, and a stall between
// two consecutive switches, which leaves a plausible-looking recovery row after
// it (an occluded window is the known cause, and the 124-second gap is what it
// looked like). Nulls alone are not the whole test.
//
// Gaps are measured inside a pass and never across one, and the first switch of
// each pass is skipped: the recipe's own scripted pauses between passes run to
// seconds (a spawn loop, the stream settle), so a threshold tight enough to
// mean anything would flag every pass boundary. STALL_MS sits above every
// scripted intra-pass pause and far below the signature being rejected.
const STALL_MS = 8000;
const nulls = switches.filter((s) => s.paint == null);
const gapByPass = new Map();
for (let i = 1; i < switches.length; i++) {
  const [prev, s] = [switches[i - 1], switches[i]];
  if (s.pass !== prev.pass) continue;
  const gap = s.start - prev.start;
  if (gap > (gapByPass.get(s.pass)?.gap ?? 0)) gapByPass.set(s.pass, { gap, key: s.key });
}
const stalled = [...gapByPass].filter(([, g]) => g.gap > STALL_MS);
console.log("\nvalidity");
console.log(`  null paints       ${nulls.length}${nulls.length ? ` (${nulls.map((s) => s.key).join(", ")})` : ""}`);
for (const [p, g] of gapByPass) {
  console.log(`  max gap ${p.padEnd(18)} ${g.gap.toFixed(0)}ms before ${g.key}`);
}
console.log(`  verdict           ${!nulls.length && !stalled.length ? "valid" : "DISCARD"}`);

const waits = [...backById.values()]
  .map((b) => (jsById.has(b.id) ? b.enter - jsById.get(b.id).call : null))
  .filter((n) => n != null);
console.log(
  `  queue wait        ${stat(
    waits.map((w) => ({ w })),
    (x) => x.w,
  )}`,
);

// Main-thread work, from `TORI_RECIPE=work` or any traced run: one row per
// seam. A task pushes the next paint out by about its own length, so a frame
// that dropped (its gap at least 1.5x the pass's control median) is charged its
// whole gap, less what sizing an invoke answer cost the trace; a sync seam is
// never charged less than its own time. A gap over a second is an occluded
// window, not work.
const GATE_MS = 16;
const UNMEASURED_MS = 1000;
const works = [];
const controls = new Map();
let workPass = "adhoc";
for (const r of front) {
  if (r.t === "note" && r.name === "pass") workPass = r.data.name;
  if (r.t === "frames") {
    const name = r.label.replace(/^before-/, "");
    if (!controls.has(name)) controls.set(name, []);
    controls.get(name).push(r.median);
  }
  if (r.t === "work") works.push({ ...r, pass: workPass });
}
if (works.length) {
  const allControls = [...controls.values()].flat().sort((a, b) => a - b);
  const fallback = allControls.length ? allControls[Math.floor(allControls.length / 2)] : 1000 / 60;
  const controlOf = (p) => {
    const v = (controls.get(p) ?? []).slice().sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : fallback;
  };
  const bySeam = new Map();
  for (const w of works) {
    const sizing = w.seams["trace-sizing"] ?? 0;
    const measured = w.frame != null && w.frame <= UNMEASURED_MS;
    const dropped = measured && w.frame >= 1.5 * controlOf(w.pass) ? w.frame - sizing : 0;
    // Seams sharing a frame split its block by their own time, so a cheap one
    // beside an expensive one is not charged for it.
    const own = Object.entries(w.seams).filter(([name]) => name !== "trace-sizing");
    const total = own.reduce((n, [, ms]) => n + ms, 0);
    for (const [name, ms] of own) {
      if (!bySeam.has(name)) bySeam.set(name, { seam: [], block: [], unmeasured: 0 });
      const row = bySeam.get(name);
      row.seam.push(ms);
      if (!measured) {
        row.unmeasured++;
        continue;
      }
      const share = own.length === 1 ? dropped : total > 0 ? (dropped * ms) / total : dropped / own.length;
      // A seam longer than its own frame was awaiting, not blocking.
      row.block.push(Math.max(ms <= w.frame ? ms : 0, share));
    }
  }
  const pct = (v, q) =>
    v.length ? v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * q))] : null;
  console.log(`\nmain-thread work (block = a dropped frame's gap, or the seam itself; gate ${GATE_MS}ms)`);
  for (const [p, v] of controls) console.log(`  control ${p.padEnd(14)} median frame ${pct(v, 0.5).toFixed(1)}ms`);
  for (const [name, r] of [...bySeam].sort()) {
    const worst = r.block.length ? Math.max(...r.block) : null;
    const verdict =
      name === "calibrate" ? "calibration" : worst == null ? "unmeasured" : worst > GATE_MS ? "BUILD" : "drop";
    console.log(
      `  ${name.padEnd(26)} n=${String(r.seam.length).padEnd(5)} seam p50 ${ms(pct(r.seam, 0.5))} max ${ms(Math.max(...r.seam))}` +
        `  block p50 ${ms(pct(r.block, 0.5))} p90 ${ms(pct(r.block, 0.9))} max ${ms(worst)}` +
        `  unmeasured ${r.unmeasured}  ${verdict}`,
    );
  }
}

const sized = front.filter((r) => r.t === "invoke" && r.size != null);
if (sized.length) {
  const byCmd = new Map();
  for (const r of sized) {
    const c = byCmd.get(r.name) ?? { n: 0, max: 0 };
    c.n++;
    c.max = Math.max(c.max, r.size);
    byCmd.set(r.name, c);
  }
  console.log("\nlargest invoke answers (serialized size)");
  for (const [name, c] of [...byCmd].sort((a, b) => b[1].max - a[1].max).slice(0, 10)) {
    console.log(`  ${name.padEnd(28)} n=${String(c.n).padEnd(5)} max ${(c.max / 1024).toFixed(1)} KB`);
  }
}
