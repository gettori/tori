import { For, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import { pendingMessageRequest } from "../../utils/lspMessages";

// Keyed, so each queued question is its own dialog with its own focus restore.
export default function ServerMessageDialog() {
  return (
    <Show when={pendingMessageRequest()} keyed>
      {(request) => {
        let first: HTMLButtonElement | undefined;
        return (
          <Dialog
            open
            title={request.server}
            onClose={() => request.answer(null)}
            initialFocus={() => first}
            actions={
              <Show
                when={request.actions.length}
                fallback={
                  <Button ref={first} onClick={() => request.answer(null)}>
                    OK
                  </Button>
                }
              >
                <For each={request.actions}>
                  {(action, i) => (
                    <Button
                      ref={(el) => {
                        if (i() === 0) first = el;
                      }}
                      onClick={() => request.answer(action)}
                    >
                      {action.title}
                    </Button>
                  )}
                </For>
              </Show>
            }
          >
            <div class={styles.msg}>{request.message}</div>
          </Dialog>
        );
      }}
    </Show>
  );
}
