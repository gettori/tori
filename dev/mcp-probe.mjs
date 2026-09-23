#!/usr/bin/env node
// Measure what a harness does with an MCP server Tori hands it, so the MCP
// server ticket is built from the wire rather than from the docs.
//
//   node dev/mcp-probe.mjs --self-check      # the probe's own server, no harness
//   node dev/mcp-probe.mjs --argv-check      # two --mcp-config files at once
//   node dev/mcp-probe.mjs --calibrate       # force a give-up at a known time
//   node dev/mcp-probe.mjs --scopes          # --mcp-config beside --settings, resume, .mcp.json, strict
//   node dev/mcp-probe.mjs --serve           # the stdio MCP server itself
//   node dev/mcp-probe.mjs --json            # machine-readable, any mode
//
// THREE QUESTIONS, ONE SERVER
//
// Tori needs to know whether `claude` honours `--mcp-config` beside the
// `--settings` it already injects, whether an ACP agent survives a populated
// `mcpServers`, and how long a tool call may block before a harness gives up.
// All three need the same artifact - a server with a tool that sleeps on demand
// - so they live in one script rather than three that each grow their own copy.
//
// WHY THE SERVER IS HAND-ROLLED
//
// MCP's stdio transport is newline-delimited JSON-RPC, which is what
// dev/acp-probe.mjs already speaks by hand. Pulling the SDK in would add a
// runtime dependency to the app's package.json to serve two tools in a dev
// script, and the wire is the thing being measured anyway.
//
// THE CALIBRATION IS NOT OPTIONAL. `--calibrate` forces a give-up at a time we
// chose (`MCP_TOOL_TIMEOUT` low, sleep high) and checks the probe reports it.
// Without that, a later run that reports "no ceiling" is indistinguishable from
// a probe that stopped reading, and "no ceiling" is the answer that decides
// whether Tori's `ask_user` may block. A check that cannot fail is not a check.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const CLAUDE = process.env.TORI_CLAUDE_BIN || join(process.env.HOME, ".local", "bin", "claude");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const val = (flag, fallback) => (has(flag) ? args[args.indexOf(flag) + 1] : fallback);
const AS_JSON = has("--json");

const SLEEP_TOOL = "tori_probe_sleep";
const PING_TOOL = "tori_probe_ping";

const TOOLS = [
  {
    name: PING_TOOL,
    description: "Answers at once. Proves the server is reachable and the tool result reaches the model.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: SLEEP_TOOL,
    description: "Blocks for the given number of milliseconds, then answers.",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number", description: "How long to block, in milliseconds." } },
      required: ["ms"],
      additionalProperties: false,
    },
  },
];

function serve(name) {
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const ok = (id, result) => write({ jsonrpc: "2.0", id, result });
  const text = (body) => ({ content: [{ type: "text", text: body }] });

  const handle = async (msg) => {
    switch (msg.method) {
      case "initialize":
        // Echo the client's own version back. The probe has no stake in which
        // date is negotiated, and agreeing means no support table to maintain
        // as harnesses move.
        return ok(msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name, version: "0.0.0" },
        });
      case "tools/list":
        return ok(msg.id, { tools: TOOLS });
      case "resources/list":
        return ok(msg.id, { resources: [] });
      case "prompts/list":
        return ok(msg.id, { prompts: [] });
      case "ping":
        return ok(msg.id, {});
      case "tools/call": {
        const tool = msg.params?.name;
        if (tool === PING_TOOL) return ok(msg.id, text(`pong from ${name}`));
        if (tool === SLEEP_TOOL) {
          const ms = Number(msg.params?.arguments?.ms ?? 0);
          const started = Date.now();
          await new Promise((r) => setTimeout(r, ms));
          return ok(msg.id, text(`slept ${Date.now() - started}ms (asked for ${ms}ms)`));
        }
        return write({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${tool}` } });
      }
      default:
        if (msg.id === undefined) return;
        return write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
    }
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
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
      // Deliberately not awaited: a sleeping `tools/call` must not stall the
      // frames behind it, which is the whole point of measuring a blocking call.
      handle(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

function serverSpec(name) {
  return { command: process.execPath, args: [SELF, "--serve", "--name", name] };
}

function openClient(name) {
  const spec = serverSpec(name);
  const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));
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
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return { call, stderrText: () => stderr, close: () => child.kill() };
}

async function timed(fn) {
  const started = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - started) };
}

async function selfCheck() {
  const client = openClient("toriprobe");
  try {
    const init = await timed(() =>
      client.call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-probe", version: "0.0.0" },
      }),
    );
    const list = await timed(() => client.call("tools/list", {}));
    const ping = await timed(() => client.call("tools/call", { name: PING_TOOL, arguments: {} }));
    const sleep = await timed(() => client.call("tools/call", { name: SLEEP_TOOL, arguments: { ms: 250 } }));
    return {
      mode: "self-check",
      serverInfo: init.result.serverInfo,
      protocolVersion: init.result.protocolVersion,
      tools: list.result.tools.map((t) => t.name),
      roundTripMs: { initialize: init.ms, "tools/list": list.ms, [PING_TOOL]: ping.ms, [SLEEP_TOOL]: sleep.ms },
      pingText: ping.result.content[0].text,
      sleepText: sleep.result.content[0].text,
      sleepHonoured: sleep.ms >= 250,
    };
  } finally {
    client.close();
  }
}

function buildArgv({ configs = [], extra = [] }) {
  return [
    "-p",
    // `--mcp-config` is variadic, so it eats every bare token after it. A flag
    // follows the configs here, and the prompt goes over stream-json stdin
    // rather than as a positional, so neither can be swallowed.
    ...(configs.length ? ["--mcp-config", ...configs] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...extra,
  ];
}

function openClaude({ cwd, argv, env = {} }) {
  const child = spawn(CLAUDE, argv, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const events = [];
  // Arrival time per frame, same index as `events`. Kept alongside rather than
  // stamped onto the frame, because these frames get printed and quoted into
  // the wiki, and a field the CLI never sent would read as one it did.
  const arrivals = [];
  const waiters = [];
  let buffer = "";
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        ev = { type: "__unparseable", raw: line };
      }
      events.push(ev);
      arrivals.push(performance.now());
      for (const w of waiters.slice()) {
        if (w.match(ev)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(ev);
        }
      }
    }
  });

  return {
    events,
    arrivals,
    stderrText: () => stderr,
    send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    sendTurn(text) {
      this.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    },
    waitFor(match, timeoutMs) {
      const seen = events.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          if (waiters.includes(w)) {
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error(`timed out after ${timeoutMs}ms; stderr: ${stderr.slice(-800)}`));
          }
        }, timeoutMs).unref?.();
      });
    },
    close: () => child.kill(),
  };
}

function writeConfig(dir, name) {
  const path = join(dir, `${name}.mcp.json`);
  writeFileSync(path, `${JSON.stringify({ mcpServers: { [name]: serverSpec(name) } }, null, 2)}\n`);
  return path;
}

const isInit = (ev) => ev.type === "system" && ev.subtype === "init";
const isResult = (ev) => ev.type === "result";

async function argvCheck() {
  const dir = mkdtempSync(join(tmpdir(), "tori-mcp-probe-"));
  const claude = openClaude({
    cwd: dir,
    argv: buildArgv({ configs: [writeConfig(dir, "probealpha"), writeConfig(dir, "probebeta")] }),
  });
  try {
    claude.sendTurn("Say the single word ok. Do not call any tool.");
    const init = await claude.waitFor(isInit, 120_000);
    return {
      mode: "argv-check",
      argv: buildArgv({ configs: ["<alpha>", "<beta>"] }).join(" "),
      mcpServers: init.mcp_servers ?? [],
      bothPresent: ["probealpha", "probebeta"].every((n) => (init.mcp_servers ?? []).some((s) => s.name === n)),
      probeTools: (init.tools ?? []).filter((t) => t.includes("tori_probe")),
    };
  } finally {
    claude.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function findToolOutcome({ events, arrivals }, toolName) {
  let callAt = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    for (const block of ev.message?.content ?? []) {
      if (callAt === null && block.type === "tool_use" && String(block.name ?? "").endsWith(toolName)) {
        callAt = arrivals[i];
      }
      if (callAt !== null && block.type === "tool_result") {
        const body = Array.isArray(block.content)
          ? block.content.map((c) => c.text ?? "").join("")
          : String(block.content ?? "");
        return {
          called: true,
          // A harness that abandons a call reports it as a failed tool result,
          // never as a frame kind of its own, so `is_error` is the give-up.
          isError: block.is_error === true,
          text: body.slice(0, 400),
          // Call to result, never turn to result: the limit under test is a
          // per-call wall clock, and a turn carries model thinking ahead of it.
          elapsedMs: Math.round(arrivals[i] - callAt),
        };
      }
    }
  }
  // Three outcomes, never two. A tool nobody called and a call nobody answered
  // both used to read as "the harness did not give up", which is the exact
  // claim a later "no ceiling at N" would rest on.
  if (callAt === null) {
    return { called: false, isError: false, text: "(the model never called the tool)", elapsedMs: null };
  }
  return { called: true, isError: false, text: "(called, but no tool_result arrived)", elapsedMs: null };
}

async function calibrate() {
  const timeoutMs = Number(val("--timeout", "10000"));
  const sleepMs = Number(val("--sleep", "30000"));
  const dir = mkdtempSync(join(tmpdir(), "tori-mcp-probe-"));
  const config = writeConfig(dir, "toriprobe");
  const namespaced = `mcp__toriprobe__${SLEEP_TOOL}`;
  const claude = openClaude({
    cwd: dir,
    argv: buildArgv({ configs: [config], extra: ["--allowedTools", namespaced] }),
    env: { MCP_TOOL_TIMEOUT: String(timeoutMs) },
  });
  try {
    // The turn goes first: `system/init` is emitted at turn open, so waiting
    // for it before sending anything deadlocks against a CLI waiting on stdin.
    claude.sendTurn(
      `Call the ${SLEEP_TOOL} tool with ms=${sleepMs}. Call it exactly once. Do not explain, do not say anything else.`,
    );
    const init = await claude.waitFor(isInit, 120_000);
    await claude.waitFor(isResult, sleepMs + 120_000);
    const outcome = findToolOutcome(claude, SLEEP_TOOL);
    return {
      mode: "calibrate",
      mcpToolTimeoutMs: timeoutMs,
      sleepMs,
      mcpServers: init.mcp_servers ?? [],
      toolOffered: (init.tools ?? []).includes(namespaced),
      outcome,
      toolCalled: outcome.called,
      // Both halves have to hold: a give-up landed, and it landed at the time we
      // chose rather than at the sleep's end. Otherwise a later "no ceiling" is
      // the probe's silence rather than a measurement.
      gaveUp: outcome.isError,
      gaveUpNearTimeout: outcome.isError && outcome.elapsedMs < sleepMs * 0.8,
    };
  } finally {
    claude.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const TORI_SETTINGS = join(process.env.HOME, ".config", "tori", "claude-hooks-settings.json");
const TORI_HOOKS_STATUS = join(process.env.HOME, ".config", "tori", "hooks-status");

const isProbe = (name) => /^(tori)?probe/.test(name);

// The operator's own connectors are named by `system/init` too, and this
// report gets quoted into a committed wiki. Probe rows are kept whole, every
// other row is reduced to a count by source and status.
function scrubServers(rows = []) {
  const others = {};
  for (const row of rows) {
    if (isProbe(row.name)) continue;
    const key = `${row.source ?? "?"}/${row.status ?? "?"}`;
    others[key] = (others[key] ?? 0) + 1;
  }
  return { probe: rows.filter((r) => isProbe(r.name)), others };
}

async function claudeTurn({ cwd, argv, prompt }) {
  const claude = openClaude({ cwd, argv });
  try {
    claude.sendTurn(prompt);
    const init = await claude.waitFor(isInit, 120_000);
    const result = await claude.waitFor(isResult, 180_000);
    return {
      sessionId: init.session_id,
      servers: scrubServers(init.mcp_servers),
      probeTools: (init.tools ?? []).filter((t) => t.includes("tori_probe")),
      result: result.subtype,
      ping: findToolOutcome(claude, PING_TOOL),
    };
  } finally {
    claude.close();
  }
}

function diffServers(before, after) {
  const index = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));
  const a = index(before.probe);
  const b = index(after.probe);
  const diff = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const was = a[name] ? `${a[name].source}/${a[name].status}` : "absent";
    const now = b[name] ? `${b[name].source}/${b[name].status}` : "absent";
    diff[name] = was === now ? was : `${was} -> ${now}`;
  }
  return { probe: diff, othersBefore: before.others, othersAfter: after.others };
}

async function scopes() {
  const dir = mkdtempSync(join(tmpdir(), "tori-mcp-probe-"));
  const project = mkdtempSync(join(tmpdir(), "tori-mcp-probe-project-"));
  const noCall = "Say the single word ok. Do not call any tool.";
  try {
    const config = writeConfig(dir, "toriprobe");
    const flags = ["--settings", TORI_SETTINGS];
    const namespaced = `mcp__toriprobe__${PING_TOOL}`;

    const fresh = await claudeTurn({
      cwd: dir,
      argv: buildArgv({ configs: [config], extra: [...flags, "--allowedTools", namespaced] }),
      prompt: `Call the ${PING_TOOL} tool exactly once, then say ok.`,
    });
    const statusFile = join(TORI_HOOKS_STATUS, `${fresh.sessionId}.json`);
    const hook = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, "utf8")) : null;

    const resumed = (extra) =>
      claudeTurn({ cwd: dir, argv: buildArgv({ extra: [...extra, "--resume", fresh.sessionId] }), prompt: noCall });
    const resumeWithFlags = await resumed(["--mcp-config", config, ...flags]);
    const resumeWithout = await resumed([]);

    // `.mcp.json` is written into a temp project, never the repo, and nothing
    // here approves it: the unapproved state is what the control measures.
    writeFileSync(
      join(project, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { probeproject: serverSpec("probeproject") } }, null, 2)}\n`,
    );
    const inProject = (configs, extra = []) =>
      claudeTurn({ cwd: project, argv: buildArgv({ configs, extra: [...flags, ...extra] }), prompt: noCall });
    const control = await inProject([]);
    const withConfig = await inProject([config]);
    const strictControl = await inProject([], ["--strict-mcp-config"]);
    const strictWithConfig = await inProject([config], ["--strict-mcp-config"]);

    return {
      mode: "scopes",
      fresh: {
        servers: fresh.servers,
        probeTools: fresh.probeTools,
        result: fresh.result,
        ping: fresh.ping,
        hookFired: hook !== null,
        hookLastEvent: hook?.event ?? null,
      },
      resumeWithFlags: { servers: resumeWithFlags.servers, probeTools: resumeWithFlags.probeTools },
      resumeWithout: { servers: resumeWithout.servers, probeTools: resumeWithout.probeTools },
      project: {
        control: control.servers,
        withConfig: withConfig.servers,
        diff: diffServers(control.servers, withConfig.servers),
      },
      strict: {
        control: strictControl.servers,
        withConfig: strictWithConfig.servers,
        diffFromDefault: diffServers(withConfig.servers, strictWithConfig.servers),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

function report(out) {
  if (AS_JSON) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const lines = [`mode: ${out.mode}`];
  for (const [key, value] of Object.entries(out)) {
    if (key === "mode") continue;
    lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }
  console.log(lines.join("\n"));
}

async function main() {
  if (has("--self-check")) return report(await selfCheck());
  if (has("--argv-check")) return report(await argvCheck());
  if (has("--calibrate")) return report(await calibrate());
  if (has("--scopes")) return report(await scopes());
  console.error("pick a mode: --self-check, --argv-check, --calibrate, --scopes, or --serve");
  process.exit(2);
}

// Dispatch sits last: `main` reads consts declared above it, and calling it
// from higher up the file hits their temporal dead zone.
if (has("--serve")) {
  serve(val("--name", "toriprobe"));
} else {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
