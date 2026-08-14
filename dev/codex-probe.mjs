#!/usr/bin/env node
// Measure what `codex app-server` actually serves, so the Codex transport can be
// written from the wire rather than from the generated bindings alone.
//
//   node dev/codex-probe.mjs              # human report
//   node dev/codex-probe.mjs --json       # machine-readable
//   node dev/codex-probe.mjs --bindings   # also size the generated bindings
//
// Why a probe when `codex app-server generate-ts` already emits the full type
// surface: the bindings are what the *build* knows, not what this binary serves.
// They are generated from the same source tree for every method the protocol has
// ever declared, including ones behind `experimentalApi`, ones that need an
// account, and ones a given release has not wired up. The question an adapter
// needs answered is narrower - given this installed version and this machine's
// auth state, which calls come back with a result - and only the running server
// answers it.
//
// Read-only by construction. Every method below either reads or fails; nothing
// here starts a turn, writes config, archives, deletes, or logs anybody out.
// `thread/start` is the one that allocates, and it is included because whether
// a thread can be started at all is the auth boundary this probe exists to find.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const WITH_BINDINGS = args.includes("--bindings");
const TIMEOUT_MS = 30_000;

// The methods worth asking about, each with params that are valid on their own
// terms so an error means something. A `-32602` would say "served but I got the
// shape wrong", which is a probe bug rather than a finding, so the params are
// taken from the generated types rather than guessed.
const PROBES = [
  { method: "getAuthStatus", params: { includeToken: false, refreshToken: false } },
  { method: "account/read", params: {} },
  { method: "config/read", params: { includeLayers: false } },
  { method: "configRequirements/read", params: undefined },
  { method: "model/list", params: { limit: 100 } },
  { method: "permissionProfile/list", params: {} },
  { method: "experimentalFeature/list", params: {} },
  { method: "skills/list", params: { cwds: [] } },
  { method: "hooks/list", params: { cwds: [] } },
  { method: "mcpServerStatus/list", params: {} },
  { method: "thread/list", params: { limit: 20 } },
  { method: "thread/loaded/list", params: {} },
  // Reaches for the account. Listed last on purpose: everything above it is
  // answerable from disk, so the first failure here locates the auth boundary.
  // `ephemeral` so a measurement never leaves a thread in the user's own store.
  { method: "thread/start", params: { cwd: process.cwd(), ephemeral: true, sandbox: "read-only" } },
];

/** Spawn the server, run every probe, and classify each answer. */
async function probe(cwd) {
  const child = spawn("codex", ["app-server", "--stdio"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_BROWSER: "1" },
  });

  let nextId = 1;
  const pending = new Map();
  let buffer = "";
  const stderr = [];
  const notifications = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.error ? { error: msg.error } : { result: msg.result });
      } else if (msg.method && msg.id === undefined) {
        notifications.push(msg.method);
      } else if (msg.method && msg.id !== undefined) {
        // A server-to-client request. Refuse rather than hang: an unanswered
        // request stalls the server, and this probe serves none of them.
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "not served by this probe" },
          }) + "\n",
        );
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderr.push(c));

  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      const msg = { jsonrpc: "2.0", id, method };
      if (params !== undefined) msg.params = params;
      child.stdin.write(JSON.stringify(msg) + "\n");
      setTimeout(() => {
        if (pending.delete(id)) resolve({ error: { code: 0, message: `timed out after ${TIMEOUT_MS}ms` } });
      }, TIMEOUT_MS).unref?.();
    });

  const out = { version: cliVersion(), methods: [] };
  try {
    // Mirrors what a Sway transport would send: named client, and the
    // experimental opt-in on, since `app-server` is itself marked experimental
    // and half the thread verbs sit behind that flag.
    const init = await call("initialize", {
      clientInfo: { name: "sway-probe", title: null, version: "0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (init.error) {
      out.error = JSON.stringify(init.error);
      return out;
    }
    out.initialize = init.result;
    // The server waits for this before it will serve anything else.
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");

    for (const p of PROBES) {
      const answer = await call(p.method, p.params);
      out.methods.push({ method: p.method, ...classify(answer) });
    }
    out.notifications = [...new Set(notifications)];
  } finally {
    child.kill("SIGKILL");
  }
  if (stderr.length) out.stderr = stderr.join("").slice(0, 600);
  return out;
}

/**
 * What one answer means. The distinction that matters is *unknown* versus
 * *refused*: an unimplemented method is a gap in this release, while an
 * auth failure is a gap in this machine and says nothing about the protocol.
 */
function classify(answer) {
  if (answer.result !== undefined) {
    return { status: "served", shape: shapeOf(answer.result) };
  }
  const e = answer.error ?? {};
  const text = `${e.message ?? ""}`;
  if (e.code === -32601) return { status: "unknown", detail: text };
  if (e.code === -32602) return { status: "bad-params", detail: text };
  if (/auth|login|sign in|credential/i.test(text)) return { status: "auth", detail: text };
  return { status: "error", detail: `${e.code}: ${text}` };
}

/** A one-line summary of a result, so the report says what came back. */
function shapeOf(result) {
  if (result === null) return "null";
  if (Array.isArray(result)) return `array(${result.length})`;
  if (typeof result !== "object") return typeof result;
  return Object.entries(result)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: array(${v.length})` : `${k}: ${summarise(v)}`))
    .join(", ");
}

function summarise(v) {
  if (v === null) return "null";
  if (typeof v === "object") return `{${Object.keys(v).length} keys}`;
  const s = String(v);
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

function cliVersion() {
  const r = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

/**
 * How much protocol a typed transport would have to carry. Generated into a
 * temp dir rather than committed: the bindings are a *measurement input* here,
 * not a dependency, and committing 6k lines of someone else's generated types
 * would be a maintenance surface Sway does not need to own.
 */
function sizeBindings() {
  const out = join(process.env.TMPDIR ?? "/tmp", `codex-bindings-${process.pid}`);
  const r = spawnSync("codex", ["app-server", "generate-ts", "--out", out], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status !== 0) return { error: (r.stderr ?? "").split("\n")[0] || "generate-ts failed" };
  let files = 0;
  let lines = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".ts")) {
        files += 1;
        lines += spawnSync("wc", ["-l", p], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0] * 1;
      }
    }
  };
  walk(out);
  spawnSync("rm", ["-rf", out]);
  return { out, files, lines };
}

function report(r, bindings) {
  const lines = [`Codex app-server measurement  (${r.version})`];
  if (r.error) {
    lines.push(`  initialize FAILED: ${r.error}`);
    if (r.stderr) lines.push(`  stderr: ${r.stderr.split("\n")[0]}`);
    return lines.join("\n");
  }
  const init = r.initialize ?? {};
  lines.push(`  userAgent: ${init.userAgent ?? "(absent)"}`);
  lines.push(`  codexHome: ${init.codexHome ?? "(absent)"}`);
  lines.push("");
  lines.push("  method                          status      detail");
  for (const m of r.methods) {
    const detail = m.shape ?? m.detail ?? "";
    lines.push(`  ${m.method.padEnd(31)} ${m.status.padEnd(11)} ${detail.slice(0, 90)}`);
  }
  const counts = {};
  for (const m of r.methods) counts[m.status] = (counts[m.status] ?? 0) + 1;
  lines.push("");
  lines.push(`  ${r.methods.length} probed: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (r.notifications?.length) {
    lines.push(`  notifications seen: ${r.notifications.join(", ")}`);
  }
  if (bindings) {
    lines.push("");
    lines.push(
      bindings.error
        ? `  bindings: ${bindings.error}`
        : `  bindings: ${bindings.files} files, ${bindings.lines} lines from \`codex app-server generate-ts\``,
    );
  }
  return lines.join("\n");
}

async function main() {
  if (spawnSync("command", ["-v", "codex"], { shell: true, encoding: "utf8" }).status !== 0) {
    console.error("codex is not on PATH, nothing to measure");
    process.exitCode = 1;
    return;
  }
  const r = await probe(process.cwd());
  const bindings = WITH_BINDINGS ? sizeBindings() : null;
  if (AS_JSON) {
    console.log(JSON.stringify({ ...r, bindings }, null, 2));
    return;
  }
  console.log(report(r, bindings));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
