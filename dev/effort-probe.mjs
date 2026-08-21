#!/usr/bin/env node
// Measure which `--effort` levels this `claude` really has, and pin the answer
// in dev/fixtures/claude/effort-levels.json.
//
//   node dev/effort-probe.mjs             # re-verify the committed measurement
//   node dev/effort-probe.mjs --write     # re-take it
//
// WHY THIS IS NOT PART OF protocol-probe.mjs
//
// That script pins the *wire format* - which frame kinds a scenario produces and
// the order they may arrive in. This pins something else entirely: what one
// command-line flag accepts. There is no stream to record and no vocabulary to
// diff, so it is a sibling script the way acp-probe.mjs and codex-probe.mjs are.
//
// THE OBSERVABLE, and why it is the validator rather than behaviour
//
// `--help` advertises five levels. `[[chat.effort_extras]]` in claude.toml
// claims one more, and a claim Sway makes about a CLI has to be re-checkable or
// it rots. The trap to avoid is the one `--permission-mode auto` set: that flag
// is accepted on a model that does not support it, exits 0, and silently runs
// something else, with nothing anywhere to contradict it. Mere acceptance is
// therefore not evidence of anything.
//
// **This is not mere acceptance.** `--effort <word> --version` writes
// `Unknown --effort value` to stderr for a word this CLI does not have, and
// writes nothing for one it does. Measured on 2.1.237: `off`, `ultra`,
// `ultrathink`, `none`, `minimal` and `auto` are all named and rejected, while
// `ultracode` passes silently alongside the five advertised levels. That is the
// CLI asserting, in its own voice, that the word is one of its own - which is
// the thing `--permission-mode auto` never does. It costs no API call, it is
// deterministic, and its false case fires loudly.
//
// A BEHAVIOURAL OBSERVABLE WAS BUILT AND MEASURED AND DOES NOT WORK.
//
// The obvious second check - a completed turn's
// `usage.output_tokens_details.thinking_tokens` against a level known to think
// less - was written first and measured, and it is noise. On one prompt on
// sonnet, three paired runs gave `off` 466/0/0 thinking tokens against
// `ultracode` 0/0/1633; an earlier pair gave `high` 0 against `ultracode` 6297,
// and the run after that gave `high` 431 against `ultracode` 567. Whether the
// model thinks at all is its own discretion, so a single sample separates
// nothing and averaging a handful does not either. Shipping it would be a check
// that flips on model mood, which is a check nobody reads - the same finding
// protocol-probe.mjs's header records about diffing event sequences.
//
// So the fixture pins the validator's answer and nothing else, and the states a
// level can be in are:
//
//   * `working` - the validator knows the word. May ship in
//                 `[[chat.effort_extras]]` and render as a pickable level.
//   * `refused` - the validator does not. Recorded so the day this CLI gains the
//                 word fails here rather than going unnoticed, and it ships
//                 nothing: a greyed-out level claude never had would be Sway
//                 inventing vocabulary, which is the whole trap.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIXTURE = join(ROOT, "dev", "fixtures", "claude", "effort-levels.json");
const CLAUDE = process.env.SWAY_CLAUDE_BIN || join(process.env.HOME, ".local", "bin", "claude");

const WRITE = process.argv.slice(2).includes("--write");

// The five `--help` names, so a level moving in or out of the advertised set is
// itself a drift the fixture catches.
const ADVERTISED = ["low", "medium", "high", "xhigh", "max"];

// Words worth asking about. Every one of these was a plausible level somebody
// could have shipped a picker row for; the fixture records which ones are real.
const CANDIDATES = ["ultracode", "ultra", "ultrathink", "off", "none", "minimal", "auto"];

// ASCII, and deliberately only the stable half of the sentence: the CLI's
// warning contains an em dash and a trailing list of valid values, and matching
// on either would make this flap on wording that is not the finding.
const REJECTION = "Unknown --effort value";

/** Whether this CLI's `--effort` knows a word. No API call: the validator runs
 *  before anything is sent, so `--version` is enough to hear it. */
async function validate(level) {
  const { stderr } = await run(CLAUDE, ["--effort", level, "--version"]);
  return stderr.includes(REJECTION) ? "rejected" : "accepted";
}

async function main() {
  if (!existsSync(CLAUDE)) {
    console.error(`claude not found at ${CLAUDE} (set SWAY_CLAUDE_BIN)`);
    process.exit(2);
  }
  const version = (await run(CLAUDE, ["--version"])).stdout.trim();
  const golden = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;

  const advertised = [];
  for (const level of ADVERTISED) {
    if ((await validate(level)) === "accepted") advertised.push(level);
  }

  const candidates = [];
  for (const level of CANDIDATES) {
    const validator = await validate(level);
    candidates.push({
      level,
      observable: "validator",
      validator,
      state: validator === "accepted" ? "working" : "refused",
    });
  }

  const measured = { verifiedAgainst: version, advertised, candidates };

  if (WRITE) {
    mkdirSync(join(ROOT, "dev", "fixtures", "claude"), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(measured, null, 2)}\n`);
    console.log(`  captured against claude ${version}`);
    for (const c of candidates) console.log(`    ${c.level}: ${c.state}`);
    return;
  }

  if (!golden) {
    console.error(`  no committed measurement at ${FIXTURE}; run with --write`);
    process.exit(1);
  }

  const drift = [];
  if (golden.advertised.join(",") !== advertised.join(",")) {
    drift.push(`--effort now advertises [${advertised}], the fixture recorded [${golden.advertised}]`);
  }
  for (const c of candidates) {
    const was = golden.candidates.find((g) => g.level === c.level);
    if (!was) {
      drift.push(`${c.level}: not in the fixture; re-capture with --write`);
    } else if (was.state !== c.state) {
      drift.push(`${c.level}: now ${c.state}, the fixture recorded ${was.state}`);
    }
  }

  if (drift.length) {
    console.error(`  effort levels drifted (fixture from ${golden.verifiedAgainst}, CLI ${version})`);
    for (const d of drift) console.error(`      ${d}`);
    console.error(
      `\n  A level gained or lost changes what [[chat.effort_extras]] in src-tauri/agents/claude.toml may ` +
        `claim, and every row there names the version it was measured on. Re-capture with --write, then ` +
        `move the row in or out of that table by hand and bump its measured_on.`,
    );
    process.exit(1);
  }
  console.log(`  effort levels reproduce against claude ${version}`);
  for (const c of candidates) console.log(`    ${c.level}: ${c.state}`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("error", reject);
    c.on("exit", () => resolve({ stdout, stderr }));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
