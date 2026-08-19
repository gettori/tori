#!/usr/bin/env node
// Joins the two trace files written under SWAY_TRACE and prints what the plan's
// targets are read from: a row per switch with paint and settled, and a per
// invoke breakdown carrying queue wait.
//
// Queue wait is backend arrival minus the moment JS asked, joined on the id the
// frontend puts in each invoke's argument map. It is the number that says
// whether a command was waiting for the IPC thread or doing work.
//
//   node scripts/trace-report.mjs [--dir ~/.config/sway/trace] [--invokes]
//
// --invokes prints every invoke of every switch, not just the slowest few.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir");
const dir = dirArg >= 0 ? args[dirArg + 1] : join(homedir(), ".config/sway/trace");
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

const jsById = new Map();
for (const r of front) if (r.t === "invoke") jsById.set(r.id, r);

const ms = (n) => (n == null ? "  n/a" : `${n.toFixed(1)}ms`.padStart(8));

// Concurrency: a command overlaps another when its [enter, ret] intersects one
// on a different thread. With every command sync on the IPC thread this is
// always zero, which is the phase 2 "before" reading.
const spans = back.filter((r) => r.t === "cmd").sort((a, b) => a.enter - b.enter);
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
const notes = front.filter((r) => r.t === "note");

console.log(`trace dir: ${dir}`);
console.log(`switches: ${switches.length}   backend commands: ${spans.length}   overlapping pairs: ${overlaps}\n`);

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
      const body = b ? b.ret - b.enter : null;
      return { name: iv.name, at: iv.call, js: iv.dur, wait, body, thread: b?.thread ?? "?" };
    })
    .sort((a, b) => b.js - a.js);

  for (const r of allInvokes ? rows : rows.slice(0, 8)) {
    console.log(
      `    ${r.name.padEnd(28)} at ${ms(r.at)}  js ${ms(r.js)}  wait ${ms(r.wait)}  body ${ms(r.body)}  ${r.thread}`,
    );
  }
  if (!allInvokes && rows.length > 8) console.log(`    ... ${rows.length - 8} more (--invokes)`);
  console.log("");
}

// The summary the baseline table is filled from.
const stat = (list, pick) => {
  const v = list.map(pick).filter((n) => n != null).sort((a, b) => a - b);
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

const waits = [...backById.values()]
  .map((b) => (jsById.has(b.id) ? b.enter - jsById.get(b.id).call : null))
  .filter((n) => n != null);
console.log(`  queue wait        ${stat(waits.map((w) => ({ w })), (x) => x.w)}`);
