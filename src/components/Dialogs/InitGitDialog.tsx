import { createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";

// Turn a non-git folder into a repo, in one dialog. Replaces the separate
// "Initialize git repo…" and "Bare + worktree…" menu items: pick the initial
// branch, optionally set an origin URL, and toggle the layout. Unchecked is a
// normal `git init`; checked is an in-place `.bare` + worktree container. Enter
// confirms, Escape or a backdrop click cancels.
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

  onMount(() => requestAnimationFrame(() => first?.focus()));

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!props.busy) confirm();
    }
  }

  return (
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => props.onCancel()}>
        <div class={styles.modal} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class={styles.modalTitle}>Initialize git in “{props.folderName}”</div>

          <div class={styles.modalLabel}>Initial branch</div>
          <input
            ref={first}
            class={styles.modalInput}
            value={branch()}
            placeholder="blank = git default (main)"
            onInput={(e) => setBranch(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />

          <div class={styles.modalLabel}>Remote URL (origin)</div>
          <input
            class={styles.modalInput}
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

          <div class={styles.modalActions}>
            <button class={styles.modalBtn} onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button class={`${styles.modalBtn} ${styles.primary}`} disabled={props.busy} onClick={() => confirm()}>
              {props.busy ? "Initializing…" : "Initialize"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
