#!/usr/bin/env node
// Measure what an ACP agent actually advertises, so an adapter and a capability
// tier can be written from the wire rather than from documentation.
//
//   node dev/acp-probe.mjs                     # every known agent that is installed
//   node dev/acp-probe.mjs --agent opencode    # one agent
//   node dev/acp-probe.mjs --json              # machine-readable, for a fixture
//
// This is a *different job* from dev/protocol-probe.mjs. That one pins a
// committed corpus of Claude's stream-json wire format and fails when the CLI
// drifts. This one answers "what does this agent offer", which is the question
// [[concept_harness_capability_tiers]] needs answered before a tier can be
// published, and which every ACP agent answers differently. There is nothing to
// pin: the point is that the answer varies per agent and per version, so the
// output is a report a human reads, not a fixture a test diffs.
//
// Why a probe rather than reading the spec: the crate's stability labels and the
// agents disagree. Session fork is marked unstable in agent-client-protocol
// 2.0.0 while both agents measured in Phase 4 advertise
// `sessionCapabilities.fork`. An advertised capability is also not a promise of
// data - `opencode acp` 1.18.3 advertises `list` and can return zero rows. So
// every claim Sway makes about an agent starts here.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The agents this probe knows how to launch. `cli` is the agent's own
// non-protocol command for the same catalogue, used to size the shortfall
// between what ACP exposes and what the agent itself knows about.
const AGENTS = {
  opencode: { program: "opencode", args: ["acp"], models_cli: ["opencode", "models"] },
  gemini: { program: "gemini", args: ["--acp"], models_cli: null },
  "cursor-agent": { program: "cursor-agent", args: ["acp"], models_cli: null },
  "claude-acp": {
    program: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    models_cli: null,
  },
  // The first-party ACP wrapper for Codex. Worth a row of its own because
  // whether it works decides whether Codex needs a transport of its own at all.
  "codex-acp": {
    program: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    models_cli: null,
  },
};

const args = process.argv.slice(2);
const ONLY = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null;
const AS_JSON = args.includes("--json");
// Long enough for an `npx` cold start to download a package, since one of the
// agents here is launched that way.
const TIMEOUT_MS = 60_000;

/** One agent, spawned and driven far enough to answer both questions. */
async function probe(name, spec, cwd) {
  const child = spawn(spec.program, spec.args, {
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
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method && msg.id === undefined) {
        notifications.push(msg.method);
      } else if (msg.method && msg.id !== undefined) {
        // An agent-to-client request. Nothing here serves fs or terminal, so
        // refuse rather than hang: an unanswered request stalls the agent.
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
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS).unref?.();
    });

  const out = { agent: name, launch: `${spec.program} ${spec.args.join(" ")}` };
  try {
    // Mirrors `initialize_request` in chat/acp_transport.rs: protocol version 1,
    // and fs/terminal declined, because that is the configuration Sway ships.
    const init = await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    out.protocolVersion = init.protocolVersion;
    out.agentCapabilities = init.agentCapabilities ?? null;
    out.authMethods = (init.authMethods ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? null,
    }));

    const session = await call("session/new", { cwd, mcpServers: [] });
    out.sessionId = session.sessionId ? "(present)" : "(absent)";
    out.configOptions = (session.configOptions ?? []).map(describeOption);
    out.notifications = [...new Set(notifications)];
  } catch (e) {
    out.error = String(e.message ?? e);
    if (stderr.length) out.stderr = stderr.join("").slice(0, 600);
  } finally {
    child.kill("SIGKILL");
  }
  return out;
}

/** One config option, reduced to what a tier or a model picker needs. */
function describeOption(o) {
  const d = {
    configId: o.configId,
    name: o.name,
    category: o.category ?? null,
    type: o.type,
  };
  if (o.type === "select") {
    // Options may be flat or grouped; both shapes are flattened, since a picker
    // reads ids and a shortfall count reads how many there are.
    const flat = [];
    for (const entry of o.options ?? []) {
      if (entry?.options) for (const sub of entry.options) flat.push(sub);
      else flat.push(entry);
    }
    d.count = flat.length;
    d.currentValue = o.currentValue ?? null;
    d.ids = flat.map((v) => v.id ?? v.value ?? null).filter(Boolean);
  } else if (o.type === "boolean") {
    d.value = o.value ?? null;
  }
  return d;
}

/** How many models the agent's own CLI knows about, for the shortfall. */
function cliModelCount(spec) {
  if (!spec.models_cli) return null;
  const [program, ...rest] = spec.models_cli;
  const r = spawnSync(program, rest, { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) return null;
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return { count: lines.length, sample: lines.slice(0, 3) };
}

function installed(program) {
  return spawnSync("command", ["-v", program], { shell: true, encoding: "utf8" }).status === 0;
}

function report(r, cli) {
  const lines = [];
  lines.push(`\n## ${r.agent}  (${r.launch})`);
  if (r.error) {
    lines.push(`  ERROR: ${r.error}`);
    if (r.stderr) lines.push(`  stderr: ${r.stderr.split("\n")[0]}`);
    return lines.join("\n");
  }
  lines.push(`  protocolVersion: ${r.protocolVersion}`);
  const caps = r.agentCapabilities ?? {};
  const sc = caps.sessionCapabilities ?? {};
  lines.push(`  loadSession: ${caps.loadSession ?? false}`);
  lines.push(
    `  sessionCapabilities: ${Object.keys(sc).length ? Object.keys(sc).sort().join(", ") : "(none)"}`,
  );
  if (caps.promptCapabilities) {
    lines.push(`  promptCapabilities: ${JSON.stringify(caps.promptCapabilities)}`);
  }
  lines.push(
    `  authMethods: ${
      r.authMethods.length
        ? r.authMethods.map((m) => `${m.id} (${m.description ?? m.name})`).join("; ")
        : "(none)"
    }`,
  );
  lines.push(`  configOptions: ${r.configOptions.length}`);
  for (const o of r.configOptions) {
    const head = `    - ${o.configId} [${o.category ?? "no category"}/${o.type}] "${o.name}"`;
    if (o.type === "select") {
      lines.push(`${head}: ${o.count} options, current=${o.currentValue ?? "none"}`);
      if (o.ids.length) lines.push(`        ${o.ids.slice(0, 6).join(", ")}${o.ids.length > 6 ? ", ..." : ""}`);
    } else {
      lines.push(`${head}: ${JSON.stringify(o.value)}`);
    }
  }
  if (cli) {
    const models = r.configOptions.filter((o) => o.category === "model" && o.type === "select");
    const overProtocol = models.reduce((n, o) => n + o.count, 0);
    lines.push(
      `  model catalogue: ${overProtocol} over ACP vs ${cli.count} from the agent's own CLI` +
        (overProtocol < cli.count ? `  <-- SHORTFALL of ${cli.count - overProtocol}` : ""),
    );
  }
  return lines.join("\n");
}

async function main() {
  const cwd = process.cwd();
  const names = ONLY ? [ONLY] : Object.keys(AGENTS);
  const results = [];
  for (const name of names) {
    const spec = AGENTS[name];
    if (!spec) {
      console.error(`unknown agent \`${name}\` (known: ${Object.keys(AGENTS).join(", ")})`);
      process.exitCode = 1;
      return;
    }
    if (spec.program !== "npx" && !installed(spec.program)) {
      results.push({ agent: name, launch: `${spec.program} ${spec.args.join(" ")}`, absent: true });
      continue;
    }
    const r = await probe(name, spec, cwd);
    r.cli = cliModelCount(spec);
    results.push(r);
  }

  if (AS_JSON) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log("ACP agent measurement");
  for (const r of results) {
    if (r.absent) {
      console.log(`\n## ${r.agent}  (${r.launch})\n  not installed on this machine, not measured`);
      continue;
    }
    console.log(report(r, r.cli));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
