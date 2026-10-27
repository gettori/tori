import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setView } from "./autopilotStore";
import { setPendingReveal } from "./checkpointReveal";
import { refreshDigest } from "./digest";
import {
  emitWith,
  NAVIGATE,
  on,
  OPEN_DIGEST,
  OPEN_INBOX,
  SET_RIGHT_MODE,
  TOAST,
  TOGGLE_AUTOPILOT_VIEW,
  TOGGLE_INBOX,
  type NavTarget,
  type SetRightMode,
  type ToastEvent,
} from "./events";
import type { ReviewItem } from "./reviewSignals";

export type InboxTab = "since" | "needsYou" | "permissions" | "review";

const [inboxOpen, setInboxOpen] = createSignal(false);
const [reviewItems, setReviewItems] = createSignal<ReviewItem[]>([]);
// The tab the next opening asks for, read once by the Inbox as it mounts.
const [askedTab, setAskedTab] = createSignal<InboxTab | null>(null);
export { inboxOpen, setInboxOpen, reviewItems, askedTab, setAskedTab };

export function openInbox(tab: InboxTab | null = null) {
  setAskedTab(tab);
  setView("workspace");
  setInboxOpen(true);
  void refreshInbox();
  void refreshDigest();
}

// Refreshes overlap while an agent writes, and an older answer must not land
// over a newer one.
let request = 0;

export async function refreshInbox() {
  const mine = ++request;
  const items = await invoke<ReviewItem[]>("review_inbox").catch(() => null);
  if (items && mine === request) setReviewItems(items);
}

// Resolves once the mark is stored, not once the list is rebuilt: a rebuild
// can take seconds, and the row is gone either way.
export async function markReviewed(item: ReviewItem) {
  try {
    await invoke("review_mark", { unit: item.unit, toTs: item.toTs });
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
    void refreshInbox();
    return;
  }
  // Outdates any list already in flight, which would bring the row back.
  request++;
  setReviewItems((items) => items.filter((i) => i.unit.id !== item.unit.id));
  void refreshInbox();
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
    if (inboxOpen()) setInboxOpen(false);
    else openInbox();
  });
  on(OPEN_DIGEST, () => openInbox("since"));
  on(OPEN_INBOX, () => openInbox());
  on(TOGGLE_AUTOPILOT_VIEW, () => setInboxOpen(false));
  on(NAVIGATE, () => setInboxOpen(false));
  // fs://changed covers a commit or push in a watched worktree, which can take
  // a row off the list without any session moving. radar://changed is a base
  // or another worktree moving, which re-ranks rows nobody here touched.
  for (const name of [
    "sessions://changed",
    "settings://changed",
    "review://changed",
    "fs://changed",
    "radar://changed",
    "second-opinion://changed",
  ]) {
    void listen(name, refreshSoon);
  }
  void refreshInbox();
}
