import { createSignal, Show } from "solid-js";
import { holdComment } from "../../utils/heldComments";
import { sendHunkCommentsNow } from "../../utils/hunkCommentPref";
import { requestSend, composeHunkComment, type SessionTarget } from "../../utils/safeSend";
import { hunkCommentBlocks } from "../../utils/chatCompose";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { MessageSquare } from "lucide-solid";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import styles from "./HunkCommentInput.module.css";

/** A per-hunk "comment on this" affordance shared by DiffView and SessionPanel:
 *  a toggle button on the hunk header that reveals an inline input. The comment
 *  is held in the workspace's list (`HeldComments` sends them), or with "Send
 *  hunk comments right away" on, sent to `target` on its own. */
export default function HunkCommentInput(props: {
  heldKey: string;
  target: SessionTarget | null;
  disabledReason?: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
}) {
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  let inputEl: HTMLInputElement | undefined;

  const blocked = () =>
    sendHunkCommentsNow() ? (props.disabledReason ?? (props.target ? null : "Select a session first")) : null;

  function toggle() {
    if (blocked()) return;
    setOpen((v) => !v);
    if (open()) queueMicrotask(() => inputEl?.focus());
  }

  function done() {
    setText("");
    setOpen(false);
  }

  async function submit() {
    const comment = text().trim();
    if (!comment || sending()) return;
    if (!sendHunkCommentsNow()) {
      holdComment(props.heldKey, {
        path: props.filePath,
        startLine: props.startLine,
        endLine: props.endLine,
        text: comment,
      });
      done();
      return;
    }
    const target = props.target;
    if (!target || blocked()) return;
    setSending(true);
    const result = await requestSend({
      ...target,
      text: composeHunkComment(target, props.filePath, props.startLine, props.endLine, comment),
      blocks: hunkCommentBlocks(props.filePath, props.startLine, props.endLine, comment),
      submit: true,
    });
    setSending(false);
    if (result.kind === "sent") return done();
    // The typed comment stays for a retry. A refusal was already toasted by
    // whoever refused; only an unanswered request is left to report here.
    if (result.kind !== "timeout") return;
    emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
  }

  return (
    <>
      {/* `tooltipWhenDisabled`: the reason is why it is greyed out. */}
      <IconButton
        size="sm"
        icon={<Icon icon={MessageSquare} />}
        active={open()}
        disabled={!!blocked()}
        tooltipWhenDisabled
        tooltip={blocked() ?? "Comment on this hunk"}
        onClick={toggle}
      />
      <Show when={open()}>
        <div class={styles.commentBox}>
          <input
            ref={inputEl}
            class={styles.commentInput}
            type="text"
            placeholder="Comment on this hunk"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          <Button size="xs" disabled={!text().trim() || sending()} onClick={() => void submit()}>
            {sendHunkCommentsNow() ? "Send" : "Hold comment"}
          </Button>
        </div>
      </Show>
    </>
  );
}
