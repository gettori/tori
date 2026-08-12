import { createSignal } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";

// Turn a non-git folder into a repo, in one dialog. Replaces the separate
// "Initialize git repo…" and "Bare + worktree…" menu items: pick the initial
// branch, optionally set an origin URL, and toggle the layout. Unchecked is a
// normal `git init`; checked is an in-place `.bare` + worktree container.
//
// The shell is `Dialog`, which owns the portal, the backdrop, Escape and the
// focus trap. Enter stays here, on a wrapper around the fields, because it means
// "submit this form" and every field it can be pressed in is inside that
// wrapper; Escape does not, since Kobalte reports it as `onClose`.
const BRANCH_LABEL = "init-git-branch-label";
const URL_LABEL = "init-git-url-label";

export default function InitGitDialog(props: {
  folderName: string;
  busy: boolean;
  onConfirm: (opts: { branch: string; url: string; bare: boolean }) => void;
  onCancel: () => void;
}) {
  const [branch, setBranch] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [bare, setBare] = createSignal(false);
  const confirm = () =>
    props.onConfirm({ branch: branch().trim(), url: url().trim(), bare: bare() });
  let first: HTMLInputElement | undefined;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!props.busy) confirm();
  }

  return (
    <Dialog
      open
      title={`Initialize git in “${props.folderName}”`}
      onClose={() => props.onCancel()}
      initialFocus={() => first}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={props.busy} onClick={() => confirm()}>
            {props.busy ? "Initializing…" : "Initialize"}
          </Button>
        </>
      }
    >
      <div onKeyDown={onKeyDown}>
        {/* Each field is named by the line above it rather than by an
            `aria-label` repeating that line, so the visible text and the
            accessible name cannot drift apart. The ids are static because only
            one of these dialogs can be open at a time. */}
        <div id={BRANCH_LABEL} class={styles.modalLabel}>
          Initial branch
        </div>
        <input
          ref={first}
          class={styles.modalInput}
          aria-labelledby={BRANCH_LABEL}
          value={branch()}
          placeholder="blank = git default (main)"
          onInput={(e) => setBranch(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />

        <div id={URL_LABEL} class={styles.modalLabel}>
          Remote URL (origin)
        </div>
        <input
          class={styles.modalInput}
          aria-labelledby={URL_LABEL}
          value={url()}
          placeholder="https://… (optional)"
          onInput={(e) => setUrl(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />

        <label class={`${styles.wtCheck} ${styles.initCheck}`}>
          <input
            type="checkbox"
            checked={bare()}
            onChange={(e) => setBare(e.currentTarget.checked)}
          />
          <span>Bare + worktree layout (branches as sibling folders)</span>
        </label>
        <div class={styles.modalMsg}>
          {bare()
            ? "Creates a .bare repo with one initial worktree; add more branches as their own folders."
            : "A normal git repository in this folder."}
        </div>
      </div>
    </Dialog>
  );
}
