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
]);

// The scenario's whole point, asserted every run. Without these, marking the
// discretionary kinds optional could let a scenario degrade to an empty stream
// and still pass.
const REQUIRES = {
  "plain-turn": ["assistant/text", "result/success"],
  "two-turns": ["system/init", "assistant/text", "result/success"],
  initialize: ["control_response/success"],
  "bash-call": ["assistant/tool_use", "user/tool_result", "result/success"],
  "edit-call": ["assistant/tool_use", "user/tool_result", "result/success"],
  // The cancelled turn's own result, plus a clean one after it: together they
  // prove the interrupt landed and the child survived it.
  interrupt: ["result/error_during_execution", "result/success"],
  "hook-denied": ["system/hook_started", "system/hook_response", "user/tool_result"],
  "image-turn": ["assistant/text", "result/success"],
  // A set cannot say "twice", so this only pins that both turns' shapes are
  // here at all; that there are two inits is asserted in the scenario body.
  "fast-mode": ["system/init", "assistant/text", "result/success"],
};

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
  constructor({ cwd, extraArgs = [], settings = null }) {
    this.events = [];
    this.buf = "";
    this.waiters = [];
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
    return p;
  },

  // The control protocol, and the slash-command catalogue the composer needs.
  initialize: async ({ scratch }) => {
    const p = new Probe({ cwd: scratch });
    p.send({ type: "control_request", request_id: "probe-init", request: { subtype: "initialize", hooks: {} } });
    await p.waitFor((e) => e.type === "control_response", 30_000);
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
          `FastModeStatus should become a toggle; re-read this scenario's note`,
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
    const grammar = checkGrammar(probe.events);
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
