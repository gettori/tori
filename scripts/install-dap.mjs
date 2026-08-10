#!/usr/bin/env node
// Fetch the pinned debug adapter into `src-tauri/resources/dap/`.
//
// The LSP side gets its servers from npm, so `lsp:install` is one `npm install`
// and the lockfile carries the integrity check. vscode-js-debug is not on npm
// at all: it ships as a GitHub release tarball, so the pinning that a lockfile
// would have done has to happen here, against a sha256 in `manifest.json`.
//
// The manifest is also where this build step keeps the two facts the Rust host
// and the frontend router *assume* about the bundle, and both are asserted on
// every run rather than at the moment of the version bump:
//
//   - `expect.readiness`, the line the adapter prints once it is listening. The
//     host does not gate on it (it retries the connect instead, because the
//     string is unversioned English), but it is logged for diagnostics, and a
//     reworded line should be a decision rather than a surprise.
//   - `expect.reverseRequests`, every request the adapter can send *at* us.
//     Nothing in js-debug gates these on a client capability, so an unanswered
//     one is a session that hangs with no error anywhere. A version that adds a
//     fifth must fail here, loudly, and not at runtime in front of a user.
//
// Assertions run even when the download is skipped, so doctoring the extracted
// tree is caught too.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAP_DIR = path.join(ROOT, "src-tauri", "resources", "dap");
const MANIFEST = path.join(DAP_DIR, "manifest.json");
const STAMP = path.join(DAP_DIR, ".installed");

const die = (msg) => {
  console.error(`dap:install: ${msg}`);
  process.exit(1);
};

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const entryPath = path.join(DAP_DIR, manifest.entry);

/** Every `.js` file in the extracted bundle. */
function bundleFiles(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) bundleFiles(p, out);
    else if (item.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * Reverse-request names discovered *structurally*, so a name nobody thought to
 * look for still shows up.
 *
 * js-debug calls a client-bound request as `<dapApi>.<name>Request(...)`, so
 * every `xxxRequest(` call site is a candidate. A grep for a hard-coded list of
 * known names could only ever detect a rename or a removal, never the case that
 * actually matters, which is a bumped version adding a sixth.
 *
 * The bundle's own internal methods also end in `Request`, so the manifest
 * carries an explicit ignore list. That list is deliberately not a regex or a
 * heuristic: an unrecognised name fails the install, and resolving it means
 * deciding whether it is a new reverse request (write a handler) or another
 * internal method (add it to `internalRequestMethods`). A noisy failure on a
 * version bump is the cheap outcome; a missed reverse request is a session that
 * hangs in front of a user with no error anywhere.
 */
function discoverReverseRequests() {
  const internal = new Set(manifest.expect.internalRequestMethods);
  const found = new Set();
  for (const file of bundleFiles(path.join(DAP_DIR, "js-debug"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/([a-zA-Z0-9_]+)Request\(/g)) {
      if (!internal.has(m[1])) found.add(m[1]);
    }
  }
  return found;
}

/** Everything downstream assumes about the bundle, checked against the bundle. */
function assertBundleMatchesManifest() {
  if (!fs.existsSync(entryPath)) {
    die(`${manifest.entry} is missing after install`);
  }
  const entry = fs.readFileSync(entryPath, "utf8");

  if (!entry.includes(manifest.expect.readiness)) {
    die(
      `the adapter no longer prints ${JSON.stringify(manifest.expect.readiness)}.\n` +
        `  js-debug ${manifest.version} changed its readiness line. The Rust host retries the\n` +
        `  connect rather than parsing this, so nothing is broken, but update\n` +
        `  manifest.json's expect.readiness deliberately.`
    );
  }

  const expected = [...manifest.expect.reverseRequests].sort();
  const actual = [...discoverReverseRequests()].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const added = actual.filter((n) => !expected.includes(n));
    const gone = expected.filter((n) => !actual.includes(n));
    die(
      `the adapter's reverse requests changed.\n` +
        (added.length ? `  new:     ${added.join(", ")}\n` : "") +
        (gone.length ? `  missing: ${gone.join(", ")}\n` : "") +
        `  expected: ${expected.join(", ")}\n` +
        `  found:    ${actual.join(", ") || "(none)"}\n` +
        `  Every reverse request needs a handler in the frontend router; js-debug gates\n` +
        `  none of them on a client capability, so an unanswered one hangs the session\n` +
        `  with no error. Add the handler first, then update manifest.json. If a new name\n` +
        `  is an internal method rather than a request to us, add it to\n` +
        `  expect.internalRequestMethods.`
    );
  }
}

function installedVersion() {
  try {
    return fs.readFileSync(STAMP, "utf8").trim();
  } catch {
    return null;
  }
}

function download() {
  const tmp = path.join(os.tmpdir(), `sway-dap-${process.pid}.tar.gz`);
  console.log(`dap:install: fetching js-debug ${manifest.version}`);
  execFileSync("curl", ["-sSfL", manifest.url, "-o", tmp], { stdio: ["ignore", "inherit", "inherit"] });

  const actual = createHash("sha256").update(fs.readFileSync(tmp)).digest("hex");
  if (actual !== manifest.sha256) {
    fs.rmSync(tmp, { force: true });
    die(
      `sha256 mismatch for ${manifest.url}\n` +
        `  expected ${manifest.sha256}\n` +
        `  got      ${actual}`
    );
  }

  fs.rmSync(path.join(DAP_DIR, "js-debug"), { recursive: true, force: true });
  fs.mkdirSync(DAP_DIR, { recursive: true });
  execFileSync("tar", ["xzf", tmp, "-C", DAP_DIR], { stdio: "inherit" });
  fs.rmSync(tmp, { force: true });
}

const force = process.argv.includes("--force");
if (force || installedVersion() !== manifest.version || !fs.existsSync(entryPath)) {
  download();
  fs.writeFileSync(STAMP, `${manifest.version}\n`);
} else {
  console.log(`dap:install: js-debug ${manifest.version} already installed`);
}

assertBundleMatchesManifest();
console.log(`dap:install: js-debug ${manifest.version} ok`);
