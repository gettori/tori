import { createSignal, For, Show } from "solid-js";
import { X } from "lucide-solid";
import { requestSend, composeHunkComments, type SessionTarget } from "../../utils/safeSend";
import { hunkCommentsBlocks } from "../../utils/chatCompose";
import { clearHeld, dropHeld, heldFor } from "../../utils/heldComments";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import Popover from "../../components/Popover/Popover";
import styles from "./HeldComments.module.css";

/** The held hunk comments for a workspace: a count that opens the list, and one
 *  Send for all of them. Renders nothing while the list is empty. */
export default function HeldComments(props: {
  heldKey: string;
  target: SessionTarget | null;
  disabledReason?: string | null;
}) {
  const [open, setOpen] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const held = () => heldFor(props.heldKey);
  const blocked = () => props.disabledReason ?? (props.target ? null : "Select a session first");

  async function send() {
    const target = props.target;
    const comments = held();
    if (!target || !comments.length || sending() || blocked()) return;
    setSending(true);
    const result = await requestSend({
      ...target,
      text: composeHunkComments(target, comments),
      blocks: hunkCommentsBlocks(comments),
    });
    setSending(false);
    if (result.kind === "sent") {
      dropHeld(
        props.heldKey,
        comments.map((c) => c.id),
      );
      setOpen(false);
      return;
    }
    // Terminal.tsx already toasted a blocked target; only an unanswered request
    // is left to report here.
    if (result.kind !== "timeout") return;
    emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
  }

  return (
    <Show when={held().length}>
      <Button ref={setAnchor} size="xs" aria-expanded={open()} onClick={() => setOpen(!open())}>
        {held().length === 1 ? "1 comment" : `${held().length} comments`}
      </Button>
      <Show when={open()}>
        <Popover anchorEl={anchor()} class={styles.panel} aria-label="Held comments" onClose={() => setOpen(false)}>
          <ul class={styles.list}>
            <For each={held()}>
              {(c) => (
                <li class={styles.row}>
                  <span class={styles.where}>
                    {c.path.split("/").pop()} {c.startLine}-{c.endLine}
                  </span>
                  <span class={styles.text}>{c.text}</span>
                  <IconButton
                    size="sm"
                    icon={<Icon icon={X} />}
                    tooltip="Remove this comment"
                    onClick={() => dropHeld(props.heldKey, [c.id])}
                  />
                </li>
              )}
            </For>
          </ul>
          <div class={styles.actions}>
            <Button size="xs" variant="ghost" onClick={() => clearHeld(props.heldKey)}>
              Clear
            </Button>
            <Button
              size="xs"
              variant="primary"
              disabled={!!blocked() || sending()}
              tooltipWhenDisabled={!!blocked()}
              tooltip={blocked() ?? undefined}
              onClick={() => void send()}
            >
              Send
            </Button>
          </div>
        </Popover>
      </Show>
    </Show>
  );
}
