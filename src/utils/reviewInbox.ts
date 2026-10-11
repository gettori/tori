import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setView } from "./autopilotStore";
import { setPendingReveal } from "./checkpointReveal";
import {
  emitWith,
  NAVIGATE,
  on,
  SET_RIGHT_MODE,
  TOAST,
  TOGGLE_AUTOPILOT_VIEW,
  TOGGLE_INBOX,
  type NavTarget,
  type SetRightMode,
  type ToastEvent,
} from "./events";

/** Mirrors `ReviewUnit` in src-tauri/src/review.rs. */
export type ReviewUnit = { kind: "session"; id: string };

/** Mirrors `SignalKind` in src-tauri/src/review.rs. */
export type SignalKind =
  | "lines"
  | "secretRead"
  | "failed"
  | "blindEdit"
  | "unverified"
  | "deletedTests"
  | "sensitivePath"
  | "dependencies"
  | "outsideScope"
  | "sharedFile"
  | "noCheckpoints";

export type ReviewSignal = { kind: SignalKind; count: number; points: number };

/** Mirrors `ReviewItem` in src-tauri/src/review.rs. */
export type ReviewItem = {
  unit: ReviewUnit;
  project: string;
  folder: string;
  agent: string;
  title: string;
  summary: string | null;
  score: number;
  signals: ReviewSignal[];
  fromTs: number | null;
  toTs: number;
  running: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function signalLabel(signal: ReviewSignal): string {
  switch (signal.kind) {
    case "lines":
      return plural(signal.count, "line");
    case "secretRead":
      return `Secret read in ${plural(signal.count, "turn")}`;
    case "failed":
      return `Checks failed in ${plural(signal.count, "turn")}`;
    case "blindEdit":
      return `${plural(signal.count, "edit")} without reading`;
    case "unverified":
      return plural(signal.count, "unverified turn");
    case "deletedTests":
      return `${plural(signal.count, "test file")} deleted`;
    case "sensitivePath":
      return plural(signal.count, "CI, auth or secret file");
    case "dependencies":
      return `${plural(signal.count, "manifest or lockfile", "manifests or lockfiles")} changed`;
    case "outsideScope":
      return `${plural(signal.count, "file")} outside the named folders`;
    case "sharedFile":
      return `${plural(signal.count, "file")} shared with another session`;
    case "noCheckpoints":
      return "No checkpoints";
  }
}

const [inboxOpen, setInboxOpen] = createSignal(false);
const [reviewItems, setReviewItems] = createSignal<ReviewItem[]>([]);
export { inboxOpen, setInboxOpen, reviewItems };

// Refreshes overlap while an agent writes, and an older answer must not land
// over a newer one.
let request = 0;

export async function refreshInbox() {
  const mine = ++request;
  const items = await invoke<ReviewItem[]>("review_inbox").catch(() => null);
  if (items && mine === request) setReviewItems(items);
}

export async function markReviewed(item: ReviewItem) {
  try {
    await invoke("review_mark", { unit: item.unit, toTs: item.toTs });
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
  }
  await refreshInbox();
}

/** Go to the session and open its first unreviewed turn in Checkpoints. */
export function openItem(item: ReviewItem) {
  setInboxOpen(false);
  emitWith<NavTarget>(NAVIGATE, { folder: item.folder, session: item.unit.id });
  emitWith<SetRightMode>(SET_RIGHT_MODE, { mode: "changes" });
  if (item.fromTs != null) setPendingReveal({ sessionId: item.unit.id, promptTs: item.fromTs });
}

const REFRESH_DELAY_MS = 2000;
let timer: ReturnType<typeof setTimeout> | undefined;
function refreshSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => void refreshInbox(), REFRESH_DELAY_MS);
}

let started = false;

export function watchInbox() {
  if (started) return;
  started = true;
  on(TOGGLE_INBOX, () => {
    const opening = !inboxOpen();
    setInboxOpen(opening);
    if (opening) {
      setView("workspace");
      void refreshInbox();
    }
  });
  on(TOGGLE_AUTOPILOT_VIEW, () => setInboxOpen(false));
  on(NAVIGATE, () => setInboxOpen(false));
  // fs://changed covers a commit or push in a watched worktree, which can take
  // a row off the list without any session moving.
  for (const name of ["sessions://changed", "settings://changed", "review://changed", "fs://changed"]) {
    void listen(name, refreshSoon);
  }
  void refreshInbox();
}
