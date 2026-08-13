import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
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
//
// The shell is `Dialog`, but this is the one of the seven whose dismissal is
// route-dependent, and it stays that way: while a submit is in flight a stray
// press behind the panel must not throw the form away, while Escape must still
// work, because someone watching "Opening…" and wanting out needs a way out.
// `Dialog.onClose` reports both routes without saying which, so the pointer half
// is refused there and the key half is handled here, only while `busy`. Outside
// that window Escape is left entirely to Kobalte, or both would fire and the
// same request would be cancelled twice.
const TITLE_LABEL = "create-pr-title-label";
const BODY_LABEL = "create-pr-body-label";
const BASE_LABEL = "create-pr-base-label";

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

  const blocked = () =>
    submitBlockedReason({
      title: props.title,
      base: props.base,
      head: props.head,
      busy: props.busy,
    });

  // Only while busy: outside that window `Dialog` forwards Escape as `onClose`
  // and cancels for us, so acting here too would cancel twice.
  //
  // This listens on the field wrapper rather than on the panel, which `Dialog`
  // does not expose, so it sees Escape only from inside the body. That is the
  // whole of the busy window in practice: focus opens on the title field and
  // every action button is disabled while a submit is in flight, so there is
  // nowhere outside the body for focus to be sitting.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !props.busy) return;
    e.preventDefault();
    props.onCancel();
  }

  return (
    <Dialog
      open
      title="Open a pull request"
      onClose={() => {
        // The pointer half of the busy guard. Kobalte reports an outside press
        // and an Escape through this one callback without distinguishing them,
        // so while busy nothing is done here and `onKeyDown` above keeps the
        // key route alive.
        if (!props.busy) props.onCancel();
      }}
      initialFocus={() => first}
      actions={
        <>
          <Button
            disabled={props.drafting || props.busy || !!props.draftDisabledReason}
            tooltipWhenDisabled
            tooltip={props.draftDisabledReason ?? undefined}
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
        </>
      }
    >
      <div onKeyDown={onKeyDown}>
        {/* Each field is named by the line above it rather than by an
            `aria-label` repeating that line, so the visible text and the
            accessible name cannot drift apart. The ids are static because only
            one of these dialogs can be open at a time. */}
        <div id={TITLE_LABEL} class={styles.label}>
          Title
        </div>
        <input
          ref={first}
          class={styles.input}
          aria-labelledby={TITLE_LABEL}
          value={props.title}
          placeholder="What this branch does"
          onInput={(e) => props.onTitleChange(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />

        <div id={BODY_LABEL} class={styles.label}>
          Description
        </div>
        <textarea
          class={styles.input}
          aria-labelledby={BODY_LABEL}
          rows={6}
          value={props.body}
          placeholder="Optional"
          onInput={(e) => props.onBodyChange(e.currentTarget.value)}
        />

        <div id={BASE_LABEL} class={styles.label}>
          Base branch
        </div>
        <input
          class={styles.input}
          aria-labelledby={BASE_LABEL}
          value={props.base}
          onInput={(e) => props.onBaseChange(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />

        <div class={styles.msg}>
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
          {(reason) => <div class={styles.msg}>{reason()}</div>}
        </Show>
      </div>
    </Dialog>
  );
}
