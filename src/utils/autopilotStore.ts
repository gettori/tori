import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSignal } from "solid-js";
import type {
  ActivityItem,
  AutopilotError,
  AutopilotState,
  AutopilotView,
  Decision,
  DecisionAction,
  ThreadMessage,
} from "../components/Autopilot/autopilot";
import type { ChatEvent } from "./chatTypes";
import { pushToast } from "../components/Toasts/Toasts";
import { on, TOGGLE_AUTOPILOT_POPUP, TOGGLE_AUTOPILOT_VIEW } from "./events";
import { allAsks, answerAsk, type SocketAsk } from "./socketAsks";
import { activityOf, decisionOf, type AutopilotEvent, type Hold, type ItemRow } from "./autopilotRows";
import { findSession } from "./sessionStore";
import { toriNote } from "./toriNote";

/** Mirrors `Status` in src-tauri/src/rpc/runner.rs. */
export type RunnerStatus = {
  state: "off" | "starting" | "idle" | "working" | "error";
  session: string | null;
  agent: string | null;
  cwd: string | null;
  error: AutopilotError | null;
};

const OFF: RunnerStatus = {
  state: "off",
  session: null,
  agent: null,
  cwd: null,
  error: null,
};

const [runner, setRunner] = createSignal<RunnerStatus>(OFF);
export { runner };

const [view, setView] = createSignal<AutopilotView>("workspace");
const [popupOpen, setPopupOpen] = createSignal(false);
export { view, setView, popupOpen, setPopupOpen };

/** Whether a view can attach to the session: it exists once a turn has started,
 *  and attaching before that would spawn a second child on the same id. */
export const attachable = (s: RunnerStatus) =>
  s.session !== null && (s.state === "idle" || s.state === "working");

const THREAD_KEPT = 6;

/** The conversation as the popup's short thread: the brief (the first message)
 *  left out, each turn's text joined, only the last few. */
export function threadFrom(events: ChatEvent[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  let reply: ThreadMessage | null = null;
  for (const e of events) {
    if (e.type === "userMessage") {
      reply = null;
      if (toriNote(e.blocks)) continue;
      const text = e.blocks
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n");
      if (text) out.push({ from: "me", text });
    } else if (e.type === "textDelta" && e.agentId === null) {
      if (!reply) {
        reply = { from: "autopilot", text: "" };
        out.push(reply);
      }
      reply.text += e.text;
    }
  }
  return out.slice(-THREAD_KEPT);
}

const [thread, setThread] = createSignal<ThreadMessage[]>([]);
export { thread };

export async function loadThread() {
  const s = runner();
  if (!s.session || !s.agent) return setThread([]);
  const events = await invoke<ChatEvent[]>("chat_history", {
    sessionId: s.session,
    fromSessionId: null,
    agentId: s.agent,
    upToPromptTs: null,
  }).catch(() => []);
  setThread(threadFrom(events));
}

/** Say something to the autopilot from outside its chat view; into the running turn if there is one. */
export async function sendToAutopilot(text: string) {
  const s = runner();
  if (!s.session || !text.trim()) return;
  const blocks = [{ type: "text", text }];
  await invoke(s.state === "working" ? "chat_steer" : "chat_send", {
    sessionId: s.session,
    blocks,
  });
}

const [items, setItems] = createSignal<ItemRow[]>([]);
const [holds, setHolds] = createSignal<Hold[]>([]);
const [activity, setActivity] = createSignal<ActivityItem[]>([]);
export { items, activity };

const ACTIVITY_KEPT = 50;

// Newest first; the log read at start is older than anything that arrived live meanwhile.
function addActivity(events: AutopilotEvent[], older = false) {
  const lines = events.flatMap((e) => activityOf(e, items()) ?? []).reverse();
  setActivity((prev) => (older ? [...prev, ...lines] : [...lines, ...prev]).slice(0, ACTIVITY_KEPT));
}

let firstLive: number | null = null;

function applyChange(e: AutopilotEvent) {
  firstLive ??= e.ts;
  const item = e.item;
  if (item) setItems((prev) => (prev.some((i) => i.id === item.id) ? prev.map((i) => (i.id === item.id ? item : i)) : [...prev, item]));
  const hold = e.hold;
  if (hold) setHolds((prev) => [...prev.filter((h) => h.ask !== hold.ask), ...(e.cleared ? [] : [hold])]);
  addActivity([e]);
}

async function loadAutopilot() {
  const state = await invoke<{ items: ItemRow[]; holds: Hold[] }>("autopilot_state").catch(() => null);
  if (state) {
    setItems(state.items);
    setHolds(state.holds);
  }
  const logged = await invoke<AutopilotEvent[]>("autopilot_log", { limit: ACTIVITY_KEPT }).catch(() => []);
  // A line at or after the first live event was already added by it.
  addActivity(logged.filter((e) => firstLive === null || e.ts < firstLive), true);
}

let started = false;

export function watchAutopilot() {
  if (started) return;
  started = true;
  on(TOGGLE_AUTOPILOT_VIEW, () => {
    setPopupOpen(false);
    setView(view() === "autopilot" ? "workspace" : "autopilot");
  });
  on(TOGGLE_AUTOPILOT_POPUP, () => view() === "workspace" && setPopupOpen(!popupOpen()));
  void listen<RunnerStatus>("autopilot://status", (e) =>
    setRunner(e.payload),
  ).catch(() => {});
  void invoke<RunnerStatus>("autopilot_status")
    .then(setRunner)
    .catch(() => {});
  void listen<AutopilotEvent>("autopilot://changed", (e) => applyChange(e.payload)).catch(() => {});
  void loadAutopilot();
}

/** What waits on the user: every hold, and any other card shown in the autopilot's chat. */
export function decisionsFor(
  asks: SocketAsk[],
  session: string | null,
): SocketAsk[] {
  return asks.filter(
    (a) =>
      a.item !== undefined ||
      (session !== null && (a.shown_in ?? [a.session]).includes(session)),
  );
}

export function autopilotState(
  status: RunnerStatus,
  decisions: number,
): AutopilotState {
  switch (status.state) {
    case "off":
      return "off";
    case "error":
      return "error";
    case "starting":
    case "working":
      return decisions > 0 ? "needs" : "working";
    case "idle":
      return decisions > 0 ? "needs" : "idle";
  }
}

export const decisions = () => decisionsFor(allAsks(), runner().session);
export const autopilotNow = () => autopilotState(runner(), decisions().length);

const askerName = (session: string) => {
  const meta = findSession(session)?.session;
  return meta?.name || meta?.title || session.slice(0, 8);
};

export const decisionCards = (): Decision[] => decisions().map((a) => decisionOf(a, items(), holds(), askerName));

const openView = () => {
  setPopupOpen(false);
  setView("autopilot");
};

// Only an approval has a known yes and no; a question, or an edit or reply,
// goes to the view's chat, where the card takes words.
export function decide(action: DecisionAction, decision: Decision) {
  const ask = allAsks().find((a) => a.id === decision.id);
  if (!ask) return;
  const answer = !ask.approval ? undefined : action === "approve" ? "Approve" : action === "dismiss" ? "Reject" : undefined;
  if (answer === undefined) return openView();
  answerAsk(ask.id, answer).catch((e) => pushToast(`The answer did not reach the asker: ${String(e)}`));
}

// The answer is not applied: `autopilot://status` carries every change, and a
// late reply could overwrite a newer one.
export async function startAutopilot() {
  await invoke("autopilot_start").catch((e) => pushToast(`The autopilot did not start: ${String(e)}`));
}

export async function stopAutopilot() {
  await invoke("autopilot_stop").catch((e) => pushToast(`The autopilot did not stop: ${String(e)}`));
}
