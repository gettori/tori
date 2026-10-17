// The ports listening from each worktree on screen, from one scan shared by
// every row and panel that shows them. Rust attributes a listener to the
// deepest worktree holding its cwd, so a server shows on any port it picked.
import { createSignal, getOwner, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const POLL_MS = 30_000;
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

function start() {
  if (started) return;
  started = true;
  setInterval(() => void scan(), POLL_MS);
  window.addEventListener("focus", () => void scan());
  document.addEventListener("visibilitychange", () => void scan());
  void listen<{ id: string; state: "active" | "quiet" }>("pty://activity", (e) => {
    if (e.payload.state === "quiet") scanIn(SETTLE_MS);
  }).catch((e) => console.warn("ports: no pty activity, scans run on the poll only", e));
}

export function portsAt(path: string): () => number[] {
  watched.set(path, (watched.get(path) ?? 0) + 1);
  start();
  scanIn(0);
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
