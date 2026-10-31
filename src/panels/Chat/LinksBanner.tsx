import { For, createResource, onCleanup } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import Button from "../../components/Button/Button";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { findSession } from "../../utils/sessionStore";
import { chatCall } from "./chatCalls";
import styles from "./Chat.module.css";

export const LINKS_CHANGED = "links://changed";

export default function LinksBanner(props: { sessionId: string }) {
  const [links, { refetch }] = createResource(
    () => props.sessionId,
    (session) =>
      chatCall<string[]>("session_links_of", { session }).catch((e) => {
        emitWith<ToastEvent>(TOAST, { message: `Linked chats could not be read: ${String(e)}`, kind: "error" });
        return [];
      }),
  );
  const unlisten = listen(LINKS_CHANGED, () => void refetch());
  onCleanup(() => void unlisten.then((stop) => stop()));
  const nameOf = (id: string) => {
    const meta = findSession(id)?.session;
    return meta?.name || meta?.title || id.slice(0, 8);
  };
  const unlink = (other: string) =>
    chatCall("session_unlink", { a: props.sessionId, b: other })
      .catch((e) =>
        emitWith<ToastEvent>(TOAST, { message: `The chats were not unlinked: ${String(e)}`, kind: "error" }),
      )
      .finally(() => void refetch());
  return (
    <For each={links() ?? []}>
      {(other) => (
        <div class={`${styles.banner} ${styles.bannerQuiet}`} data-link-banner={other}>
          <span class={styles.bannerText}>Linked with {nameOf(other)}</span>
          <Button size="sm" onClick={() => unlink(other)}>
            Unlink
          </Button>
        </div>
      )}
    </For>
  );
}
