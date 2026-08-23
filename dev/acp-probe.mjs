#!/usr/bin/env node
// Measure what an ACP agent actually advertises, so an adapter and a capability
// tier can be written from the wire rather than from documentation.
//
//   node dev/acp-probe.mjs                     # every known agent that is installed
//   node dev/acp-probe.mjs --agent opencode    # one agent
//   node dev/acp-probe.mjs --json              # machine-readable, for a fixture
//   node dev/acp-probe.mjs --per-model         # does the option set follow the model?
//   node dev/acp-probe.mjs --reload            # can a session be loaded twice? (runs one real turn)
//   node dev/acp-probe.mjs --tool-call         # when do kind/locations/content arrive? (runs one real turn)
//
// THE --per-model QUESTION, and why it needs measuring rather than assuming
//
// An ACP agent publishes its options once, on `session/new`. A *draft* has no
// session, so it holds one cached set and shows it whatever model is picked. If
// an agent re-cuts its options per model (a plausible thing to do: picking a
// model can withdraw a thinking level) then that single cached set is wrong for
// every model but one, and the cache would have to key options per model row
// the way claude's already does.
//
// So this switches model *inside one session* and diffs the option set the
// agent answers with. `session/set_config_option` returns the whole set every
// time, which is what makes the diff possible without opening a session per
// model. Build the per-model cache only if the diff is non-empty; see
// [[lesson_probe_the_capability_before_building_its_control]].
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
import { existsSync } from "node:fs";
import { join } from "node:path";
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
const PER_MODEL = args.includes("--per-model");
const RELOAD = args.includes("--reload");
const TOOL_CALL = args.includes("--tool-call");
// How many models one run switches through. A cap, because a catalogue can be
// 15 rows and each switch is a round trip; whatever it skips is printed rather
// than silently dropped, so a "no variation" finding says how much it looked at.
const MODEL_CAP = 8;
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
  const frames = [];

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
        // Kept whole as well as by name: `--reload` counts what a second
        // `session/load` sends back, and a method name cannot say that.
        frames.push(msg);
      } else if (msg.method && msg.id !== undefined) {
        // An agent-to-client request. Nothing here serves fs or terminal, so
        // refuse rather than hang: an unanswered request stalls the agent.
        //
        // The one exception is the permission question under `--tool-call`.
        // Refusing it there would measure a *cancelled* call, which has no
        // lifecycle to speak of, so that scenario grants it - and only that
        // scenario, so every other run keeps refusing everything.
        const grant = TOOL_CALL && msg.method === "session/request_permission" && allowOption(msg.params);
        child.stdin.write(
          JSON.stringify(
            grant
              ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: grant } } }
              : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not served by this probe" } },
          ) + "\n",
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

    if (PER_MODEL) {
      out.perModel = await measurePerModel(call, session);
    }
    if (RELOAD) {
      out.reload = await measureReload(call, session, cwd, frames);
    }
    if (TOOL_CALL) {
      out.toolCall = await measureToolCall(call, session, frames);
    }
  } catch (e) {
    out.error = String(e.message ?? e);
    if (stderr.length) out.stderr = stderr.join("").slice(0, 600);
  } finally {
    child.kill("SIGKILL");
  }
  return out;
}

/**
 * THE RELOAD QUESTION: can a session hand its conversation over twice?
 *
 * Sway's webview reload leaves the agent process and the session alive, so the
 * transport rewires instead of spawning - and `session/load`, which is the only
 * way an ACP conversation ever reaches the UI, never runs again. The panel comes
 * back empty. Re-issuing `session/load` on the connection that already has that
 * session open would fix it for free, if an agent will do it.
 *
 * Nothing in the spec says whether that is a legal thing to ask, so this asks.
 * One turn to give the session something worth replaying, then a second
 * `session/load` for the same id on the same connection, counting the
 * `session/update` notifications it produces.
 *
 * Reading the result: `updatesAfterLoad` at or above `updatesDuringTurn` with
 * the same kinds means the conversation came back and the transport can simply
 * re-ask. Zero means the agent accepted the request and replayed nothing, which
 * is a refusal wearing a success, and Sway has to keep its own log instead.
 */
async function measureReload(call, session, cwd, frames) {
  const out = {};
  const before = frames.length;
  try {
    // Small on purpose: the question is whether the turn comes back at all,
    // not what it said.
    const prompt = await call("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Reply with the single word: ping." }],
    });
    out.stopReason = prompt?.stopReason ?? null;
  } catch (e) {
    out.promptError = String(e.message ?? e);
    return out;
  }
  out.updatesDuringTurn = frames.length - before;
  out.kindsDuringTurn = updateKinds(frames.slice(before));

  const mark = frames.length;
  try {
    // `mcpServers` is required, not optional: codex-acp 1.2.0 rejects the
    // request with an `Invalid params` schema error without it, which reads as
    // a refusal and is not one.
    const loaded = await call("session/load", { sessionId: session.sessionId, cwd, mcpServers: [] });
    out.loadResolved = true;
    out.loadReturnedConfigOptions = Array.isArray(loaded?.configOptions);
  } catch (e) {
    // An error here is the cleanest possible answer: the agent says no, and
    // Sway keeps its own log rather than guessing.
    out.loadError = String(e.message ?? e);
    return out;
  }
  // Read after the response resolves: ACP sends its updates before answering,
  // so anything the load replayed has already landed.
  out.updatesAfterLoad = frames.length - mark;
  out.kindsAfterLoad = updateKinds(frames.slice(mark));
  return out;
}

/**
 * Pick the "allow once" option out of a permission request, by **kind** rather
 * than by id: the spec names the kinds (`allow_once`, `allow_always`, and their
 * reject twins) while the ids are the agent's own strings.
 */
function allowOption(params) {
  const options = params?.options ?? [];
  const pick =
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => o.kind === "allow_always") ??
    options[0];
  return pick?.optionId ?? pick?.id ?? null;
}

/**
 * THE TOOL-CALL QUESTION: does a tool call arrive whole, or in instalments?
 *
 * Sway's cards are built from `kind` (which body renders), `locations` (which
 * paths the row lists) and `content` (what the body shows). ACP lets all three
 * arrive on the opening `tool_call` *or* on any later `tool_call_update`, and
 * the client cannot tell which agent does what without asking. If they arrive
 * late, an adapter that reads them only off the opening frame renders a
 * permanently empty card; if a completing update omits what it already sent,
 * an adapter that rebuilds state from the last frame loses it.
 *
 * So this runs one real turn that should provoke a tool call, then reports, per
 * field, the frame it first appeared on and whether it was still there at the
 * end. What is measured is one agent's behaviour, not the protocol's promise:
 * the answer belongs in [[concept_acp_agent_quirks]] beside the others.
 */
async function measureToolCall(call, session, frames) {
  const out = {};
  // The prompt names a file in the probe's own cwd. Run from a directory
  // without one, the agent finds nothing and makes no tool call, and the report
  // would read "this agent used no tool" - a measurement of the wrong thing.
  // Say so instead.
  const target = "README.md";
  if (!existsSync(join(process.cwd(), target))) {
    out.setupError = `no ${target} in ${process.cwd()}; run --tool-call from a directory that has one`;
    return out;
  }
  const before = frames.length;
  // Two turns, because one kind cannot answer both questions. The read is the
  // case that should carry all three fields: a `read` kind, a location, and the
  // file's content. The shell run is the only place an exit status could
  // possibly ride, and Sway's `ToolSummary::Execute` has a field waiting to
  // find out. An agent that reaches for the wrong tool is itself the finding,
  // and the report says which kind it actually got.
  const turns = [
    `Read the file ${target} in this directory and reply with just its first heading.`,
    "Run the shell command `false` and tell me only whether it succeeded.",
  ];
  out.stopReasons = [];
  for (const text of turns) {
    try {
      const prompt = await call("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text }],
      });
      out.stopReasons.push(prompt?.stopReason ?? null);
    } catch (e) {
      out.promptError = String(e.message ?? e);
      return out;
    }
  }

  // One entry per tool call, in the order its frames arrived.
  const calls = new Map();
  for (const f of frames.slice(before)) {
    const u = f?.params?.update;
    if (u?.sessionUpdate !== "tool_call" && u?.sessionUpdate !== "tool_call_update") continue;
    const id = u.toolCallId ?? "(no id)";
    if (!calls.has(id)) calls.set(id, []);
    calls.get(id).push(u);
  }

  out.calls = [...calls.entries()].map(([id, updates]) => {
    const row = { toolCallId: id, frames: [] };
    for (const u of updates) {
      row.frames.push({
        sessionUpdate: u.sessionUpdate,
        status: u.status ?? null,
        // `present` and not the values: a field that arrived empty is a
        // different finding from one that never arrived, and `content: []`
        // is a real answer an agent can send.
        fields: Object.keys(u)
          .filter((k) => k !== "sessionUpdate" && k !== "toolCallId" && u[k] !== undefined && u[k] !== null)
          .sort(),
      });
    }
    row.firstSeen = {};
    for (const field of ["kind", "title", "locations", "content", "status", "rawInput", "rawOutput"]) {
      const at = updates.findIndex((u) => u[field] !== undefined && u[field] !== null);
      row.firstSeen[field] =
        at === -1
          ? "never"
          : at === 0 && updates[0].sessionUpdate === "tool_call"
            ? "the opening tool_call"
            : `patch #${at} (${updates[at].sessionUpdate})`;
    }
    // Whether the LAST frame still carries each field. An adapter that
    // rebuilds a card from the completing update alone loses whatever this
    // says is gone by the end.
    const last = updates[updates.length - 1] ?? {};
    row.stillOnTheLastFrame = ["kind", "locations", "content", "rawOutput"].filter(
      (f) => last[f] !== undefined && last[f] !== null,
    );
    // The two values, not just their presence: `kind` is the vocabulary Sway
    // is about to adopt, and a location is only useful if it is a path the
    // editor can open. Both are short enough to print.
    const merged = Object.assign({}, ...updates);
    row.kindValue = merged.kind ?? null;
    row.locationValues = (merged.locations ?? []).map((l) => l?.path ?? JSON.stringify(l));
    // `rawOutput`'s KEYS, not its values. It is the agent's own JSON and Sway
    // reads nothing out of it today; what a summariser needs to know first is
    // whether there is a field to read at all - an exit status on an `execute`
    // above all, which is the one `ToolSummary::Execute` has been carrying an
    // empty slot for. Keys are a shape, values would be someone's file.
    row.rawOutputKeys = shapeOf(merged.rawOutput);
    return row;
  });
  return out;
}

/**
 * A value's SHAPE, two levels deep: key names and the type of what is under
 * them, never a value. `rawOutput` is the agent's own JSON and can hold a whole
 * file, so printing it would put someone's source in a report. Two levels is
 * enough to answer the question this was added for - whether an `execute` call
 * reports an exit status anywhere, top level or nested.
 */
function shapeOf(v, depth = 2) {
  if (v === undefined) return "never sent";
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v !== "object") return typeof v;
  if (depth === 0) return "object";
  const entries = Object.keys(v)
    .sort()
    .map((k) => `${k}: ${shapeOf(v[k], depth - 1)}`);
  return `{ ${entries.join(", ")} }`;
}

function toolCallReport(tc) {
  const lines = ["  tool call: do kind, locations and content arrive whole or by patch?"];
  if (tc.setupError) return [...lines, `    not measured: ${tc.setupError}`];
  if (tc.promptError) return [...lines, `    the turn never ran: ${tc.promptError}`];
  if (!tc.calls?.length) {
    return [
      ...lines,
      `    the turns produced NO tool call at all (stopReasons ${tc.stopReasons?.join(", ") || "none"}),`,
      "    so this run measured nothing; re-run with a prompt this agent will use a tool for.",
    ];
  }
  for (const c of tc.calls) {
    lines.push(`    ${c.toolCallId}: ${c.frames.length} frame(s)`);
    for (const [i, f] of c.frames.entries()) {
      lines.push(`      ${i}. ${f.sessionUpdate} status=${f.status ?? "none"} [${f.fields.join(", ") || "nothing"}]`);
    }
    for (const [field, when] of Object.entries(c.firstSeen)) {
      const value =
        field === "kind" && c.kindValue
          ? ` = ${c.kindValue}`
          : field === "locations" && c.locationValues.length
            ? ` = ${c.locationValues.join(", ")}`
            : "";
      lines.push(`      ${field}: ${when}${value}`);
    }
    lines.push(`      still on the last frame: ${c.stillOnTheLastFrame.join(", ") || "none of them"}`);
    lines.push(`      rawOutput: ${c.rawOutputKeys}`);
  }
  return lines;
}

function updateKinds(frames) {
  return [...new Set(frames.map((f) => f?.params?.update?.sessionUpdate).filter(Boolean))];
}

function reloadReport(rl) {
  const lines = ["  reload: can this session hand its conversation over twice?"];
  if (rl.promptError) return [...lines, `    the turn never ran: ${rl.promptError}`];
  lines.push(`    one turn produced ${rl.updatesDuringTurn} updates [${rl.kindsDuringTurn.join(", ") || "none"}]`);
  if (rl.loadError) {
    lines.push(`    a second session/load was REFUSED: ${rl.loadError}`);
    lines.push("    -> Sway must keep its own log; re-asking is not available.");
    return lines;
  }
  lines.push(`    a second session/load resolved, and replayed ${rl.updatesAfterLoad} updates` +
    ` [${rl.kindsAfterLoad.join(", ") || "none"}]`);
  lines.push(
    rl.updatesAfterLoad > 0
      ? "    -> the conversation comes back: the transport can re-ask on a rewire."
      : "    -> ACCEPTED AND REPLAYED NOTHING, which is a refusal wearing a success.",
  );
  return lines;
}

/**
 * Switch model inside one session and diff the option set that comes back.
 *
 * Found by **category**, never by id: `category` is the spec's word for what an
 * option is, and Codex calls its effort selector `reasoning_effort`. The same
 * rule `acp.rs` matches by.
 *
 * The agent answers `session/set_config_option` with its whole set, so one
 * session measures every model. A refusal is recorded rather than thrown: an
 * agent that will not take one of its own listed models is itself a finding.
 */
async function measurePerModel(call, session) {
  const options = session.configOptions ?? [];
  const selector = options.find((o) => o.category === "model" && o.type === "select");
  if (!selector) return { skipped: "this agent published no model selector" };
  const configId = selector.id ?? selector.configId;

  const flat = [];
  for (const entry of selector.options ?? []) {
    if (entry?.options) for (const sub of entry.options) flat.push(sub);
    else flat.push(entry);
  }
  const ids = flat.map((v) => v.id ?? v.value).filter(Boolean);
  const tried = ids.slice(0, MODEL_CAP);

  const sets = [];
  for (const model of tried) {
    try {
      // A bare string, not a tagged `{ type: "value", valueId }`. Measured:
      // OpenCode 1.18.3 answers the tagged form with `expected string, received
      // object`, which is the v1 request shape asserting itself.
      const answer = await call("session/set_config_option", {
        sessionId: session.sessionId,
        configId,
        value: model,
      });
      sets.push({ model, options: (answer?.configOptions ?? []).map(describeOption) });
    } catch (e) {
      sets.push({ model, error: String(e.message ?? e) });
    }
  }

  return {
    configId,
    total: ids.length,
    tried: tried.length,
    skipped: ids.slice(MODEL_CAP),
    sets,
    diffs: diffAgainstFirst(sets),
  };
}

/**
 * What moved between the first answering set and each later one.
 *
 * The model selector itself is excluded from the comparison: its `currentValue`
 * moves on every switch by definition, and reporting that as variation would
 * make every agent look like it re-cuts its options.
 */
function diffAgainstFirst(sets) {
  const answered = sets.filter((s) => s.options);
  if (answered.length < 2) return null;
  const key = (o) => `${o.configId}[${o.category ?? "none"}/${o.type}]`;
  const shape = (set) => {
    const out = new Map();
    for (const o of set.options) {
      if (o.category === "model") continue;
      out.set(key(o), o.type === "select" ? (o.ids ?? []).join(",") : String(o.value));
    }
    return out;
  };

  const base = shape(answered[0]);
  const diffs = [];
  for (const set of answered.slice(1)) {
    const mine = shape(set);
    const moved = [];
    for (const [k, v] of base) {
      if (!mine.has(k)) moved.push(`${k}: gone`);
      else if (mine.get(k) !== v) moved.push(`${k}: ${v} -> ${mine.get(k)}`);
    }
    for (const k of mine.keys()) if (!base.has(k)) moved.push(`${k}: new`);
    if (moved.length) diffs.push({ from: answered[0].model, to: set.model, moved });
  }
  return diffs;
}

/** One config option, reduced to what a tier or a model picker needs. */
function describeOption(o) {
  const d = {
    // **The v1 schema is asymmetric.** An option announcement carries `id`, its
    // entries carry `value`, and only the *request* uses `configId`. Reading
    // `configId` here printed `undefined` for every option OpenCode sent.
    configId: o.id ?? o.configId,
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

/** The per-model finding, in the words a plan can be decided from. */
function perModelReport(pm) {
  const lines = ["  per-model option sets:"];
  if (pm.skipped && !Array.isArray(pm.skipped)) {
    lines.push(`    ${pm.skipped}`);
    return lines;
  }
  lines.push(`    switching \`${pm.configId}\` through ${pm.tried} of ${pm.total} models`);
  if (pm.skipped.length) lines.push(`    not switched to: ${pm.skipped.join(", ")}`);
  for (const s of pm.sets) {
    if (s.error) lines.push(`    ${s.model}: REFUSED ${s.error}`);
  }
  if (pm.diffs === null) {
    // Nothing answered, so nothing was compared. Reporting "does not vary" here
    // would read a probe failure as a measurement.
    lines.push(`    INCONCLUSIVE: fewer than two switches answered, nothing to diff`);
  } else if (!pm.diffs.length) {
    lines.push(`    DOES NOT VARY: every model answered the same set (model selector aside)`);
  } else {
    lines.push(`    VARIES:`);
    for (const d of pm.diffs) {
      lines.push(`      ${d.from} -> ${d.to}`);
      for (const m of d.moved) lines.push(`        ${m}`);
    }
  }
  return lines;
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
  if (r.perModel) lines.push(...perModelReport(r.perModel));
  if (r.reload) lines.push(...reloadReport(r.reload));
  if (r.toolCall) lines.push(...toolCallReport(r.toolCall));
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
