#!/usr/bin/env node
// Draw the sidebar from the app socket alone: `projects.list` for the tree and
// `sessions.list` for what runs under it, redrawn as the `sessions` topic moves.
// If this and the desktop disagree, the protocol is missing something.
//
//   node dev/sidebar-probe.mjs          # draw, then redraw on every change
//   node dev/sidebar-probe.mjs --once   # draw once and exit
//
// Finds the socket like every front: `TORI_SOCK`/`TORI_CALLER` inside a Tori
// terminal, else `~/.config/tori/rpc.json`.
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const once = process.argv.includes("--once");

function locate() {
  if (process.env.TORI_SOCK && process.env.TORI_CALLER) {
    return { sock: process.env.TORI_SOCK, token: process.env.TORI_CALLER };
  }
  return JSON.parse(readFileSync(join(homedir(), ".config/tori/rpc.json"), "utf8"));
}

function connect(sock) {
  const conn = createConnection(sock);
  const pending = new Map();
  const listeners = [];
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
      } else if (msg.method === "event") {
        listeners.forEach((l) => l(msg.params));
      }
    }
  });
  conn.on("close", () => process.exit(0));
  return {
    async call(method, params = {}) {
      const id = nextId++;
      conn.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      const reply = await new Promise((resolve) => pending.set(id, resolve));
      if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
      return reply.result;
    },
    onEvent: (l) => listeners.push(l),
    end: () => conn.end(),
  };
}

const home = homedir();
const short = (path) => (path && path.startsWith(home) ? `~${path.slice(home.length)}` : path ?? "");
const inside = (cwd, folder) => !!cwd && !!folder && (cwd === folder || cwd.startsWith(`${folder}/`));

// The order the rollup badge ranks them in: what needs you wins the row.
const RANK = { needsYou: 4, working: 3, solid: 2, hollow: 1, none: 0 };
const rollup = (rows) => rows.reduce((top, r) => (RANK[r.dot] > RANK[top] ? r.dot : top), "none");

function sessionLine(r, indent) {
  const name = (r.name || r.title || r.id).split("\n")[0].slice(0, 60);
  const marks = [r.dot, r.certainty === "exact" ? "exact" : "", r.dot === "needsYou" && !r.attended ? "unseen" : ""];
  return `${indent}- ${name}  [${marks.filter(Boolean).join(", ")}]  ${r.id}`;
}

function draw(tree, rows) {
  const lines = [];
  const running = rows.filter((r) => r.dot && r.dot !== "none");
  const placed = new Set();
  const list = (here, indent) => {
    for (const r of here) {
      placed.add(r.id);
      lines.push(sessionLine(r, indent));
    }
  };
  for (const space of tree.spaces) {
    lines.push(`space ${space.name}  ${short(space.path)}`);
    for (const project of space.projects) {
      const mine = running.filter((r) => r.home?.project === project.path);
      const top = rollup(mine);
      lines.push(`  ${project.name}  ${short(project.path)}${top !== "none" ? `  (${top})` : ""}`);
      for (const unit of project.units) {
        const here = mine.filter((r) => r.home.folder === unit.folder && (r.home.branch ?? null) === (unit.branch ?? null));
        const tags = [unit.kind, unit.isCurrent ? "current" : "", unit.issue ?? "", rollup(here) !== "none" ? rollup(here) : ""];
        lines.push(`    ${unit.label}  ${tags.filter(Boolean).join("  ")}`);
        list(here, "      ");
      }
    }
  }
  for (const topic of tree.topics) {
    lines.push(`topic ${topic.name}  ${topic.branch}`);
    for (const member of topic.members) {
      const here = running.filter((r) => inside(r.cwd, member.worktreePath));
      lines.push(`  ${member.displayName}  ${short(member.worktreePath)}  ${member.state?.kind ?? ""}`);
      list(here, "    ");
    }
  }
  const elsewhere = running.filter((r) => !placed.has(r.id));
  if (elsewhere.length) {
    lines.push("not under any row");
    list(elsewhere, "  ");
  }
  return lines.join("\n");
}

const { sock, token } = locate();
const c = connect(sock);
await c.call("auth", { token });

let shown = "";
async function redraw() {
  const [tree, rows] = await Promise.all([c.call("projects.list"), c.call("sessions.list", { limit: 1000 })]);
  const text = draw(tree, rows);
  if (text === shown) return;
  shown = text;
  console.log(`${once ? "" : `--- ${new Date().toLocaleTimeString()}\n`}${text}`);
}

await redraw();
if (once) {
  c.end();
} else {
  // A burst of events is one change on screen.
  let queued = null;
  c.onEvent((p) => {
    if (p.topic !== "sessions") return;
    clearTimeout(queued);
    queued = setTimeout(() => void redraw().catch((e) => console.error(e.message)), 150);
  });
  await c.call("subscribe", { topic: "sessions" });
}
