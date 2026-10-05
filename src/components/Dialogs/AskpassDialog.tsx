import { createSignal, onMount, onCleanup, Show, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

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
//
// The shell is `Dialog`, driven by `open` rather than by a `<Show>` around the
// whole thing, so the panel stays mounted while the queue drains and the second
// field prompt does not tear down and rebuild the modal. That is also why the
// body keeps its own `<Show>`: `open` is a boolean, but the body still needs a
// non-null prompt to read. Enter and the reset-and-refocus effect stay here
// (`initialFocus` fires once, on open, and the second prompt arrives with the
// dialog already open); Escape does not, since Kobalte reports it as `onClose`.

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
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit();
  }

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await listen<Prompt>("askpass://prompt", (e) => {
      setQueue((q) => [...q, e.payload]);
    });
  });
  onCleanup(() => unlisten?.());

  return (
    <Dialog
      open={!!current()}
      title={current()?.prompt ?? ""}
      onClose={() => cancel()}
      initialFocus={() => input}
      actions={
        <>
          <Button onClick={() => cancel()}>Cancel</Button>
          <Button variant="primary" onClick={() => submit()}>
            OK
          </Button>
        </>
      }
    >
      <Show when={current()}>
        {(c) => (
          <>
            <input
              ref={input}
              class={styles.input}
              aria-label={c().prompt}
              type={c().kind === "password" ? "password" : "text"}
              value={value()}
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <Show when={c().kind === "password"}>
              <div class={styles.hint}>HTTPS wants a personal access token, not your account password.</div>
            </Show>
          </>
        )}
      </Show>
    </Dialog>
  );
}
