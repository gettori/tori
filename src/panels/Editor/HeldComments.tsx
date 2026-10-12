import { createSignal, For, Show } from "solid-js";
import { X } from "lucide-solid";
import { requestSend, composeHunkComments, type SessionTarget } from "../../utils/safeSend";
import { hunkCommentsBlocks } from "../../utils/chatCompose";
import { clearHeld, dropHeld, heldFor, type HeldComment } from "../../utils/heldComments";
import { setFindingStatus, type FindingStatus } from "../../utils/secondOpinion";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import Popover from "../../components/Popover/Popover";
import styles from "./HeldComments.module.css";

type Batch = { target: SessionTarget; comments: HeldComment[] };

/** The held hunk comments for a workspace: a count that opens the list, and one
 *  Send for all of them. A reviewer's comments go to the session they review,
 *  the user's own to the selected one. Renders nothing while the list is empty. */
export default function HeldComments(props: {
  heldKey: string;
  folder: string;
  target: SessionTarget | null;
  disabledReason?: string | null;
}) {
  const [open, setOpen] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const held = () => heldFor(props.heldKey);
  const ownReason = () => props.disabledReason ?? (props.target ? null : "Select a session first");

  const batches = (): Batch[] => {
    const own = held().filter((c) => !c.author);
    const out: Batch[] = props.target && !ownReason() && own.length ? [{ target: props.target, comments: own }] : [];
    for (const c of held()) {
      if (!c.target) continue;
      const batch = out.find((b) => b.target.sessionId === c.target!.sessionId && b.comments[0].author);
      if (batch) batch.comments.push(c);
      else out.push({ target: c.target, comments: [c] });
    }
    return out;
  };
  const blocked = () => (batches().length ? null : (ownReason() ?? held().find((c) => c.blocked)?.blocked ?? null));

  function record(comments: readonly HeldComment[], status: FindingStatus) {
    const bySession = new Map<string, string[]>();
    for (const c of comments) {
      if (c.author && c.session) bySession.set(c.session, [...(bySession.get(c.session) ?? []), c.id]);
    }
    for (const [session, ids] of bySession) void setFindingStatus(props.folder, session, ids, status);
  }

  function drop(comments: readonly HeldComment[]) {
    dropHeld(
      props.heldKey,
      comments.map((c) => c.id),
    );
    record(comments, "dismissed");
  }

  async function send() {
    const todo = batches();
    if (!todo.length || sending()) return;
    setSending(true);
    let unreached = false;
    for (const { target, comments } of todo) {
      const result = await requestSend({
        ...target,
        text: composeHunkComments(target, comments),
        blocks: hunkCommentsBlocks(comments),
        submit: true,
      });
      if (result.kind === "sent") {
        dropHeld(
          props.heldKey,
          comments.map((c) => c.id),
        );
        record(comments, "sent");
      } else if (result.kind === "timeout") {
        unreached = true;
      }
    }
    setSending(false);
    if (!held().length) setOpen(false);
    // Terminal.tsx already toasted a blocked target; only an unanswered request
    // is left to report here.
    if (unreached) emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
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
                  <Show when={c.author}>
                    <span class={styles.tag}>{c.author}</span>
                  </Show>
                  <Show when={c.stale}>
                    <span class={styles.tag}>stale</span>
                  </Show>
                  <span class={styles.text}>{c.text}</span>
                  <IconButton
                    size="sm"
                    icon={<Icon icon={X} />}
                    tooltip="Remove this comment"
                    onClick={() => drop([c])}
                  />
                </li>
              )}
            </For>
          </ul>
          <div class={styles.actions}>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                record(held(), "dismissed");
                clearHeld(props.heldKey);
              }}
            >
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
