import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import Button from "../../components/Button/Button";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { findSession } from "../../utils/sessionStore";
import { chatCall } from "./chatCalls";
import styles from "./Chat.module.css";

/** Mirrors `Request` in src-tauri/src/chat_requests.rs. */
export type ChatRequest = { id: string; from: string; text: string; attach: string[]; at: number };

export const REQUESTS_CHANGED = "requests://changed";

function PendingRequest(props: { request: ChatRequest; sessionId: string; onDone: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const sender = () => {
    const meta = findSession(props.request.from)?.session;
    return meta?.name || meta?.title || props.request.from.slice(0, 8);
  };
  const act = (command: "chat_request_accept" | "chat_request_discard", failed: string) => {
    if (busy()) return;
    setBusy(true);
    chatCall<boolean>(command, { session: props.sessionId, id: props.request.id })
      .catch((e) => emitWith<ToastEvent>(TOAST, { message: `${failed}: ${String(e)}`, kind: "error" }))
      .finally(() => {
        setBusy(false);
        props.onDone();
      });
  };
  return (
    <div class={`${styles.banner} ${styles.ask}`} data-chat-request={props.request.id}>
      <span class={styles.bannerText}>
        From {sender()}: {props.request.text}
        <Show when={props.request.attach.length}>{(n) => ` (${n()} files)`}</Show>
      </span>
      <Button size="sm" disabled={busy()} onClick={() => act("chat_request_accept", "The message was not delivered")}>
        Accept
      </Button>
      <Button size="sm" disabled={busy()} onClick={() => act("chat_request_discard", "The message was not discarded")}>
        Discard
      </Button>
    </div>
  );
}

export default function PendingRequests(props: { sessionId: string }) {
  const [requests, { refetch }] = createResource(
    () => props.sessionId,
    (session) =>
      chatCall<ChatRequest[]>("chat_requests_list", { session }).catch((e) => {
        emitWith<ToastEvent>(TOAST, { message: `Waiting messages could not be read: ${String(e)}`, kind: "error" });
        return [];
      }),
  );
  const unlisten = listen<{ session: string }>(REQUESTS_CHANGED, ({ payload }) => {
    if (payload.session === props.sessionId) void refetch();
  });
  onCleanup(() => void unlisten.then((stop) => stop()));
  return (
    <For each={requests() ?? []}>
      {(request) => <PendingRequest request={request} sessionId={props.sessionId} onDone={() => void refetch()} />}
    </For>
  );
}
