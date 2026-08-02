import { createSignal, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import { submitBlockedReason } from "../../utils/createPr";

// Open a pull request without leaving the app. Reached only when the remote is
// github.com and the integration is signed in and enabled; every other case goes
// to the provider's compare page instead (see `prPath`).
//
// The base is prefilled from `git_default_base_branch` and stays editable: a
// stacked branch opens against its parent, not against main, and guessing wrong
// there is a PR that has to be closed and reopened.
//
// Enter does *not* submit. The body is a textarea where newlines are the point,
// and a form whose primary action fires on Enter would open a PR every time
// someone hit return mid-sentence.
export default function CreatePrDialog(props: {
  head: string;
  base: string;
  busy: boolean;
  drafting: boolean;
  /// Null when no session can take a draft request, and the string is the
  /// reason, shown rather than hidden so a disabled button is never mute.
  draftDisabledReason: string | null;
  title: string;
  body: string;
  onTitleChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onBaseChange: (v: string) => void;
  onDraft: () => void;
  onConfirm: (opts: { draft: boolean }) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = createSignal(false);
  let first: HTMLInputElement | undefined;

  onMount(() => requestAnimationFrame(() => first?.focus()));

  const blocked = () =>
    submitBlockedReason({
      title: props.title,
      base: props.base,
      head: props.head,
      busy: props.busy,
    });

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    }
  }

  return (
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => !props.busy && props.onCancel()}>
        <div class={styles.modal} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class={styles.modalTitle}>Open a pull request</div>

          <div class={styles.modalLabel}>Title</div>
          <input
            ref={first}
            class={styles.modalInput}
            value={props.title}
            placeholder="What this branch does"
            onInput={(e) => props.onTitleChange(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />

          <div class={styles.modalLabel}>Description</div>
          <textarea
            class={styles.modalInput}
            rows={6}
            value={props.body}
            placeholder="Optional"
            onInput={(e) => props.onBodyChange(e.currentTarget.value)}
          />

          <div class={styles.modalLabel}>Base branch</div>
          <input
            class={styles.modalInput}
            value={props.base}
            onInput={(e) => props.onBaseChange(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />

          <div class={styles.modalMsg}>
            {props.head} into {props.base || "…"}
          </div>

          <label class={styles.wtCheck}>
            <input
              type="checkbox"
              checked={draft()}
              onChange={(e) => setDraft(e.currentTarget.checked)}
            />
            <span>Open as a draft</span>
          </label>

          <Show when={blocked()}>
            {(reason) => <div class={styles.modalMsg}>{reason()}</div>}
          </Show>

          <div class={styles.modalActions}>
            <Button
              disabled={props.drafting || props.busy || !!props.draftDisabledReason}
              title={props.draftDisabledReason ?? undefined}
              onClick={() => props.onDraft()}
            >
              {props.drafting ? "Asking…" : "Ask agent to draft"}
            </Button>
            <Button disabled={props.busy} onClick={() => props.onCancel()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!!blocked()}
              onClick={() => props.onConfirm({ draft: draft() })}
            >
              {props.busy ? "Opening…" : "Open pull request"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
