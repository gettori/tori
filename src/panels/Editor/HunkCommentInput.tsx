import { createSignal, Show } from "solid-js";
import { holdComment } from "../../utils/heldComments";
import { MessageSquare } from "lucide-solid";
import Button from "../../components/Button/Button";
import IconButton from "../../components/IconButton/IconButton";
import Icon from "../../components/Icon/Icon";
import styles from "./HunkCommentInput.module.css";

/** A per-hunk "comment on this" affordance shared by DiffView and SessionPanel:
 *  a toggle button on the hunk header that reveals an inline input, and holds
 *  the comment in the workspace's list (`HeldComments` sends them). Needs no
 *  session, since nothing is sent from here. */
export default function HunkCommentInput(props: {
  heldKey: string;
  filePath: string;
  startLine: number;
  endLine: number;
}) {
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal("");
  let inputEl: HTMLInputElement | undefined;

  function toggle() {
    setOpen((v) => !v);
    if (open()) queueMicrotask(() => inputEl?.focus());
  }

  function submit() {
    const comment = text().trim();
    if (!comment) return;
    holdComment(props.heldKey, {
      path: props.filePath,
      startLine: props.startLine,
      endLine: props.endLine,
      text: comment,
    });
    setText("");
    setOpen(false);
  }

  return (
    <>
      <IconButton
        size="sm"
        icon={<Icon icon={MessageSquare} />}
        active={open()}
        tooltip="Comment on this hunk"
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
                submit();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          <Button size="xs" disabled={!text().trim()} onClick={submit}>
            Hold comment
          </Button>
        </div>
      </Show>
    </>
  );
}
