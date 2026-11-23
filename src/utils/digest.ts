import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { kindLabel, type NeedsYouEvent, type NeedsYouKind } from "./needsYouSignals";

/** Mirrors `Verdict` in src-tauri/src/chat/model.rs. */
export type Verdict = "verified" | "failed" | "unverified";

/** Mirrors `Finished` in src-tauri/src/digest.rs. */
export type Finished = {
  session: string;
  folder: string;
  branch: string | null;
  project: string;
  title: string;
  chat: boolean;
  turns: number;
  firstTs: number;
  lastTs: number;
  lines: { added: number; removed: number } | null;
  verdict: Verdict | null;
};

/** Mirrors `Digest` in src-tauri/src/digest.rs. */
export type Digest = {
  since: number;
  asOf: number;
  ready: boolean;
  finished: Finished[];
  waiting: NeedsYouEvent[];
  happened: NeedsYouEvent[];
};

export const digestCount = (d: Digest | null) => (d ? d.finished.length + d.waiting.length + d.happened.length : 0);

const LIMITS: readonly NeedsYouKind[] = ["limitHit", "limitResumed"];
export const isLimit = (e: NeedsYouEvent) => LIMITS.includes(e.kind);

const VERDICTS: Record<Verdict, string> = {
  verified: "Verified",
  failed: "Checks failed",
  unverified: "Not verified",
};

export const verdictLabel = (v: Verdict) => VERDICTS[v];

export function digestTime(ts: number, now = Date.now()) {
  const at = new Date(ts);
  const clock = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => d.toDateString();
  const today = new Date(now);
  if (day(at) === day(today)) return clock;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day(at) === day(yesterday)) return `Yesterday ${clock}`;
  return `${at.toLocaleDateString([], { weekday: "short" })} ${clock}`;
}

/** The facts under a finished session's title, shared by the desktop and the phone. */
export function finishedParts(f: Finished, now = Date.now()): string[] {
  const parts = [f.turns === 1 ? "1 turn" : `${f.turns} turns`];
  if (f.lines) parts.push(`+${f.lines.added} -${f.lines.removed}`);
  if (f.verdict) parts.push(VERDICTS[f.verdict]);
  parts.push(digestTime(f.lastTs, now));
  return parts;
}

/** The facts under a pull request or limit row. */
export const happenedParts = (e: NeedsYouEvent, now = Date.now()) => [kindLabel(e.kind), digestTime(e.ts, now)];

const [digest, setDigest] = createSignal<Digest | null>(null);
export { digest };

// While the tab shows, its start stays where it opened, so reading it does not
// empty it under you.
let pinned: number | undefined;
let shown = false;
let request = 0;

export async function refreshDigest(): Promise<Digest | null> {
  const mine = ++request;
  const d = (await invoke<Digest>("digest_list", { since: shown ? pinned : undefined }).catch(() => null)) ?? null;
  if (d && mine === request) {
    setDigest(d);
    if (shown && pinned === undefined) pinned = d.since;
  }
  return d;
}

function looked() {
  const d = digest();
  if (!shown || !d) return;
  void invoke("digest_looked", { at: d.asOf })
    .catch(() => {})
    .then(() => {
      if (!shown) void refreshDigest();
    });
}

export function showDigest() {
  shown = true;
  pinned = undefined;
  void refreshDigest();
}

export function hideDigest() {
  looked();
  shown = false;
  pinned = undefined;
}

let started = false;

export function watchDigest() {
  if (started) return;
  started = true;
  void listen("needs-you://changed", () => {
    if (shown) void refreshDigest();
  });
  void refreshDigest();
  window.addEventListener("blur", looked);
}
