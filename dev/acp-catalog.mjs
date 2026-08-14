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
 * `binary` is taken as **the basename of the registry's `cmd`**, and this is the
 * one place the catalogue makes an assumption. The registry describes an archive
 * to download and a path inside it (`./dist-package/cursor-agent`); Sway does not
 * download or extract anything, so what it can offer is the same command for a
 * user who installed the agent themselves and has it on their PATH. That
 * assumption is recorded as `needs: "on-path"` so the UI can say so rather than
 * implying Sway will fetch it.
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
    // Any platform's entry describes the same command; prefer this machine's
    // family so a `.cmd` suffix from a Windows entry never leaks into the args.
    const entry =
      binary["darwin-aarch64"] ?? binary["darwin-x86_64"] ?? binary["linux-x86_64"] ?? Object.values(binary)[0];
    if (!entry?.cmd) return null;
    const program = entry.cmd.split(/[\\/]/).pop();
    if (!program) return null;
    return { program, args: entry.args ?? [], needs: "on-path" };
  }
  return null;
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

  const entries = [];
  const dropped = [];
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
    entries.push({
      id: agent.id ?? dir.name,
      label: agent.name ?? agent.id ?? dir.name,
      description: agent.description ?? "",
      // The version the *registry* pins, which is not a version Sway measured
      // anything against. Kept because it is what an npx entry actually runs.
      registry_version: agent.version ?? null,
      website: agent.website ?? agent.repository ?? null,
      ...launch,
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
      : `STALE: committed ${JSON.parse(existing).registry_commit.slice(0, 8)}, upstream ${committed.registry_commit.slice(0, 8)} — re-run without --check`,
  );
  process.exitCode = same ? 0 : 1;
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${committed.entries.length} entries to ${OUT}`);
  console.log(`registry commit ${committed.registry_commit.slice(0, 8)} (${committed.generated_on})`);
  if (dropped.length) {
    // Reported rather than silent: a catalogue that quietly covers less than the
    // upstream reads as "these are all the agents there are".
    console.log(`dropped ${dropped.length}: ${dropped.join(", ")}`);
  }
}
