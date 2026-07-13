import { createSignal, onMount, onCleanup, Show, createEffect } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";

// The in-app credential dialog for the askpass bridge. A backgrounded git op
// (fetch/pull/push) that needs a credential emits `askpass://prompt` per field;
// this listens, QUEUES the prompts so concurrent/sequential requests each show
// in turn, and relays the answer back via `askpass_respond`.
//
// git asks per field as separate processes ("Username for ..." then
// "Password for ..."), so cancelling the username prompt must abort the whole
// op: passing null to `askpass_respond` latches the op's cancel, so its
// remaining field prompts auto-return empty (no second dialog) and git aborts.
//
// Mounted once, app-wide (not tied to a selection), so any git surface reuses it.

type Prompt = { id: number; op_id: string; prompt: string; kind: string };

export default function AskpassDialog() {
  const [queue, setQueue] = createSignal<Prompt[]>([]);
  const [value, setValue] = createSignal("");
  let input: HTMLInputElement | undefined;

  const current = () => queue()[0];

  // Reset the input and focus it whenever a new prompt reaches the front.
  createEffect(() => {
    const c = current();
    if (c) {
      setValue("");
      requestAnimationFrame(() => input?.focus());
    }
  });

  function dequeue() {
    setQueue((q) => q.slice(1));
  }

  function submit() {
    const c = current();
    if (!c) return;
    invoke("askpass_respond", { id: c.id, value: value() }).catch(() => {});
    dequeue();
  }

  function cancel() {
    const c = current();
    if (!c) return;
    // null => cancel the whole op (latches so sibling field prompts auto-empty).
    invoke("askpass_respond", { id: c.id, value: null }).catch(() => {});
    dequeue();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await listen<Prompt>("askpass://prompt", (e) => {
      setQueue((q) => [...q, e.payload]);
    });
  });
  onCleanup(() => unlisten?.());

  return (
    <Show when={current()}>
      {(c) => (
        <Portal>
          <div class={styles.modalBackdrop} onMouseDown={() => cancel()}>
            <div class={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
              <div class={styles.modalTitle}>{c().prompt}</div>
              <input
                ref={input}
                class={styles.modalInput}
                type={c().kind === "password" ? "password" : "text"}
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value)}
                onKeyDown={onKeyDown}
              />
              <Show when={c().kind === "password"}>
                <div class={styles.modalHint}>
                  HTTPS wants a personal access token, not your account password.
                </div>
              </Show>
              <div class={styles.modalActions}>
                <Button onClick={() => cancel()}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => submit()}>
                  OK
                </Button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}
