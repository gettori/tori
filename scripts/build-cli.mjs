#!/usr/bin/env node
// Build `tori-cli` as `src-tauri/binaries/tori-cli-<triple>[.exe]`, the name
// Tauri's `externalBin` wants. Windows only: the app there is a GUI exe with no
// console. Tauri's before commands set TAURI_ENV_TARGET_TRIPLE and TAURI_ENV_DEBUG.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "src-tauri");

const host = () =>
  execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split("\n")
    .find((line) => line.startsWith("host: "))
    .slice("host: ".length)
    .trim();

const native = host();
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || native;
const release = process.env.TAURI_ENV_DEBUG === "false";
const exe = triple.includes("windows") ? ".exe" : "";

const out = path.join(crate, "binaries", `tori-cli-${triple}${exe}`);

// The crate's build script copies the sidecar and fails when it is missing,
// and this build is the one that makes it. A placeholder breaks the cycle and
// is overwritten below.
if (!fs.existsSync(out)) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "");
}

// No `--target` for the host, so this shares `target/debug` with the app build
// instead of compiling every dependency a second time.
const args = ["build", "--bin", "tori-cli", "--manifest-path", path.join(crate, "Cargo.toml")];
if (triple !== native) args.push("--target", triple);
if (release) args.push("--release");
execFileSync("cargo", args, { stdio: "inherit" });

const profile = release ? "release" : "debug";
const built = path.join(crate, "target", ...(triple === native ? [] : [triple]), profile, `tori-cli${exe}`);
fs.copyFileSync(built, out);
console.log(`cli:build: ${path.relative(root, out)}`);
