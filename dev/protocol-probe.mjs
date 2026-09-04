#!/usr/bin/env node
// Regenerate (and re-verify) the captured `claude` stream-json corpus in
// dev/fixtures/claude/.
//
// Everything the chat transport is built on is a *measurement* of this CLI's
// wire format, not a documented contract, so the corpus is the contract and
// this script is how we re-take the measurement. A CLI upgrade that changes the
// wire format has to fail loudly here rather than silently degrade the chat
// panel months later.
//
//   node dev/protocol-probe.mjs            # re-verify the committed fixtures
//   node dev/protocol-probe.mjs --write    # re-capture them
//   node dev/protocol-probe.mjs --only two-turns --write
//
// WHAT IS COMPARED, and why it is not a linear event sequence.
//
// The obvious check - record the ordered list of event kinds and diff it - was
// built first and measured, and it does not work, because a `claude` run mixes
// two things that look alike in the stream and are not alike at all:
//
//   * the CLI's **wire format**, which we depend on and which must not change
//     under us: which frame types exist, what discriminants they carry, and the
//     nesting rules the stream obeys.
//   * the **model's discretion**, which is supposed to vary: whether it emits a
//     thinking block before a tool call (the same `bash-call` prompt produced a
//     thinking block on one run and none on the next), how many text deltas it
//     takes, when an out-of-band notification lands.
//
// Measured flapping on identical repeated runs: `rate_limit_event` landed at
// index 2 of 11 twice and index 9 of 11 once; `system/hook_response` and
// `user/tool_result` traded places with `message_delta`/`message_stop`; the
// thinking block appeared and vanished. A sequence diff fails on all of that,
// which does not mean the CLI broke - it means the check is measuring the wrong
// thing, and a check that cries wolf every run is a check nobody reads.
//
// So the contract is pinned as two things that are genuinely the CLI's:
//
//   1. **Vocabulary** (in the fixture). The *set* of frame kinds a scenario
//      produces. A renamed, added or removed frame type fails loudly, which is
//      exactly the CLI-upgrade breakage this exists to catch. Kinds the model
//      may choose not to emit are recorded as `optional` so their absence is
//      not an error - but an unrecognised kind is always an error, so a rename
//      still fails via its new name.
//   2. **Grammar** (asserted in code, not stored). The ordering the protocol
//      really does guarantee: messages open and close in order, content blocks
//      nest inside them, deltas fall inside an open block, and each turn's
//      `system/init` precedes its first stream frame. This is where a genuine
//      restructuring gets caught, and it holds regardless of what the model
//      chose to say.
//
// Plus each scenario declares the kinds that are its whole point (`requires`),
// so "optional" can never quietly hollow the corpus out into a check that
// passes on an empty stream.
//
// NOT THE ONLY MEASUREMENT OF THIS CLI. `dev/effort-probe.mjs` pins what
// `--effort` accepts, which is a flag's vocabulary rather than a wire format and
// so has no stream to record here. A version bump wants both re-run.
//
// Isolation: the probe passes `--setting-sources ''` so the operator's own
// hooks and permissions cannot leak into a committed fixture and make it
// machine-specific. That flag is a PROBE-ONLY choice and must never reach the
// product - shipping it would silently disable the user's own hooks, config and
// permissions (see the plan's decisions). The hook scenario proves `--settings`
// still injects with sources stripped.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIXTURES = join(ROOT, "dev", "fixtures", "claude");
const CLAUDE = process.env.SWAY_CLAUDE_BIN || join(process.env.HOME, ".local", "bin", "claude");
const TURN_TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

// The discriminant tuple that identifies a frame's *shape*. Everything variable
// (text, ids, timings, usage) is deliberately excluded.
export function eventKind(ev) {
  switch (ev?.type) {
    case "system":
      return `system/${ev.subtype}`;
    case "stream_event": {
      const e = ev.event ?? {};
      if (e.type === "content_block_start") return `stream_event/content_block_start/${e.content_block?.type}`;
      if (e.type === "content_block_delta") return `stream_event/content_block_delta/${e.delta?.type}`;
      return `stream_event/${e.type}`;
    }
    case "assistant":
    case "user": {
      const content = ev.message?.content;
      const types = Array.isArray(content) ? [...new Set(content.map((c) => c.type))].sort() : ["text"];
      return `${ev.type}/${types.join("+") || "empty"}`;
    }
    case "control_response":
      return `control_response/${ev.response?.subtype}`;
    case "control_request":
      return `control_request/${ev.request?.subtype}`;
    case "result":
      return `result/${ev.subtype}`;
    default:
      return ev?.type ?? "unknown";
  }
}

// Kinds the model or the CLI may legitimately omit on an otherwise identical
// run, measured rather than assumed (see the header). Their *absence* is not a
// failure; an unrecognised kind still is, so a rename fails via its new name.
const DISCRETIONARY = new Set([
  // The model chooses whether to think before acting.
  "stream_event/content_block_start/thinking",
  "stream_event/content_block_delta/thinking_delta",
  "stream_event/content_block_delta/signature_delta",
  "assistant/thinking",
  "system/thinking_tokens",
  // Delivered on the CLI's own schedule, not as a step in the turn.
  "rate_limit_event",
  // A subagent that finishes fast enough emits no progress at all: measured,
  // it is a heartbeat on the CLI's clock and not a step in the task's life.
  // `task_started` and `task_notification` are the steps and stay required.
  "system/task_progress",
]);

// The scenario's whole point, asserted every run. Without these, marking the
// discretionary kinds optional could let a scenario degrade to an empty stream
// and still pass.
const REQUIRES = {
  "plain-turn": ["assistant/text", "result/success"],
  "two-turns": ["system/init", "assistant/text", "result/success"],
  // Both halves: what the protocol serves, and what it refuses. Losing the
  // error would mean the mid-session-switch finding stopped being measured.
  initialize: ["control_response/success", "control_response/error"],
  "bash-call": ["assistant/tool_use", "user/tool_result", "result/success"],
  "edit-call": ["assistant/tool_use", "user/tool_result", "result/success"],
  // The result-shape corpus. The frame kinds are the same three every tool
  // call produces; what these four are really for is the `tool_use_result`
  // payload riding inside `user/tool_result`, which a vocabulary cannot see.
  // Each scenario asserts its own tool actually ran, so a capture in which the
  // model reached for something else fails instead of being committed.
  "read-call": ["assistant/tool_use", "user/tool_result", "result/success"],
  "glob-call": ["assistant/tool_use", "user/tool_result", "result/success"],
  "grep-modes": ["assistant/tool_use", "user/tool_result", "result/success"],
  "webfetch-call": ["assistant/tool_use", "user/tool_result", "result/success"],
  // The cancelled turn's own result, plus a clean one after it: together they
  // prove the interrupt landed and the child survived it.
  interrupt: ["result/error_during_execution", "result/success"],
  "hook-denied": ["system/hook_started", "system/hook_response", "user/tool_result"],
  // The inbound question is the point of all four; without it they would pass
  // by measuring a turn in which nothing was ever asked.
  "permission-coverage": ["control_request/can_use_tool", "assistant/tool_use", "result/success"],
  "permission-subagent": ["control_request/can_use_tool", "assistant/tool_use", "result/success"],
  // The lifecycle channel, which is the only thing that names a subagent, joins
  // its `task_id` to the `Agent` call's `tool_use_id`, and says when it ended.
  // `task_notification` is required here and nowhere else: this is the scenario
  // whose whole point is that it lands *after* the parent's turn.
  "subagent-background": ["system/task_started", "system/task_notification", "result/success"],
  // The same lifecycle channel a subagent uses, carrying something that is not
  // one. Without this the `task_*` frames look like they only ever describe
  // subagents, which is what put a shell task on the lane strip.
  "background-shell": ["system/task_started", "system/task_notification", "result/success"],
  "subagent-parallel": ["system/task_started", "assistant/tool_use", "result/success"],
  "permission-grant": ["control_request/can_use_tool", "assistant/tool_use", "result/success"],
  // The hook must run *and* the harness must still ask, so both halves are
  // required: a run with only one of them measured the wrong thing.
  "hook-matcher": [
    "system/hook_started",
    "system/hook_response",
    "control_request/can_use_tool",
    "assistant/tool_use",
    "result/success",
  ],
  // No `result`: the whole finding is that the turn never completes, because
  // nobody answered and the CLI will not answer for us.
  "permission-deadline": ["control_request/can_use_tool"],
  // The question must be asked *and* answered: without the `tool_result` the
  // scenario would pass while measuring nothing about the answer channel.
  "ask-user-question": [
    "control_request/can_use_tool",
    "assistant/tool_use",
    "user/tool_result",
    "result/success",
  ],
  // The compaction channel, which is two frames the CLI reports on its own:
  // `system/status` carries `status: "compacting"` when it starts and, when it
  // ends, `compact_result` plus a `compact_error` on failure. Without the
  // boundary this would pass on a run where the CLI declined to compact.
  compaction: ["system/status", "system/compact_boundary", "result/success"],
  "image-turn": ["assistant/text", "result/success"],
  // A set cannot say "twice", so this only pins that both turns' shapes are
  // here at all; that there are two inits is asserted in the scenario body.
  "fast-mode": ["system/init", "assistant/text", "result/success"],
};

// Scenarios whose stream is cut mid-turn on purpose, so the two "still open at
// the end" checks do not apply to them. Named per scenario rather than relaxed
// globally: a dangling block is a real defect everywhere else, and this is the
// one place it is the finding rather than the fault.
const TRUNCATED_BY_DESIGN = new Set(["permission-deadline"]);

const DANGLING = ["stream ended with a message still open", "stream ended with a content block still open"];

// The frame kinds a run produced, deduplicated and sorted. Order is deliberately
// discarded here; what the protocol really orders is asserted by checkGrammar.
export function vocabulary(events) {
  return [...new Set(events.map(eventKind))].sort();
}

// The ordering the stream protocol does guarantee, independent of anything the
// model chose to say. Returns a list of violations, empty when the stream is
// well formed.
//
// One measured exception, found by this check rather than assumed: an
// **interrupted turn truncates the stream**. The `interrupt` scenario's first
// turn ends with `result` of subtype `error_during_execution` (`is_error:
// true`) while a message and a content block are still open - no
// `content_block_stop`, no `message_stop`, ever. So a turn that ends in error
// is allowed to leave them dangling and simply resets the state. This is a real
// obligation on the consumer, not a quirk to shrug at: `chatStore` must close
// its own dangling blocks when a turn ends in error, because the CLI never
// will.
export function checkGrammar(events) {
  const problems = [];
  let inMessage = false;
  let blockOpen = false;
  let turn = 0;
  let sawInitThisTurn = false;
  let sawStreamThisTurn = false;

  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "init") {
      if (sawStreamThisTurn) problems.push(`turn ${turn}: system/init arrived after the turn's first stream frame`);
      sawInitThisTurn = true;
      continue;
    }
    if (ev.type === "result") {
      // An interrupted or errored turn is truncated by design (see above), so
      // only a turn that ended cleanly owes us a closed message.
      if (inMessage && !ev.is_error) problems.push(`turn ${turn}: clean result arrived with a message still open`);
      if (!sawInitThisTurn) problems.push(`turn ${turn}: no system/init before the turn's result`);
      turn++;
      inMessage = false;
      blockOpen = false;
      sawInitThisTurn = false;
      sawStreamThisTurn = false;
      continue;
    }
    if (ev.type !== "stream_event") continue;
    sawStreamThisTurn = true;
    const e = ev.event ?? {};
    switch (e.type) {
      case "message_start":
        if (inMessage) problems.push(`turn ${turn}: message_start inside an open message`);
        inMessage = true;
        break;
      case "message_stop":
        if (!inMessage) problems.push(`turn ${turn}: message_stop with no open message`);
        if (blockOpen) problems.push(`turn ${turn}: message_stop with a content block still open`);
        inMessage = false;
        break;
      case "message_delta":
        if (!inMessage) problems.push(`turn ${turn}: message_delta outside a message`);
        break;
      case "content_block_start":
        if (!inMessage) problems.push(`turn ${turn}: content_block_start outside a message`);
        if (blockOpen) problems.push(`turn ${turn}: content_block_start inside an open block`);
        blockOpen = true;
        break;
      case "content_block_delta":
        if (!blockOpen) problems.push(`turn ${turn}: content_block_delta outside an open block`);
        break;
      case "content_block_stop":
        if (!blockOpen) problems.push(`turn ${turn}: content_block_stop with no open block`);
        blockOpen = false;
        break;
    }
  }
  if (inMessage) problems.push("stream ended with a message still open");
  if (blockOpen) problems.push("stream ended with a content block still open");
  return problems;
}

// ---------------------------------------------------------------------------
// Driving one long-lived child
// ---------------------------------------------------------------------------

// One `claude` child with stdin held open for its whole life. Closing stdin is
// what made earlier one-shot probes exit after a single turn; the CLI itself is
// happy to run many.
class Probe {
  // `answerPermission` opts this child into the in-protocol permission path: it
  // is called with each `can_use_tool` control_request and returns the response
  // payload to send, or null to deliberately leave the question unanswered
  // (which is how the deadline is measured). Callers must also pass
  // `--permission-prompt-tool stdio`, since without it the CLI never asks.
  constructor({ cwd, extraArgs = [], settings = null, answerPermission = null }) {
    this.events = [];
    this.buf = "";
    this.waiters = [];
    this.answerPermission = answerPermission;
    // Every `can_use_tool` seen, in order, so a scenario can assert *which*
    // tools asked rather than only how many did.
    this.permissionRequests = [];
    const argv = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--setting-sources",
      "",
      ...(settings ? ["--settings", JSON.stringify(settings)] : []),
      ...extraArgs,
    ];
    this.child = spawn(CLAUDE, argv, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = "";
    this.child.stderr.on("data", (d) => (this.stderr += d.toString()));
    this.child.stdout.on("data", (d) => this.#ingest(d.toString()));
    this.exited = new Promise((r) => this.child.on("exit", (code) => r(code)));
  }

  #ingest(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        // Unparseable stdout is itself a finding, so it is recorded rather than
        // dropped; the fixture will show it and the comparison will fail.
        ev = { type: "__unparseable", raw: line };
      }
      this.events.push(ev);
      if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
        this.permissionRequests.push(ev.request);
        const response = this.answerPermission?.(ev.request, this.permissionRequests.length);
        if (response) {
          this.send({
            type: "control_response",
            response: { subtype: "success", request_id: ev.request_id, response },
          });
        }
      }
      for (const w of this.waiters.slice()) {
        if (w.match(ev)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(ev);
        }
      }
    }
  }

  send(obj) {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  sendTurn(content) {
    this.send({
      type: "user",
      message: { role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content },
    });
  }

  waitFor(match, timeoutMs = TURN_TIMEOUT_MS) {
    // Late-match against frames that already arrived, or the wait can miss a
    // result that landed between two awaits.
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        if (this.waiters.includes(w)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new Error(`timed out after ${timeoutMs}ms; stderr: ${this.stderr.slice(-800)}`));
        }
      }, timeoutMs).unref?.();
    });
  }

  waitForResult() {
    const before = this.events.filter((e) => e.type === "result").length;
    return new Promise((resolve, reject) => {
      const tick = setInterval(() => {
        const now = this.events.filter((e) => e.type === "result");
        if (now.length > before) {
          clearInterval(tick);
          resolve(now[now.length - 1]);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(tick);
        reject(new Error(`turn did not complete in ${TURN_TIMEOUT_MS}ms; stderr: ${this.stderr.slice(-800)}`));
      }, TURN_TIMEOUT_MS).unref?.();
    });
  }

  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    await this.exited;
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A small solid-blue PNG, built here so the image fixture needs no binary
// asset in the repo and no image library.
function bluePng(size = 32) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = 0x1e;
      raw[row + 2 + x * 3] = 0x5a;
      raw[row + 3 + x * 3] = 0xd6;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// A `PreToolUse` hook that denies every Bash call. Written to a temp file
// because the hook command is a shell string, not an inline payload.
function denyHookSettings(scratch) {
  const helper = join(scratch, "deny-hook.mjs");
  writeFileSync(
    helper,
    [
      "let s = '';",
      "process.stdin.on('data', (d) => (s += d));",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ hookSpecificOutput: {",
      "    hookEventName: 'PreToolUse',",
      "    permissionDecision: 'deny',",
      "    permissionDecisionReason: 'protocol-probe: denied by fixture hook',",
      "  } }));",
      "});",
    ].join("\n"),
  );
  return {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${helper}`, timeout: 30 }] }],
    },
  };
}

// The shipped capture hook's shape: a matcher naming the write tools, and a
// helper that records what it was handed and decides nothing. `settings_json`
// in `approval.rs` builds the same two things, so this measures what the app
// really installs rather than a probe-shaped approximation of it.
function captureHookSettings(scratch, log) {
  const helper = join(scratch, "capture-hook.mjs");
  writeFileSync(
    helper,
    [
      "import { appendFileSync } from 'node:fs';",
      "let s = '';",
      "process.stdin.on('data', (d) => (s += d));",
      "process.stdin.on('end', () => {",
      "  let name = '?';",
      "  try { name = JSON.parse(s).tool_name; } catch {}",
      `  appendFileSync(${JSON.stringify(log)}, name + '\\n');`,
      // The marker and nothing else, exactly as the shipped helper prints it.
      // No `permissionDecision`, deliberately: any decision would end the chain
      // here and the harness would never ask. What this scenario measures is
      // that an output carrying *only* an unknown key does not.
      "  process.stdout.write(JSON.stringify({ swayApproval: true }));",
      "});",
    ].join("\n"),
  );
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit",
          hooks: [{ type: "command", command: `node ${helper}`, timeout: 30 }],
        },
      ],
    },
  };
}

// Hand a scenario exactly the one built-in tool it is measuring, so the model
// has nothing else to reach for. Needed because 2.1.241 **defers** most tools
// behind `ToolSearch`: measured, an unqualified "use the Glob tool" produced a
// `ToolSearch` and then a `Bash` ls, and adding "do not use Bash" produced a
// `ToolSearch` and no tool call at all. A result-shape fixture cannot be left
// to that.
//
// PROBE-ONLY, like `--setting-sources ''` above: it narrows what the model may
// call, never what a tool answers with, so the `tool_use_result` payload these
// fixtures exist for is the same payload the product sees.
const ONLY_TOOL = (name) => ["--permission-mode", "bypassPermissions", "--tools", name];

// Which tools a run actually called. A scenario that asked for `Grep` and got
// `Bash` has measured nothing, and committing that capture would leave the
// result-shape table asserting a payload the fixture does not contain - so the
// scenarios that exist to pin a result shape check this and fail the capture.
function toolsUsed(p) {
  const used = new Set();
  for (const ev of p.events) {
    if (ev.type !== "assistant") continue;
    for (const c of ev.message?.content ?? []) if (c.type === "tool_use") used.add(c.name);
  }
  return used;
}

function assertToolsUsed(p, expected) {
  const used = toolsUsed(p);
  const missing = expected.filter((n) => !used.has(n));
  if (missing.length) {
    throw new Error(
      `the model never called ${missing.join(", ")}; it called ${[...used].join(", ") || "no tool at all"}`,
    );
  }
}

// The `output_mode` each `Grep` call was made with. An *absent* mode is kept as
// `undefined` rather than defaulted, because a call that did not name its mode
// cannot pin that mode's result shape however the CLI happens to fill it in.
function grepModes(p) {
  const modes = new Set();
  for (const ev of p.events) {
    if (ev.type !== "assistant") continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type === "tool_use" && c.name === "Grep") modes.add(c.input?.output_mode);
    }
  }
  return modes;
}

const SCENARIOS = {
  // The floor: one turn, no tools. Everything else is this plus something.
  "plain-turn": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch });
    p.sendTurn("Reply with exactly the word: pong. Do not use any tools.");
    await p.waitForResult();
    await p.close();
    return p;
  },

  // The load-bearing measurement: the child survives a second turn on one
  // process when stdin stays open, and `system/init` re-emits per turn.
  "two-turns": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch });
    p.sendTurn("Reply with exactly the word: one. Do not use any tools.");
    await p.waitForResult();
    p.sendTurn("Reply with exactly the word: two. Do not use any tools.");
    await p.waitForResult();
    const alive = p.child.exitCode === null;
    await p.close();
    if (!alive) throw new Error("child exited between turns - the long-lived-process assumption is broken");

    // `total_cost_usd` and `modelUsage` accumulate across the session while the
    // `usage` block beside them is per turn. Pinned because reading the two as
    // one is what has `chatStore.ts:1197` and `usage.rs:86` summing a total.
    const [first, second] = p.events.filter((e) => e.type === "result");
    if (!second) throw new Error("only one result frame, so there is nothing to compare the second turn's cost to");
    if (!(second.total_cost_usd > first.total_cost_usd)) {
      throw new Error(
        `total_cost_usd did not grow across turns (${first.total_cost_usd} then ${second.total_cost_usd}); ` +
          "if it is per-turn now, the summing in chatStore.ts and usage.rs is correct after all",
      );
    }
    return p;
  },

  // What the wire says while a compaction runs, which is the only warning the
  // panel gets that the next 40 seconds are not a hung session.
  //
  // Four turns first: a shorter conversation is refused with
  // `compact_error: "Not enough messages to compact."`, which is a real branch
  // and a useless capture - it would record the failure path as if it were the
  // normal one. The words are the cheapest turns that still leave something to
  // summarise.
  compaction: async ({ scratch }) => {
    const p = new Probe({ cwd: scratch });
    for (const word of ["one", "two", "three", "four"]) {
      p.sendTurn(`Reply with exactly the word: ${word}. Do not use any tools.`);
      await p.waitForResult();
    }
    p.sendTurn("/compact");
    await p.waitForResult();
    await p.close();

    // Pins the negative `map_compact_boundary`'s guard rests on: the live frame
    // carries no nesting marker, so a subagent's boundary is indistinguishable
    // from the session's and the `isSidechain` it tests for never arrives.
    const boundary = p.events.find((e) => e.type === "system" && e.subtype === "compact_boundary");
    if (!boundary) throw new Error("no compact_boundary frame, so this run measured no compaction at all");
    // `isSidechain` on presence, `parent_tool_use_id` on value: a null parent is
    // how every main-agent frame spells itself, so presence would cry wolf.
    const marker =
      ("isSidechain" in boundary && "isSidechain") || (boundary.parent_tool_use_id && "parent_tool_use_id");
    if (marker) {
      throw new Error(
        `compact_boundary now carries ${marker}: a subagent's boundary may be tellable apart from the ` +
          "session's, so re-read map_compact_boundary before trusting its guard",
      );
    }
    return p;
  },

  // The control protocol, and the slash-command catalogue the composer needs.
  //
  // Also records what the control protocol will *not* do: move the permission
  // question between surfaces mid-session. `--permission-prompt-tool` and
  // `--settings` both bind when the child starts, so Sway's escape-hatch setting
  // can only apply from the next session - which is a limitation to state in the
  // setting's help text rather than one to discover during an incident. Asserted
  // against the CLI so that a version which *does* add a setter fails here
  // instead of leaving the help text quietly wrong.
  initialize: async ({ scratch }) => {
    const p = new Probe({ cwd: scratch });
    p.send({ type: "control_request", request_id: "probe-init", request: { subtype: "initialize", hooks: {} } });
    await p.waitFor((e) => e.type === "control_response", 30_000);

    for (const subtype of ["set_permission_prompt_tool", "setPermissionPromptTool"]) {
      p.send({ type: "control_request", request_id: `probe-${subtype}`, request: { subtype, tool: "stdio" } });
      const reply = await p.waitFor(
        (e) => e.type === "control_response" && e.response?.request_id === `probe-${subtype}`,
        30_000,
      );
      if (reply.response?.subtype !== "error") {
        throw new Error(`${subtype} is supported after all: the prompt surface may now be switchable mid-session`);
      }
    }

    await p.close();
    return p;
  },

  // tool_use / tool_result framing, on the cheapest tool.
  "bash-call": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch, extraArgs: ["--permission-mode", "bypassPermissions"] });
    p.sendTurn("Use the Bash tool to run exactly `echo sway-probe`. Then reply with just the output.");
    await p.waitForResult();
    await p.close();
    return p;
  },

  // The shape Phase 4's before-state snapshot and Phase 7's inline diffs hang
  // off: an `Edit` with its path in `tool_input`.
  "edit-call": async ({ scratch }) => {
    writeFileSync(join(scratch, "probe.txt"), "alpha\nbeta\ngamma\n");
    const p = new Probe({ cwd: scratch, extraArgs: ["--permission-mode", "bypassPermissions"] });
    p.sendTurn("Use the Edit tool on probe.txt to change the word beta to delta. Change nothing else.");
    await p.waitForResult();
    await p.close();
    return p;
  },

  // --- the result shapes the collapsed row has to summarise ---
  //
  // `bash-call` and `edit-call` above already cover the two write-ish tools.
  // These four cover the read-ish ones, and they exist for a payload rather
  // than for a frame kind: whether a tool answers with a *structured*
  // `tool_use_result` or with text only decides whether a summary can be read
  // off the wire or has to be parsed back out of prose. The answer per tool is
  // asserted in `claude.rs`'s result-shape table, which reads these fixtures.

  // Read reports its target under `file.filePath`, indistinguishable from a
  // write's `filePath` once the frame is all that is left - which is why
  // `READ_ONLY_TOOLS` is keyed on the call's name. Capturing it keeps that
  // exclusion with something real to exclude.
  "read-call": async ({ scratch }) => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(scratch, "probe.txt"), `${lines.join("\n")}\n`);
    const p = new Probe({ cwd: scratch, extraArgs: ONLY_TOOL("Read") });
    p.sendTurn("Use the Read tool on probe.txt. Then reply with just the number of lines in it.");
    await p.waitForResult();
    await p.close();
    assertToolsUsed(p, ["Read"]);
    return p;
  },

  // A path list, not a hit list. Phase 5 dispatches on the summary variant
  // rather than the tool name, and Glob is what proves those are two genuinely
  // different payloads rather than one payload read two ways.
  "glob-call": async ({ scratch }) => {
    mkdirSync(join(scratch, "nested"), { recursive: true });
    writeFileSync(join(scratch, "alpha.txt"), "alpha\n");
    writeFileSync(join(scratch, "beta.txt"), "beta\n");
    writeFileSync(join(scratch, "nested", "gamma.txt"), "gamma\n");
    writeFileSync(join(scratch, "notes.md"), "not a match\n");
    const p = new Probe({ cwd: scratch, extraArgs: ONLY_TOOL("Glob") });
    p.sendTurn("Use the Glob tool with the pattern **/*.txt. Then reply with just the number of files it found.");
    await p.waitForResult();
    await p.close();
    assertToolsUsed(p, ["Glob"]);
    return p;
  },

  // All three Grep output modes in one child, because the result's shape
  // follows `output_mode` and not the tool name: `content` answers with hits,
  // `files_with_matches` with paths, `count` with neither. A set of frame kinds
  // cannot say "three modes", so the modes are asserted here, the way
  // `fast-mode` asserts what its own vocabulary cannot.
  "grep-modes": async ({ scratch }) => {
    writeFileSync(join(scratch, "alpha.txt"), "needle here\nplain line\n");
    writeFileSync(join(scratch, "beta.txt"), "another needle\n");
    writeFileSync(join(scratch, "gamma.txt"), "nothing to see\n");
    const p = new Probe({ cwd: scratch, extraArgs: ONLY_TOOL("Grep") });
    const wanted = ["content", "files_with_matches", "count"];
    for (const mode of wanted) {
      p.sendTurn(
        `Use the Grep tool for the pattern needle with output_mode set to exactly "${mode}". ` +
          "Then reply with just the word: done.",
      );
      await p.waitForResult();
    }
    await p.close();
    assertToolsUsed(p, ["Grep"]);
    const modes = grepModes(p);
    const missing = wanted.filter((m) => !modes.has(m));
    if (missing.length) {
      const saw = [...modes].map((m) => (m === undefined ? "(mode not named)" : m)).join(", ");
      throw new Error(`Grep never ran in ${missing.join(", ")} mode; it ran as ${saw || "nothing"}`);
    }
    return p;
  },

  // The one tool here that leaves the machine. `example.com` is small, stable
  // and exists to be fetched; what is recorded is the result's shape, never the
  // page.
  //
  // OPERATOR NOTE: the only scenario needing network beyond the API itself. A
  // failure naming the fetch rather than a frame kind is that, not wire drift.
  "webfetch-call": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch, extraArgs: ONLY_TOOL("WebFetch") });
    p.sendTurn(
      'Use the WebFetch tool on https://example.com with the prompt "what is the page title". ' +
        "Then reply with just that title.",
    );
    await p.waitForResult();
    await p.close();
    assertToolsUsed(p, ["WebFetch"]);
    return p;
  },

  // Interrupt mid-turn, then prove the same child still takes a further turn.
  interrupt: async ({ scratch }) => {
    const p = new Probe({ cwd: scratch, extraArgs: ["--permission-mode", "bypassPermissions"] });
    p.sendTurn("Count slowly from 1 to 500, writing every number out in full words, one per line.");
    await p.waitFor((e) => e.type === "stream_event" && e.event?.type === "content_block_delta", 60_000);
    p.send({ type: "control_request", request_id: "probe-int", request: { subtype: "interrupt" } });
    await p.waitForResult();
    p.sendTurn("Reply with exactly the word: resumed. Do not use any tools.");
    await p.waitForResult();
    await p.close();
    return p;
  },

  // --- the in-protocol permission path (`--permission-prompt-tool stdio`) ---
  //
  // The gate this whole direction rests on: Sway stops deciding permissions and
  // renders the harness's own question instead. What matters is not that *every*
  // tool asks, but that every tool Sway would otherwise have gated either asks
  // or is one the harness deliberately settled itself.
  //
  // Measured 2026-08-14 on claude 2.1.231, one turn per class:
  //
  //   Write (default)          asks
  //   Bash `touch f` (default) asks
  //   WebFetch (default)       asks
  //   MCP tool (default)       asks, as `mcp__<server>__<tool>`
  //   Task subagent            asks, and the request carries `agent_id`
  //   plan mode                asks, for ExitPlanMode, Bash and Write alike
  //   Read (default)           does NOT ask - read-only tools are auto-allowed
  //   Bash `echo x` (default)  does NOT ask - the CLI safe-lists it
  //   acceptEdits / bypass     do NOT ask - the mode already answered
  //
  // The three silences are the harness deciding, not a hole: they are exactly
  // the calls a user did not need to be asked about. Two of them were found by
  // this probe lying to itself first, which is why the prompts below name a
  // *gated* tool rather than a convenient one - an earlier run used `echo` and
  // recorded "Bash never asks", and another killed the child while a
  // backgrounded subagent was still working and recorded "subagents never ask".
  "permission-coverage": async ({ scratch }) => {
    writeFileSync(join(scratch, "seed.txt"), "seed\n");
    const p = new Probe({
      cwd: scratch,
      extraArgs: ["--permission-mode", "default", "--permission-prompt-tool", "stdio"],
      // Bare allow, deliberately: measured, omitting `updatedInput` runs the
      // call as the model wrote it.
      answerPermission: () => ({ behavior: "allow" }),
    });
    p.sendTurn(
      "Do these three things in order, using a tool for each: (1) use the Write tool to create probe-perm.txt " +
        "containing 'ok', (2) use the Bash tool to run exactly `touch probe-touch.txt`, (3) use the Read tool " +
        "to read seed.txt. Then stop.",
    );
    await p.waitForResult();
    await p.close();

    const asked = p.permissionRequests.map((r) => r.tool_name);
    if (!asked.includes("Write")) throw new Error(`Write did not raise can_use_tool; asked: ${asked.join(", ") || "nothing"}`);
    if (asked.includes("Read")) throw new Error("Read raised can_use_tool, which contradicts the read-only auto-allow");
    return p;
  },

  // The two claims Sway's capture hook is built on, measured together because
  // they only matter together: the `matcher` alternation really selects (so the
  // hook is handed Edit and Write and never Read), and a hook that emits no
  // decision lets the permission chain continue (so the harness still asks).
  //
  // Get either wrong and the failure is silent in opposite directions: a
  // matcher treated as a literal name captures no before-state at all, and a
  // hook that answers suppresses the harness's question for exactly the write
  // tools this design hands to it.
  "hook-matcher": async ({ scratch }) => {
    writeFileSync(join(scratch, "seed.txt"), "hello\n");
    const log = join(scratch, "hook-fired.log");
    const p = new Probe({
      cwd: scratch,
      extraArgs: ["--permission-mode", "default", "--permission-prompt-tool", "stdio", "--include-hook-events"],
      settings: captureHookSettings(scratch, log),
      answerPermission: () => ({ behavior: "allow" }),
    });
    p.sendTurn(
      "Do exactly these three steps in order, with no other tools: (1) use the Read tool on seed.txt, " +
        "(2) use the Edit tool to replace the word hello with hi in seed.txt, (3) use the Write tool to " +
        "create out.txt containing 'ok'. Then stop.",
    );
    await p.waitForResult();
    await p.close();

    const fired = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    if (!fired.includes("Edit") || !fired.includes("Write")) {
      throw new Error(`the matcher did not select the write tools it names; it fired on: ${fired.join(", ") || "nothing"}`);
    }
    if (fired.includes("Read")) throw new Error("the matcher selected Read, so the alternation is not a selector");

    const asked = p.permissionRequests.map((r) => r.tool_name);
    if (!asked.includes("Write")) {
      throw new Error(
        `the hook's marker-only output ended the permission chain; asked: ${asked.join(", ") || "nothing"}`,
      );
    }
    if (asked.includes("Read")) throw new Error("Read raised can_use_tool, which contradicts the read-only auto-allow");

    // And the marker survived the round trip, which is what lets Sway tell its
    // own hook row apart from a user's. `hook_name` cannot: it reports the tool.
    const responses = p.events.filter((e) => e.type === "system" && e.subtype === "hook_response");
    const echoed = responses.filter((e) => typeof e.output === "string" && e.output.includes("swayApproval"));
    if (!echoed.length) {
      const seen = responses.map((e) => JSON.stringify({ output: e.output, stdout: e.stdout, outcome: e.outcome }));
      throw new Error(`no hook_response carried the marker back; saw: ${seen.join(" | ") || "no hook_response at all"}`);
    }
    return p;
  },

  // A subagent's own tool call must be attributable to the subagent, or its
  // prompt shows as the parent's work. `agent_id` is the only thing that says
  // so, and it appears on nothing else.
  "permission-subagent": async ({ scratch }) => {
    const p = new Probe({
      cwd: scratch,
      extraArgs: ["--permission-mode", "default", "--permission-prompt-tool", "stdio"],
      answerPermission: () => ({ behavior: "allow" }),
    });
    p.sendTurn(
      "Use the Task tool with run_in_background set to false to launch one general-purpose subagent whose prompt " +
        "is exactly: 'Use the Write tool to create sub-made.txt containing the word sub. Then report done.' " +
        "Wait for the subagent to finish, then report what it did.",
    );
    await p.waitForResult();
    // The parent's turn can end while a subagent is still working, so the child
    // is given a moment before teardown. Without this the scenario measures the
    // teardown rather than the protocol.
    await new Promise((r) => setTimeout(r, 20_000));
    await p.close();

    const fromSubagent = p.permissionRequests.filter((r) => r.agent_id);
    if (!fromSubagent.length) {
      throw new Error(
        `no can_use_tool carried an agent_id; saw ${p.permissionRequests.length} request(s) from ` +
          `${p.permissionRequests.map((r) => r.tool_name).join(", ") || "nothing"}`,
      );
    }
    return p;
  },

  // A backgrounded subagent outlives the turn that launched it, so its terminal
  // frame lands on a stream nobody is in a turn on. A lane settled from turn
  // state rather than from `task_notification` would never settle at all.
  "subagent-background": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch, extraArgs: ["--permission-mode", "bypassPermissions"] });
    p.sendTurn(
      "Use the Task tool with run_in_background set to true to launch one general-purpose subagent whose prompt " +
        "is exactly: 'Use the Write tool to create bg-made.txt containing the word bg. Then report done.' " +
        "Do not wait for it to finish. Reply with exactly the word: launched.",
    );
    await p.waitForResult();
    // Waited for rather than slept through, so a run in which it never arrives
    // fails loudly instead of capturing a stream that measures the teardown.
    await p.waitFor((e) => e.type === "system" && e.subtype === "task_notification", 120_000);
    await p.close();

    // The only thing this scenario controls is that the call *asked* to be
    // backgrounded. Where the notification then lands is the measurement, so it
    // is left to the fixture rather than asserted into a pass or a fail.
    const backgrounded = p.events.some(
      (e) =>
        e.type === "assistant" &&
        (e.message?.content ?? []).some((c) => c.type === "tool_use" && c.input?.run_in_background === true),
    );
    if (!backgrounded) {
      throw new Error("no tool call carried run_in_background: true, so this run measured a foreground subagent");
    }
    return p;
  },

  // A backgrounded **Bash** call, not an agent. It rides the same `task_*`
  // channel as a subagent and the whole question is what tells the two apart, so
  // the scenario asserts only that the frames arrived and leaves the
  // discriminating field to the fixture.
  "background-shell": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch, extraArgs: ["--permission-mode", "bypassPermissions"] });
    p.sendTurn(
      "Use the Bash tool with run_in_background set to true to run exactly: sleep 2; echo done. " +
        "Do not use the Task tool and do not launch any subagent. Reply with exactly the word: started.",
    );
    await p.waitForResult();
    await p.waitFor((e) => e.type === "system" && e.subtype === "task_notification", 120_000);
    await p.close();

    const started = p.events.filter((e) => e.type === "system" && e.subtype === "task_started");
    if (started.length === 0) {
      throw new Error("no task_started arrived, so this run measured nothing about the task channel");
    }
    // The finding, stated as the thing that must not be true: if a shell task
    // announced itself as `local_agent` there would be nothing to key on.
    const agentish = started.filter((e) => e.task_type === "local_agent");
    if (agentish.length > 0) {
      throw new Error(
        `a backgrounded Bash reported task_type "local_agent", so task_type cannot tell a shell task from a subagent`,
      );
    }
    return p;
  },

  // Two subagents share one stream, so the lane a frame belongs to switches back
  // and forth. What that costs a fold keyed on "the last item" is not measured
  // here: neither subagent emitted text, so no two lanes ever had a block open.
  "subagent-parallel": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch, extraArgs: ["--permission-mode", "bypassPermissions"] });
    p.sendTurn(
      "Use the Task tool twice in one message to launch two general-purpose subagents at the same time. " +
        "The first subagent's prompt is exactly: 'Use the Write tool to create one.txt containing the word one. " +
        "Then report done.' The second subagent's prompt is exactly: 'Use the Write tool to create two.txt " +
        "containing the word two. Then report done.' Wait for both, then report what they did.",
    );
    await p.waitForResult();
    await p.close();

    const started = p.events.filter((e) => e.type === "system" && e.subtype === "task_started");
    const ids = new Set(started.map((e) => e.task_id));
    if (ids.size < 2) {
      throw new Error(`only ${ids.size} subagent(s) started; two must run for this to measure a shared stream`);
    }
    // Counted rather than asserted as a boolean: one switch is a stream that
    // ran the two in sequence, which cannot exercise per-lane folding.
    const seq = p.events.filter((e) => e.type === "assistant").map((e) => e.parent_tool_use_id ?? "main");
    const switches = seq.filter((lane, i) => i > 0 && seq[i - 1] !== lane).length;
    if (switches < 2) {
      throw new Error(`the assistant stream changed lane ${switches} time(s); per-lane folding needs it to alternate`);
    }
    return p;
  },

  // Task 6's question, answered on the wire: an allow can carry a durable grant,
  // so "always allow this" is a real affordance rather than one Sway fakes.
  // Two Writes, the first answered with a session-scoped `addRules` echoing the
  // CLI's own suggestion; the second must not ask.
  "permission-grant": async ({ scratch }) => {
    const p = new Probe({
      cwd: scratch,
      extraArgs: ["--permission-mode", "default", "--permission-prompt-tool", "stdio"],
      answerPermission: (request, n) => {
        if (n > 1) return { behavior: "allow" };
        const offered = (request.permission_suggestions ?? []).find(
          (s) => s.type === "addRules" && s.behavior === "allow",
        );
        return {
          behavior: "allow",
          updatedPermissions: [
            {
              type: "addRules",
              // The harness's own rule text, echoed back. Composing one here
              // would be Sway inventing the grammar it is trying to defer to.
              rules: offered?.rules ?? [{ toolName: "Write" }],
              behavior: "allow",
              destination: "session",
            },
          ],
        };
      },
    });
    p.sendTurn(
      "Use the Write tool to create grant-a.txt containing 'a'. Then use the Write tool again to create " +
        "grant-b.txt containing 'b'. Then stop.",
    );
    await p.waitForResult();
    await p.close();

    const writes = p.permissionRequests.filter((r) => r.tool_name === "Write");
    if (writes.length !== 1) {
      throw new Error(
        `expected the session grant to silence the second Write, but Write asked ${writes.length} time(s)`,
      );
    }
    return p;
  },

  // Who owns the deadline. Measured: a `can_use_tool` left unanswered was still
  // outstanding after 413s, with no result frame and no timeout of the CLI's
  // own, so an unanswered prompt is a hang unless Sway ends it. That is why
  // `claude_transport.rs` arms its own timer rather than racing one.
  //
  // Bounded well under that here: what has to stay true is that the CLI does not
  // resolve the question before Sway's own DECIDE_TIMEOUT_SECS (110s) would. If
  // the CLI ever gains a shorter timeout, this fails and says so.
  "permission-deadline": async ({ scratch }) => {
    const WAIT_MS = 115_000;
    const p = new Probe({
      cwd: scratch,
      extraArgs: ["--permission-mode", "default", "--permission-prompt-tool", "stdio"],
      answerPermission: () => null, // never answer, on purpose
    });
    p.sendTurn("Use the Write tool to create never.txt containing 'ok'. Then stop.");
    await p.waitFor((e) => e.type === "control_request" && e.request?.subtype === "can_use_tool", 90_000);
    const asked = Date.now();
    await new Promise((r) => setTimeout(r, WAIT_MS));
    const waited = Date.now() - asked;
    const resolved = p.events.some((e) => e.type === "result");
    await p.close();

    if (resolved) {
      throw new Error(
        `the CLI resolved an unanswered permission request within ${waited}ms, so it now has a deadline of its ` +
          "own and Sway's 110s auto-deny is no longer the one that fires first",
      );
    }
    return p;
  },

  // `AskUserQuestion` is not a permission question, and the whole of Sway's
  // question surface rests on two measurements taken here.
  //
  //   1. **It raises `can_use_tool` in every permission mode**, `acceptEdits`
  //      and `bypassPermissions` included. That is a real exception to what
  //      `permission-coverage` measures for every other tool, and it is the
  //      exception the surface depends on: the CLI has no interactive client
  //      on this transport, so it hands the question out rather than deciding
  //      it. If this ever narrows to `default`, Sway's question form silently
  //      stops appearing for anyone not in that mode.
  //   2. **A deny's `message` is what the model reads**, byte for byte, with
  //      `is_error: true`. That is the only channel a permission answer has for
  //      carrying text, so it is how an answered question is delivered. An
  //      `allow` cannot carry one: measured, the CLI then self-answers within
  //      milliseconds with "The user did not answer the questions.", because
  //      allowing the call only lets it run against a client that is not there.
  //
  // The non-ASCII byte in the probe's message is deliberate. The string Sway
  // sends back quotes the user's own question text, which is arbitrary, so a
  // channel that mangled anything outside ASCII would corrupt real answers.
  "ask-user-question": async ({ scratch }) => {
    const MESSAGE = "probe: answered verbatim ✓";
    const ask =
      "Use the AskUserQuestion tool right now to ask which colour I want, with exactly the options " +
      "Red and Blue. Do nothing else first.";

    const p = new Probe({
      cwd: scratch,
      extraArgs: ["--permission-mode", "default", "--permission-prompt-tool", "stdio"],
      answerPermission: (request) =>
        request.tool_name === "AskUserQuestion"
          ? { behavior: "deny", message: MESSAGE }
          : { behavior: "allow" },
    });
    p.sendTurn(ask);
    await p.waitForResult();
    await p.close();

    if (!p.permissionRequests.some((r) => r.tool_name === "AskUserQuestion")) {
      throw new Error(
        `AskUserQuestion did not raise can_use_tool; asked: ${
          p.permissionRequests.map((r) => r.tool_name).join(", ") || "nothing"
        }`,
      );
    }
    const answered = p.permissionRequests.find((r) => r.tool_name === "AskUserQuestion");
    // The shape the question form is built against. A fourth key, or a renamed
    // one, changes what Sway has to render.
    for (const key of ["question", "header", "options", "multiSelect"]) {
      if (!(key in (answered.input?.questions?.[0] ?? {}))) {
        throw new Error(`a question lost the '${key}' key: ${JSON.stringify(answered.input?.questions?.[0])}`);
      }
    }

    const results = p.events.flatMap((e) =>
      e.type === "user" ? (e.message?.content ?? []).filter((c) => c.type === "tool_result") : [],
    );
    const mine = results.find((c) => c.tool_use_id === answered.tool_use_id);
    if (!mine) throw new Error("the denied question produced no tool_result");
    const text = typeof mine.content === "string" ? mine.content : JSON.stringify(mine.content);
    if (text !== MESSAGE) {
      throw new Error(`the deny message did not reach the model verbatim; it arrived as ${JSON.stringify(text)}`);
    }
    if (mine.is_error !== true) {
      throw new Error("a denied question stopped being is_error: true, and it is the only answer channel there is");
    }

    // Mode independence, the half that cannot be read off the fixture. Its own
    // child in its own directory, and its events are deliberately not the
    // captured ones: the fixture pins one vocabulary, and this pins that the
    // question still reaches Sway when the user has stopped being asked about
    // anything else.
    const bypassCwd = mkdtempSync(join(tmpdir(), "sway-probe-ask-bypass-"));
    const bypass = new Probe({
      cwd: bypassCwd,
      extraArgs: ["--permission-mode", "bypassPermissions", "--permission-prompt-tool", "stdio"],
      answerPermission: (request) =>
        request.tool_name === "AskUserQuestion"
          ? { behavior: "deny", message: MESSAGE }
          : { behavior: "allow" },
    });
    bypass.sendTurn(ask);
    await bypass.waitForResult();
    await bypass.close();
    const bypassAsked = bypass.permissionRequests.some((r) => r.tool_name === "AskUserQuestion");
    rmSync(bypassCwd, { recursive: true, force: true });
    if (!bypassAsked) {
      throw new Error(
        "AskUserQuestion stopped asking under bypassPermissions, so the question surface is now mode-dependent",
      );
    }

    return p;
  },

  // A hook deny blocking a tool: the reason reaches the model as the tool
  // result and is recorded in `result.permission_denials`. Runs under
  // `bypassPermissions` on purpose, since hooks run first in the permission
  // chain and that is what makes Phase 4's gate authoritative.
  "hook-denied": async ({ scratch }) => {
    const p = new Probe({
      cwd: scratch,
      extraArgs: ["--permission-mode", "bypassPermissions", "--include-hook-events"],
      settings: denyHookSettings(scratch),
    });
    p.sendTurn("Use the Bash tool to run exactly `echo blocked`. If it fails, say why in one sentence.");
    const result = await p.waitForResult();
    await p.close();
    if (!result.permission_denials?.length) throw new Error("hook deny did not reach result.permission_denials");
    return p;
  },

  // An image content block over stream-json stdin.
  "image-turn": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch });
    p.sendTurn([
      { type: "image", source: { type: "base64", media_type: "image/png", data: bluePng().toString("base64") } },
      { type: "text", text: "In one word, what colour is this image?" },
    ]);
    await p.waitForResult();
    await p.close();
    return p;
  },

  // Fast mode is refused over this transport, and the refusal is the fixture's
  // whole point. `/fast` is in the slash-command catalogue describing itself as
  // "Toggle fast mode (Opus 5)", so it looks like a control Sway could ship;
  // sending it on Opus 5 - the model it names - answers "Fast mode is not
  // available in the Agent SDK" and leaves `fast_mode_state: "off"` on both the
  // sending turn's `system/init` and the next one's. Measured identically on
  // `sonnet`, which is what makes this a property of the transport rather than
  // of the model.
  //
  // The vocabulary check cannot see this: a working toggle and a refusal emit
  // the same frame kinds. So the measurement is asserted here instead, and it
  // fails loudly if a later CLI opts the SDK in - which is the day Sway should
  // ship the toggle this scenario currently says it must not.
  //
  // OPERATOR NOTE: this is the only scenario that pins a model, so it is the
  // only one that needs Opus access on the running account. A failure here that
  // mentions the model rather than fast mode is that, not wire-format drift.
  "fast-mode": async ({ scratch }) => {
    const p = new Probe({ cwd: scratch, extraArgs: ["--model", "opus"] });
    p.sendTurn("/fast on");
    const toggled = await p.waitForResult();
    // A second turn, because `system/init` fires once per turn at turn open, so
    // a state change landing late would show up here and nowhere else.
    p.sendTurn("Reply with exactly the word: after. Do not use any tools.");
    await p.waitForResult();
    await p.close();

    const inits = p.events.filter((e) => e.type === "system" && e.subtype === "init");
    if (inits.length < 2) throw new Error(`expected an init per turn, saw ${inits.length}`);
    const changed = inits.filter((e) => e.fast_mode_state !== "off");
    if (changed.length) {
      throw new Error(
        `fast_mode_state moved to ${JSON.stringify(changed[0].fast_mode_state)} - the SDK is now opted in and ` +
          `the mirror's fast_mode row should stop being published refused; re-read this scenario's note`,
      );
    }
    if (!/not available in the Agent SDK/i.test(String(toggled.result ?? ""))) {
      throw new Error(`the refusal text changed: ${JSON.stringify(String(toggled.result ?? "").slice(0, 200))}`);
    }
    return p;
  },
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(CLAUDE)) {
    console.error(`claude not found at ${CLAUDE} (set SWAY_CLAUDE_BIN)`);
    process.exit(2);
  }
  const version = (await run(CLAUDE, ["--version"])).trim();
  mkdirSync(FIXTURES, { recursive: true });

  const names = ONLY ? [ONLY] : Object.keys(SCENARIOS);
  let failed = 0;
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) {
      console.error(`unknown scenario: ${name}`);
      process.exit(2);
    }
    const scratch = mkdtempSync(join(tmpdir(), `sway-probe-${name}-`));
    let probe;
    try {
      probe = await scenario({ scratch });
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
      failed++;
      rmSync(scratch, { recursive: true, force: true });
      continue;
    }
    rmSync(scratch, { recursive: true, force: true });

    const kinds = vocabulary(probe.events);
    const required = kinds.filter((k) => !DISCRETIONARY.has(k));
    const optional = kinds.filter((k) => DISCRETIONARY.has(k));
    const kindsPath = join(FIXTURES, `${name}.kinds.json`);
    const rawPath = join(FIXTURES, `${name}.jsonl`);

    // The grammar holds on every run, captured or checked - a fixture recorded
    // from a malformed stream would bake the malformation in.
    const grammar = checkGrammar(probe.events).filter(
      (p) => !(TRUNCATED_BY_DESIGN.has(name) && DANGLING.includes(p)),
    );
    const missing = (REQUIRES[name] ?? []).filter((k) => !kinds.includes(k));

    if (WRITE) {
      if (grammar.length || missing.length) {
        console.error(`  ✗ ${name}: refusing to capture an invalid run`);
        for (const p of grammar) console.error(`      grammar: ${p}`);
        for (const m of missing) console.error(`      missing required kind: ${m}`);
        failed++;
        continue;
      }
      writeFileSync(rawPath, `${probe.events.map((e) => JSON.stringify(e)).join("\n")}\n`);
      writeFileSync(
        kindsPath,
        `${JSON.stringify({ verifiedAgainst: version, required, optional }, null, 2)}\n`,
      );
      console.log(`  ✓ ${name}: captured ${probe.events.length} events, ${kinds.length} kinds`);
      continue;
    }

    if (!existsSync(kindsPath)) {
      console.error(`  ✗ ${name}: no committed fixture; run with --write`);
      failed++;
      continue;
    }
    const golden = JSON.parse(readFileSync(kindsPath, "utf8"));
    // `optional` records which discretionary kinds this capture happened to
    // see; the *allowance* is DISCRETIONARY itself. Checking against the
    // recorded list instead would flag a thinking block that the model simply
    // chose not to emit on capture day and did emit today.
    const known = new Set(golden.required);
    const unknown = kinds.filter((k) => !known.has(k) && !DISCRETIONARY.has(k));
    const gone = golden.required.filter((k) => !kinds.includes(k));

    if (unknown.length || gone.length || grammar.length || missing.length) {
      console.error(`  ✗ ${name}: drifted (fixture from ${golden.verifiedAgainst}, CLI ${version})`);
      for (const k of unknown) console.error(`      frame kind not in the fixture's vocabulary: ${k}`);
      for (const k of gone) console.error(`      required frame kind no longer emitted: ${k}`);
      for (const m of missing) console.error(`      scenario's required kind missing: ${m}`);
      for (const p of grammar) console.error(`      grammar violated: ${p}`);
      failed++;
    } else {
      console.log(`  ✓ ${name}: ${kinds.length} kinds, grammar holds`);
    }
  }

  if (failed) {
    console.error(
      `\n${failed} scenario(s) failed. A new or renamed frame kind, a required kind gone, or a grammar violation ` +
        `all mean the CLI's wire format moved and the mappers in src-tauri/src/chat/claude.rs need updating. ` +
        `Re-capture with --write only after reading what changed - the check is set-and-grammar based precisely ` +
        `so that it does not flap on model discretion, so a failure here is real.`,
    );
    process.exit(1);
  }
  console.log(`\nall fixtures reproduce against claude ${version}`);
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, argv);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
