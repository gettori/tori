#!/usr/bin/env node
// Regenerate the ACP launch catalog from the official ACP Registry.
//
//   node dev/acp-catalog.mjs            # rewrite src-tauri/catalog/acp-agents.json
//   node dev/acp-catalog.mjs --check    # fail if the committed file is out of date
//
// WHY THIS IS GENERATED AND COMMITTED, rather than either hand-maintained or
// fetched at runtime.
//
// Hand-maintained is what [[adr_harness_breadth]] accepted as a "permanent
// per-harness maintenance tax", and it is the part of that decision this script
// repays: the registry is a curated upstream that already tracks ~48 agents,
// their launch commands and their versions, so copying entries by hand would be
// re-doing work somebody else does continuously and getting it wrong later.
//
// Fetched at runtime is worse for two reasons that outweigh freshness. Sway adds
// no endpoint of its own and proxies nothing, and a catalogue that needs the
// network would be empty exactly when a user is offline and most wants to know
// what their options are. So the list is data in the binary, and this script is
// how it is refreshed.
//
// THE REFRESH STORY, so the list cannot rot silently: the committed file records
// the registry commit it was generated from and the date. `--check` fails when
// the upstream has moved, which is what a maintainer runs (or CI runs) to find
// out that it has. Nothing auto-updates: a new launch command reaching users
// without anyone looking at it is the failure mode a catalogue of *unmeasured*
// entries most needs to avoid.
//
// WHAT IS DROPPED, and why it is recorded rather than merely skipped. Two kinds:
//
//   * **Quarantined upstream.** The registry keeps `quarantine.json`, a map of
//     agent id to the reason it does not work - "ACP initialize fails", "npx
//     cannot determine executable to run", "Postinstall script". Offering those
//     as launch commands would be worse than offering nothing: the catalogue's
//     entries are *untested by Sway*, which is a different and much weaker claim
//     than *known broken by the people who curate them*. They are excluded and
//     the reasons are committed alongside, so "why is X not listed" has an
//     answer that is not "nobody knows".
//   * **Not expressible as a launch.** An entry with no `npx`, `uvx` or `binary`
//     distribution has no program Sway could name. Left out rather than
//     half-included.
//
// Either way the count is printed, because a catalogue that quietly covers less
// than its upstream reads as "these are all the agents there are".
//
// WHAT A `binary` ENTRY NOW CARRIES, and why the shape is per platform. The
// registry describes a `binary` distribution as one entry per
// `<os>-<arch>` key, each with an `archive` URL, the `cmd` inside it, optional
// `args`, optional `env`, and an **optional** `sha256`. Measured 2026-08-14
// across the 17 binary agents: every one publishes `darwin-aarch64`, `kimi`
// publishes no `darwin-x86_64` at all, and only 9 of 17 publish a checksum. So
// the platform map is carried whole rather than collapsed to this machine's
// entry: the generator runs on one architecture and the binary it produces runs
// on others, and "there is no build for your machine" is a fact the catalogue
// has to be able to state rather than a row that silently disappears.
//
// THE PROTOCOL MATRIX IS AN OPTIONAL PRIOR. `.protocol-matrix/latest.json` is
// the registry's own probe of what each agent answered, and it is read
// best-effort into `published_capabilities`, kept under a name that says whose
// measurement it is. It is never merged with Sway's own: an adapter's tier comes
// from `src/utils/chatCapabilities.ts` and its `verified_against` from a CLI
// Sway ran, and a row here has neither. The file sits in a dot-directory covered
// by no published schema, so a missing or reshaped one drops the field and
// prints the shortfall; the catalogue is built either way.
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "agentclientprotocol/registry";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "catalog", "acp-agents.json");

const gh = async (path) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
};

/**
 * One entry's launch command, as a program plus arguments.
 *
 * `npx` is taken as-is: the package name is pinned by the registry, and `-y`
 * keeps a first run from stopping on a prompt.
 *
 * `binary` carries the registry's whole platform map as `builds`, plus a display
 * program taken from the basename of the `cmd`. Sway installs one of these into
 * a directory of its own, so the launch a user ends up typing is an absolute
 * path under that directory rather than a bare name, and `needs: "install"` says
 * the fetch is Sway's to do. A `binary` entry that lists no platform at all
 * falls back to `on-path`, which is the only honest thing left to offer.
 */
function launchOf(distribution) {
  if (distribution?.npx?.package) {
    return {
      program: "npx",
      args: ["-y", distribution.npx.package, ...(distribution.npx.args ?? [])],
      needs: "npx",
    };
  }
  if (distribution?.uvx?.package) {
    return {
      program: "uvx",
      args: [distribution.uvx.package, ...(distribution.uvx.args ?? [])],
      needs: "uvx",
    };
  }
  const binary = distribution?.binary;
  if (binary) {
    const builds = {};
    for (const [platform, e] of Object.entries(binary)) {
      if (typeof e?.archive !== "string" || typeof e?.cmd !== "string") continue;
      builds[platform] = {
        archive: e.archive,
        // Optional upstream, and absent for 8 of the 17 binary agents. Carried
        // as null rather than omitted so "this download is unverified" is a
        // value the UI reads, not an absence it has to infer.
        sha256: typeof e.sha256 === "string" ? e.sha256 : null,
        cmd: e.cmd,
        args: e.args ?? [],
        env: e.env ?? {},
      };
    }
    // Display only. Any platform's entry names the same command; prefer this
    // machine's family so a `.cmd` suffix from a Windows entry never leaks in.
    const entry =
      binary["darwin-aarch64"] ?? binary["darwin-x86_64"] ?? binary["linux-x86_64"] ?? Object.values(binary)[0];
    if (!entry?.cmd) return null;
    const program = entry.cmd.split(/[\\/]/).pop();
    if (!program) return null;
    const launch = { program, args: entry.args ?? [] };
    return Object.keys(builds).length
      ? { ...launch, needs: "install", builds }
      : { ...launch, needs: "on-path" };
  }
  return null;
}

/**
 * The registry's own capability probe, keyed by agent id.
 *
 * Best-effort and shape-checked: the file lives in a dot-directory covered by
 * neither published schema, so anything that is not the expected object is
 * dropped per agent rather than trusted or fatal. Returns `[byId, provenance]`,
 * both empty when there is nothing readable.
 */
async function protocolMatrix() {
  let raw;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/.protocol-matrix/latest.json`);
    if (!r.ok) throw new Error(String(r.status));
    raw = await r.json();
  } catch (e) {
    return [{}, null, `no readable protocol matrix (${e})`];
  }
  if (!Array.isArray(raw?.agents)) return [{}, null, "protocol matrix carries no agents array"];

  const byId = {};
  let skipped = 0;
  for (const a of raw.agents) {
    const caps = a?.capabilities;
    if (typeof a?.id !== "string" || typeof caps !== "object" || caps === null) {
      skipped++;
      continue;
    }
    const flag = (k) => (typeof caps[k] === "boolean" ? caps[k] : null);
    byId[a.id] = {
      initialize: typeof a.initialize?.status === "string" ? a.initialize.status : null,
      protocol_version: typeof a.protocolVersion === "number" ? a.protocolVersion : null,
      load_session: flag("loadSession"),
      session_list: flag("sessionList"),
      session_fork: flag("sessionFork"),
      session_resume: flag("sessionResume"),
      session_stop: flag("sessionStop"),
      set_model: flag("setModel"),
    };
  }
  const provenance = {
    source: `https://github.com/${REPO}/blob/main/.protocol-matrix/latest.json`,
    probed_on: typeof raw.date === "string" ? raw.date : null,
    agents_probed: Object.keys(byId).length,
  };
  return [byId, provenance, skipped ? `${skipped} matrix rows had no readable capabilities` : null];
}

async function build() {
  const head = await gh("commits/main");
  const listing = await gh("contents/");
  const dirs = listing.filter((e) => e.type === "dir" && !e.name.startsWith("."));

  // The upstream's own list of agents that do not work, and why.
  let quarantine = {};
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/quarantine.json`);
    if (r.ok) quarantine = await r.json();
  } catch {
    // A registry that stops publishing one is not a reason to fail; the entries
    // are still labelled untested either way.
  }

  const [matrix, matrixSource, matrixNote] = await protocolMatrix();

  const entries = [];
  const dropped = [];
  if (matrixNote) dropped.push(matrixNote);
  for (const dir of dirs) {
    if (quarantine[dir.name]) {
      dropped.push(`${dir.name} (quarantined upstream: ${quarantine[dir.name]})`);
      continue;
    }
    let agent;
    try {
      const file = await fetch(
        `https://raw.githubusercontent.com/${REPO}/main/${dir.name}/agent.json`,
      );
      if (!file.ok) throw new Error(String(file.status));
      agent = await file.json();
    } catch {
      dropped.push(`${dir.name} (no readable agent.json)`);
      continue;
    }
    const launch = launchOf(agent.distribution);
    if (!launch) {
      dropped.push(`${agent.id ?? dir.name} (no npx, uvx or binary distribution)`);
      continue;
    }
    const id = agent.id ?? dir.name;
    entries.push({
      id,
      label: agent.name ?? agent.id ?? dir.name,
      description: agent.description ?? "",
      // The version the *registry* pins, which is not a version Sway measured
      // anything against. Kept because it is what an npx entry actually runs.
      registry_version: agent.version ?? null,
      website: agent.website ?? agent.repository ?? null,
      ...launch,
      // Whose measurement this is, said in the field name. Never folded into a
      // tier of Sway's own.
      published_capabilities: matrix[id] ?? null,
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));

  return {
    // Provenance. The commit is what `--check` compares, so "has upstream
    // moved" is answerable without diffing every entry.
    source: `https://github.com/${REPO}`,
    registry_commit: head.sha,
    generated_on: head.commit?.committer?.date?.slice(0, 10) ?? null,
    generated_by: "dev/acp-catalog.mjs",
    // Null when the dot-directory was missing or reshaped, which is what tells
    // the UI to say nothing about capabilities rather than say nothing about
    // where its claims came from.
    matrix_source: matrixSource,
    entries,
    // Committed, so the shortfall against the upstream is visible rather than
    // inferred from a count.
    quarantined: quarantine,
    _dropped: dropped,
  };
}

const catalog = await build();
const { _dropped: dropped, ...committed } = catalog;
const json = `${JSON.stringify(committed, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = readFileSync(OUT, "utf8");
  const same = JSON.parse(existing).registry_commit === committed.registry_commit;
  console.log(
    same
      ? `up to date at registry commit ${committed.registry_commit.slice(0, 8)}`
      : `STALE: committed ${JSON.parse(existing).registry_commit.slice(0, 8)}, upstream ${committed.registry_commit.slice(0, 8)}, re-run without --check`,
  );
  process.exitCode = same ? 0 : 1;
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${committed.entries.length} entries to ${OUT}`);
  console.log(`registry commit ${committed.registry_commit.slice(0, 8)} (${committed.generated_on})`);
  const installable = committed.entries.filter((e) => e.builds).length;
  const unsigned = committed.entries.filter(
    (e) => e.builds && Object.values(e.builds).some((b) => !b.sha256),
  ).length;
  // Printed because it is the trust story in one line: how many agents Sway
  // would download, and how many of those publish nothing to check them against.
  console.log(`${installable} installable, ${unsigned} of them publishing no sha256 for some platform`);
  console.log(
    committed.matrix_source
      ? `protocol matrix: ${committed.matrix_source.agents_probed} agents, probed ${committed.matrix_source.probed_on}`
      : "protocol matrix: none read, entries carry no published capabilities",
  );
  if (dropped.length) {
    // Reported rather than silent: a catalogue that quietly covers less than the
    // upstream reads as "these are all the agents there are".
    console.log(`dropped ${dropped.length}: ${dropped.join(", ")}`);
  }
}
