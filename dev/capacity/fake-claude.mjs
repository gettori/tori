#!/usr/bin/env node
// Stands in for the claude CLI during a capacity run (dev/capacity/run.mjs). It
// speaks the stream-json chat protocol Tori drives, streams paced turns, makes
// real Edit and Bash calls in its folder and appends to its transcript, so the
// load costs nothing, hits no rate limit, and is the same bytes every run.
//
// Frames are cloned from dev/fixtures/claude/, the captures the real transport
// is measured against, so a fixture refresh carries into the fake for free.
//
// Pacing is read from $HOME/.capacity/fake.json at the start of every turn,
// which is how the driver turns a step's streaming window on and off:
//   { "deltaMs": 50, "deltaChars": 12, "turnSeconds": 20, "toolEveryMs": 4000, "bashLines": 80 }
//
// A prompt carrying `tools=N` runs exactly N rounds at fill speed instead, for
// building a chat's history fast. Every turn ends by touching
// $HOME/.capacity/done/<session id>, which is how the driver knows it is over.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const VERSION = "2.1.231 (Claude Code)";
const DEFAULTS = { deltaMs: 50, deltaChars: 12, turnSeconds: 20, toolEveryMs: 4000, bashLines: 80 };
const FILL = { deltaMs: 2, deltaChars: 200, toolEveryMs: 8 };

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}
// Only the chat transport is faked. Anything else Tori runs (a usage probe, a
// plugin listing) gets an empty success rather than a hang.
if (!args.includes("-p")) process.exit(0);

const flag = (name) => {
  const i = args.lastIndexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? randomUUID();
const cwd = process.cwd();

const fixture = (name) =>
  readFileSync(new URL(`../fixtures/claude/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const edit = fixture("edit-call");
const interrupted = fixture("interrupt");
const initialize = fixture("initialize")[0].response.response;

const find = (frames, pick) => frames.find(pick);
const T = {
  init: find(edit, (f) => f.type === "system" && f.subtype === "init"),
  status: find(edit, (f) => f.type === "system" && f.subtype === "status"),
  rateLimit: find(edit, (f) => f.type === "rate_limit_event"),
  messageStart: find(edit, (f) => f.type === "stream_event" && f.event.type === "message_start"),
  messageDelta: find(edit, (f) => f.type === "stream_event" && f.event.type === "message_delta"),
  assistant: find(edit, (f) => f.type === "assistant"),
  result: find(edit, (f) => f.type === "result"),
  interruptNote: find(interrupted, (f) => f.type === "user"),
  interruptResult: find(interrupted, (f) => f.type === "result" && f.subtype === "error_during_execution"),
};

const clone = (v) => structuredClone(v);
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const stamp = (frame) => ({ ...frame, session_id: sessionId, uuid: randomUUID() });
const event = (e) => out(stamp({ type: "stream_event", event: e, parent_tool_use_id: null }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pacing() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(join(homedir(), ".capacity/fake.json"), "utf8")) };
  } catch {
    return DEFAULTS;
  }
}

const transcriptDir = join(homedir(), ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
let lastUuid = null;
function record(type, message) {
  mkdirSync(transcriptDir, { recursive: true });
  const uuid = randomUUID();
  const line = {
    type,
    uuid,
    parentUuid: lastUuid,
    sessionId,
    cwd,
    gitBranch: "main",
    timestamp: new Date().toISOString(),
    message,
  };
  lastUuid = uuid;
  appendFileSync(transcriptPath, `${JSON.stringify(line)}\n`);
}

const WORDS =
  "the agent reads each file then edits the branch and checks the build before it reports what changed".split(" ");
let wordAt = 0;
function prose(chars) {
  let s = "";
  while (s.length < chars) s += `${WORDS[wordAt++ % WORDS.length]} `;
  return s;
}

function assistantFrame(msgId, content, stop) {
  const a = clone(T.assistant);
  a.message.id = msgId;
  a.message.content = content;
  a.message.stop_reason = stop;
  a.timestamp = new Date().toISOString();
  return stamp(a);
}

let aborted = false;
let busy = false;
const queue = [];

async function streamText(msgId, index, ms, cfg) {
  event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
  let text = "";
  const until = Date.now() + ms;
  while (!aborted && Date.now() < until) {
    const piece = prose(cfg.deltaChars).slice(0, cfg.deltaChars);
    text += piece;
    event({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
    await sleep(cfg.deltaMs);
  }
  out(assistantFrame(msgId, [{ type: "text", text }], null));
  event({ type: "content_block_stop", index });
  record("assistant", { role: "assistant", content: [{ type: "text", text }] });
}

const scratch = join(cwd, `capacity-${sessionId.slice(0, 8)}.txt`);
let editCount = 0;

function runTool(round, cfg) {
  const id = `toolu_cap${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  if (round % 2 === 0) {
    if (!existsSync(scratch)) writeFileSync(scratch, "capacity\n");
    const original = readFileSync(scratch, "utf8");
    const last = original.trimEnd().split("\n").pop();
    const line = `edit ${++editCount} ${new Date().toISOString()}`;
    writeFileSync(scratch, `${original.trimEnd()}\n${line}\n`);
    return {
      id,
      name: "Edit",
      input: { file_path: scratch, old_string: last, new_string: `${last}\n${line}`, replace_all: false },
      content: `The file ${scratch} has been updated successfully.`,
      result: {
        filePath: scratch,
        oldString: last,
        newString: `${last}\n${line}`,
        originalFile: original,
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [` ${last}`, `+${line}`] }],
        userModified: false,
        replaceAll: false,
      },
    };
  }
  const stdout = Array.from({ length: cfg.bashLines }, (_, i) => `ok ${i + 1} ${prose(40).trim()}`).join("\n");
  return {
    id,
    name: "Bash",
    input: { command: `seq 1 ${cfg.bashLines}`, description: "Run the checks" },
    content: stdout,
    result: { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
  };
}

async function toolMessage(round, cfg) {
  const msgId = `msg_cap${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const start = clone(T.messageStart);
  start.event.message.id = msgId;
  out(stamp(start));
  await streamText(msgId, 0, cfg.toolEveryMs, cfg);
  if (aborted) return;
  const call = runTool(round, cfg);
  const use = { type: "tool_use", id: call.id, name: call.name, input: call.input, caller: { type: "direct" } };
  event({ type: "content_block_start", index: 1, content_block: { ...use, input: {} } });
  event({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
  });
  out(assistantFrame(msgId, [use], null));
  event({ type: "content_block_stop", index: 1 });
  out(stamp(T.messageDelta));
  event({ type: "message_stop" });
  record("assistant", { role: "assistant", content: [use] });
  const content = [{ tool_use_id: call.id, type: "tool_result", content: call.content }];
  out(
    stamp({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, tool_use_result: call.result }),
  );
  record("user", { role: "user", content });
  out(stamp(T.status));
}

async function finalMessage(cfg) {
  const msgId = `msg_cap${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const start = clone(T.messageStart);
  start.event.message.id = msgId;
  out(stamp(start));
  await streamText(msgId, 0, Math.min(1500, cfg.toolEveryMs), cfg);
  const delta = clone(T.messageDelta);
  delta.event.delta.stop_reason = "end_turn";
  out(stamp(delta));
  event({ type: "message_stop" });
}

function toolsAsked(content) {
  const text = content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
  const m = text.match(/tools=(\d+)/);
  return m ? Number(m[1]) : null;
}

async function turn(content) {
  busy = true;
  aborted = false;
  const tools = toolsAsked(content);
  const cfg = tools == null ? pacing() : { ...pacing(), ...FILL };
  const began = Date.now();
  const more = (round) => (tools == null ? Date.now() - began < cfg.turnSeconds * 1000 : round < tools);
  out(stamp({ ...clone(T.init), cwd }));
  out(stamp(T.status));
  out(stamp(T.rateLimit));
  record("user", { role: "user", content });
  let round = 0;
  while (!aborted && more(round)) await toolMessage(round++, cfg);
  if (aborted) {
    out(stamp(T.interruptNote));
    out(stamp(T.interruptResult));
  } else {
    await finalMessage(cfg);
    out(stamp({ ...clone(T.result), num_turns: round + 1, duration_ms: Date.now() - began, result: "Done." }));
  }
  const done = join(homedir(), ".capacity/done");
  mkdirSync(done, { recursive: true });
  writeFileSync(join(done, sessionId), JSON.stringify({ rounds: round, at: Date.now() }));
  busy = false;
  const next = queue.shift();
  if (next) void turn(next);
}

function answer(request) {
  const reply = (response) =>
    out({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
  switch (request.request?.subtype) {
    case "initialize":
      return reply({ ...initialize, pid: process.pid });
    case "interrupt":
      aborted = busy;
      queue.length = 0;
      return reply({ still_queued: [] });
    case "set_permission_mode":
      return reply({ mode: request.request.mode });
    default:
      return reply({});
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.type === "control_request") return answer(frame);
  if (frame.type === "user") {
    const content = frame.message?.content ?? [];
    if (busy) queue.push(content);
    else void turn(content);
  }
});
process.stdin.on("end", () => process.exit(0));
