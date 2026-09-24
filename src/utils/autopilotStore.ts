import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSignal } from "solid-js";
import type {
  AutopilotError,
  AutopilotState,
  AutopilotView,
  ThreadMessage,
} from "../components/Autopilot/autopilot";
import type { ChatEvent } from "./chatTypes";
import { pushToast } from "../components/Toasts/Toasts";
import { on, TOGGLE_AUTOPILOT_POPUP, TOGGLE_AUTOPILOT_VIEW } from "./events";
import { allAsks, type SocketAsk } from "./socketAsks";

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
  let seenBrief = false;
  let reply: ThreadMessage | null = null;
  for (const e of events) {
    if (e.type === "userMessage") {
      reply = null;
      if (!seenBrief) {
        seenBrief = true;
        continue;
      }
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

// The answer is not applied: `autopilot://status` carries every change, and a
// late reply could overwrite a newer one.
export async function startAutopilot() {
  await invoke("autopilot_start").catch((e) => pushToast(`The autopilot did not start: ${String(e)}`));
}

export async function stopAutopilot() {
  await invoke("autopilot_stop").catch((e) => pushToast(`The autopilot did not stop: ${String(e)}`));
}
