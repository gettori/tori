#!/usr/bin/env node
// Measure what a harness does with an MCP server Tori hands it, so the MCP
// server ticket is built from the wire rather than from the docs.
//
//   node dev/mcp-probe.mjs --self-check      # the probe's own server, no harness
//   node dev/mcp-probe.mjs --argv-check      # two --mcp-config files at once
//   node dev/mcp-probe.mjs --calibrate       # force a give-up at a known time
//   node dev/mcp-probe.mjs --scopes          # --mcp-config beside --settings, resume, .mcp.json, strict
//   node dev/mcp-probe.mjs --acp             # empty then populated mcpServers, per ACP agent (--agent to pick one)
//   node dev/mcp-probe.mjs --ceiling         # one long call, timed from the harness's own frames
//       --sleep <ms>                         #   how long the tool blocks
//       --server-timeout <ms>                #   claude's per-server `timeout` key in the config
//       --progress <ms>                      #   emit progress this often, if the harness sent a token
//       --env KEY=VALUE                      #   any env override, repeatable
//       --harness codex-acp                  #   time the call through an ACP bridge instead
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
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      properties: {
        ms: { type: "number", description: "How long to block, in milliseconds." },
        progressEveryMs: { type: "number", description: "Send a progress notification this often while blocked." },
      },
      required: ["ms"],
      additionalProperties: false,
    },
  },
];

function serve(name, mark) {
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const ok = (id, result) => write({ jsonrpc: "2.0", id, result });
  const text = (body) => ({ content: [{ type: "text", text: body }] });

  const handle = async (msg) => {
    if (mark && msg.method) {
      const token = msg.params?._meta?.progressToken !== undefined ? " progressToken" : "";
      appendFileSync(mark, `${msg.method}${token}\n`);
    }
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
        if (tool === PING_TOOL) {
          if (mark) for (const key of Object.keys(ACP_ENV)) appendFileSync(mark, `env ${key}=${process.env[key] ?? ""}\n`);
          return ok(msg.id, text(`pong from ${name}`));
        }
        if (tool === SLEEP_TOOL) {
          const ms = Number(msg.params?.arguments?.ms ?? 0);
          const every = Number(msg.params?.arguments?.progressEveryMs ?? 0);
          const progressToken = msg.params?._meta?.progressToken;
          const started = Date.now();
          let sent = 0;
          // Progress needs a token from the client. Without one the spec forbids
          // sending it, so a run asking for progress from a harness that never
          // offers a token measures plain silence, and the mark log says so.
          const ticker =
            every > 0 && progressToken !== undefined
              ? setInterval(() => {
                  sent++;
                  write({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: sent } });
                }, every)
              : null;
          await new Promise((r) => setTimeout(r, ms));
          if (ticker) clearInterval(ticker);
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

function serverSpec(name, mark) {
  return { command: process.execPath, args: [SELF, "--serve", "--name", name, ...(mark ? ["--mark", mark] : [])] };
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

function writeConfig(dir, name, { timeout, mark } = {}) {
  const path = join(dir, `${name}.mcp.json`);
  const server = { ...serverSpec(name, mark), ...(timeout !== undefined ? { timeout } : {}) };
  writeFileSync(path, `${JSON.stringify({ mcpServers: { [name]: server } }, null, 2)}\n`);
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

// The chat launch lines from `codex.toml`, `pi.toml` and `opencode.toml`, pinned
// the same way where the TOML pins, so a result here is a result for the bridge
// Tori actually spawns. `TORI_OPENCODE_BIN` for an opencode off PATH.
const ACP_AGENTS = {
  "codex-acp": { program: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.12.0"] },
  "pi-acp": { program: "npx", args: ["-y", "pi-acp@0.0.33"] },
  opencode: { program: process.env.TORI_OPENCODE_BIN || "opencode", args: ["acp"] },
};

function openAcp(spec, cwd) {
  const child = spawn(spec.program, spec.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const frames = [];
  const arrivals = [];
  const permissions = [];
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
      if (msg.method && msg.id === undefined) arrivals.push(performance.now());
      if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
        else waiter.resolve(msg.result);
      } else if (msg.method && msg.id === undefined) {
        frames.push(msg);
      } else if (msg.method) {
        // Granted, because a refused permission measures a cancelled call
        // rather than whether the tool was reachable. Everything else, fs and
        // terminal included, is refused so the agent never stalls on us.
        if (msg.method === "session/request_permission") permissions.push(msg.params?.toolCall?.title ?? null);
        const grant = msg.method === "session/request_permission" && allowOption(msg.params);
        child.stdin.write(
          `${JSON.stringify(
            grant
              ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: grant } } }
              : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not served by this probe" } },
          )}\n`,
        );
      }
    }
  });

  const call = (method, params, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs).unref?.();
    });

  return { call, frames, arrivals, permissions, stderrText: () => stderr, close: () => child.kill("SIGKILL") };
}

function allowOption(params) {
  const options = params?.options ?? [];
  const pick =
    options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always") ?? options[0];
  return pick?.optionId ?? null;
}

// The names Tori will send, with values no parent environment carries, so an
// inherited TORI_SOCK from a Tori terminal cannot pass for a delivered one.
const ACP_ENV = { TORI_SOCK: `probe-sock-${process.pid}`, TORI_CALLER: `probe-caller-${process.pid}` };

// ACP's stdio server shape: `env` is a required array of pairs, not a map.
function acpServer(name, mark) {
  const spec = serverSpec(name, mark);
  return { name, command: spec.command, args: spec.args, env: Object.entries(ACP_ENV).map(([n, value]) => ({ name: n, value })) };
}

// One process per attempt, so the populated run cannot inherit anything the
// empty run negotiated, and a crash in one leaves the other readable.
async function acpAttempt(spec, cwd, mcpServers, withTurn) {
  const acp = openAcp(spec, cwd);
  const out = {};
  try {
    const init = await acp.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    out.mcpCapabilities = init.agentCapabilities?.mcpCapabilities ?? null;
    let session;
    try {
      session = await acp.call("session/new", { cwd, mcpServers });
      out.sessionNew = "ok";
    } catch (e) {
      out.sessionNew = e.rpc ? `refused: ${e.rpc.code} ${e.rpc.message}` : `failed: ${e.message}`;
      out.stderr = acp.stderrText().slice(-400);
      return out;
    }
    if (!withTurn) return out;
    const prompt = await acp.call(
      "session/prompt",
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: `Call the ${PING_TOOL} tool exactly once, then reply with what it returned.` }],
      },
      240_000,
    );
    out.stopReason = prompt?.stopReason ?? null;
    const calls = new Map();
    for (const f of acp.frames) {
      const u = f.params?.update;
      if (u?.sessionUpdate !== "tool_call" && u?.sessionUpdate !== "tool_call_update") continue;
      calls.set(u.toolCallId, { ...calls.get(u.toolCallId), ...u });
    }
    const probeCalls = [...calls.values()].filter((c) => String(c.title ?? "").includes(PING_TOOL));
    out.toolCall = probeCalls.length
      ? probeCalls.map((c) => ({ title: c.title ?? null, status: c.status ?? null, pong: JSON.stringify(c).includes("pong from") }))
      : "(the turn completed without calling the tool)";
    out.otherToolCalls = calls.size - probeCalls.length;
    out.permissionRequests = acp.permissions;
    out.reply = acp.frames
      .filter((f) => f.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((f) => f.params.update.content?.text ?? "")
      .join("")
      .slice(-300);
  } catch (e) {
    out.error = e.rpc ? `${e.rpc.code} ${e.rpc.message}` : e.message;
    out.stderr = acp.stderrText().slice(-400);
  } finally {
    acp.close();
  }
  return out;
}

async function acpServers() {
  const only = val("--agent", null);
  const results = {};
  for (const [name, spec] of Object.entries(ACP_AGENTS)) {
    if (only && only !== name) continue;
    const dir = mkdtempSync(join(tmpdir(), "tori-mcp-probe-"));
    try {
      const empty = await acpAttempt(spec, dir, [], false);
      // The server logs every method it receives, so "the agent never started
      // it" and "it started but the model never called it" read differently.
      const mark = join(dir, "server-methods.log");
      // Only a populated attempt whose empty twin succeeded says anything about
      // MCP. Otherwise the refusal is auth or the bridge, and is reported as such.
      const populated =
        empty.sessionNew === "ok" ? await acpAttempt(spec, dir, [acpServer("toriprobe", mark)], true) : null;
      const serverSaw = readMark(mark);
      const answers = {
        serverStarted: serverSaw.includes("initialize"),
        toolCalled: serverSaw.some((m) => m.startsWith("tools/call")),
        envArrived: Object.entries(ACP_ENV).every(([k, v]) => serverSaw.includes(`env ${k}=${v}`)),
        permissionForMcpCall: (populated?.permissionRequests ?? []).some((t) => String(t).includes(PING_TOOL)),
      };
      results[name] = { answers, empty, populated, serverSaw };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { mode: "acp", ...results };
}

const readMark = (mark) =>
  existsSync(mark) ? [...new Set(readFileSync(mark, "utf8").split("\n").filter(Boolean))] : [];

async function ceiling() {
  const sleepMs = Number(val("--sleep", "60000"));
  const progressEveryMs = Number(val("--progress", "0"));
  const harness = val("--harness", "claude");
  const env = Object.fromEntries(
    args.flatMap((a, i) => (a === "--env" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [])),
  );
  const dir = mkdtempSync(join(tmpdir(), "tori-mcp-probe-"));
  const mark = join(dir, "server-methods.log");
  const toolArgs = { ms: sleepMs, ...(progressEveryMs ? { progressEveryMs } : {}) };
  const prompt = `Call the ${SLEEP_TOOL} tool exactly once with arguments ${JSON.stringify(toolArgs)}. Do not explain, do not say anything else.`;
  const base = { mode: "ceiling", harness, sleepMs, progressEveryMs, env };
  try {
    if (harness !== "claude") {
      return { ...base, ...(await acpCeiling(ACP_AGENTS[harness], dir, mark, prompt, sleepMs)), serverSaw: readMark(mark) };
    }
    const serverTimeout = has("--server-timeout") ? Number(val("--server-timeout")) : undefined;
    const config = writeConfig(dir, "toriprobe", { timeout: serverTimeout, mark });
    const claude = openClaude({
      cwd: dir,
      argv: buildArgv({ configs: [config], extra: ["--allowedTools", `mcp__toriprobe__${SLEEP_TOOL}`] }),
      env,
    });
    try {
      claude.sendTurn(prompt);
      await claude.waitFor(isInit, 120_000);
      await claude.waitFor(isResult, sleepMs + 180_000);
      return { ...base, serverTimeout: serverTimeout ?? null, outcome: findToolOutcome(claude, SLEEP_TOOL), serverSaw: readMark(mark) };
    } finally {
      claude.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function acpCeiling(spec, dir, mark, text, sleepMs) {
  const acp = openAcp(spec, dir);
  try {
    await acp.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const session = await acp.call("session/new", { cwd: dir, mcpServers: [acpServer("toriprobe", mark)] });
    const prompt = await acp.call(
      "session/prompt",
      { sessionId: session.sessionId, prompt: [{ type: "text", text }] },
      sleepMs + 240_000,
    );
    let startedAt = null;
    let callId = null;
    let last = null;
    for (let i = 0; i < acp.frames.length; i++) {
      const u = acp.frames[i].params?.update;
      if (u?.sessionUpdate !== "tool_call" && u?.sessionUpdate !== "tool_call_update") continue;
      // codex names the tool in its Guardian Review call's title as well, so the
      // call is picked by the title's suffix and then followed by its own id.
      if (callId === null && String(u.title ?? "").endsWith(SLEEP_TOOL)) {
        callId = u.toolCallId;
        startedAt = acp.arrivals[i];
      }
      if (u.toolCallId === callId && (u.status === "completed" || u.status === "failed")) {
        last = { status: u.status, frame: JSON.stringify(u).slice(0, 600), elapsedMs: Math.round(acp.arrivals[i] - startedAt) };
      }
    }
    return {
      stopReason: prompt?.stopReason ?? null,
      outcome: startedAt === null ? "(the model never called the tool)" : last ?? "(called, but no terminal status arrived)",
    };
  } finally {
    acp.close();
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
  if (has("--acp")) return report(await acpServers());
  if (has("--ceiling")) return report(await ceiling());
  console.error("pick a mode: --self-check, --argv-check, --calibrate, --scopes, --acp, --ceiling, or --serve");
  process.exit(2);
}

// Dispatch sits last: `main` reads consts declared above it, and calling it
// from higher up the file hits their temporal dead zone.
if (has("--serve")) {
  serve(val("--name", "toriprobe"), val("--mark", null));
} else {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
