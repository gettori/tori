import { createSignal, Show } from "solid-js";
import { requestSend, composeHunkComment, type SessionTarget } from "../../utils/safeSend";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import styles from "./HunkCommentInput.module.css";

/** A per-hunk "comment on this" affordance shared by ReviewPanel and
 *  SessionPanel: a toggle button on the hunk header that reveals an inline
 *  input, and routes `In @<file> lines <X>-<Y>: <comment>` through safe-send
 *  to `target` on submit. Disabled (with a tooltip) when there's no session
 *  to route to - unselected, or the routing itself is otherwise unavailable. */
export default function HunkCommentInput(props: {
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

  function toggle() {
    if (disabled()) return;
    setOpen((v) => !v);
    if (open()) queueMicrotask(() => inputEl?.focus());
  }

  async function submit() {
    const target = props.target;
    const comment = text().trim();
    if (!target || !comment || sending()) return;
    setSending(true);
    const composed = composeHunkComment(target, props.filePath, props.startLine, props.endLine, comment);
    const result = await requestSend({ ...target, text: composed });
    setSending(false);
    if (result.kind === "sent") {
      setText("");
      setOpen(false);
      return;
    }
    // Keep the typed comment so the user can retry without retyping; the
    // failure itself already surfaced as a toast from Terminal.tsx, except
    // the case where no Terminal ever answered (requestSend's own timeout).
    if (result.kind !== "timeout") return;
    emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
  }

  const disabled = () => !props.target || !!props.disabledReason;
  const title = () => (disabled() ? props.disabledReason ?? "Select a session first" : "Comment on this hunk");

  return (
    <>
      <button type="button" class={styles.commentToggle} disabled={disabled()} title={title()} onClick={toggle}>
        Comment
      </button>
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
          <button type="button" class={styles.commentSend} disabled={!text().trim() || sending()} onClick={submit}>
            Send
          </button>
        </div>
      </Show>
    </>
  );
}
