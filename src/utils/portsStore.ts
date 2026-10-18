// The ports listening from each worktree on screen, from one scan shared by
// every row and panel that shows them. Rust attributes a listener to the
// deepest worktree holding its cwd, so a server shows on any port it picked.
import { createSignal, getOwner, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// A dev server prints its banner and its terminal goes quiet, so a scan this
// long after the quiet finds it listening.
const SETTLE_MS = 3_000;

const [ports, setPorts] = createSignal<Record<string, number[]>>({});
const watched = new Map<string, number>();
let started = false;
let scanning = false;
let soon: ReturnType<typeof setTimeout> | undefined;

const watchedKey = () => [...watched.keys()].join("\n");

async function scan() {
  if (scanning || watched.size === 0 || document.visibilityState === "hidden") return;
  scanning = true;
  const asked = watchedKey();
  try {
    setPorts((await invoke<Record<string, number[]>>("ports_scan", { worktrees: [...watched.keys()] })) ?? {});
  } catch (e) {
    console.warn("ports_scan failed", e);
  } finally {
    scanning = false;
  }
  // A row that mounted mid-scan was not in it.
  if (watchedKey() !== asked) scanIn(0);
}

function scanIn(ms: number) {
  clearTimeout(soon);
  soon = setTimeout(() => void scan(), ms);
}

// No timer: a scan is two `lsof` runs, so it waits for something that can
// start or stop a server rather than polling for one.
function start() {
  if (started) return;
  started = true;
  window.addEventListener("focus", () => void scan());
  document.addEventListener("visibilitychange", () => void scan());
  void listen<{ id: string; state: "active" | "quiet" }>("pty://activity", (e) => {
    if (e.payload.state === "quiet") scanIn(SETTLE_MS);
  }).catch((e) => console.warn("ports: no pty activity, scans run on the poll only", e));
  // A run command has no terminal to go quiet, so its own start and stop say when.
  void listen<{ kind: string; state: string }>("setup://changed", (e) => {
    if (e.payload.kind !== "run") return;
    if (e.payload.state === "running") scanIn(SETTLE_MS);
    else if (e.payload.state !== "stopping") scanIn(0);
  }).catch((e) => console.warn("ports: no run events, scans run on the poll only", e));
}

export function portsAt(path: string): () => number[] {
  const n = watched.get(path) ?? 0;
  watched.set(path, n + 1);
  start();
  if (n === 0) scanIn(0);
  if (getOwner()) {
    onCleanup(() => {
      const n = (watched.get(path) ?? 1) - 1;
      if (n > 0) watched.set(path, n);
      else watched.delete(path);
    });
  }
  return () => ports()[path] ?? [];
}

export const portUrl = (port: number) => `http://localhost:${port}`;

export const openPort = (port: number) => void invoke("plugin:opener|open_url", { url: portUrl(port) }).catch(() => {});
