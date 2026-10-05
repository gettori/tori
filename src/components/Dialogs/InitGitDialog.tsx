import { createSignal } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import SegmentedControl from "../SegmentedControl/SegmentedControl";

type Layout = "normal" | "bare";

// Turn a non-git folder into a repo, in one dialog.
//
// **The layout is two segments, not a checkbox.** As a checkbox it was
// "Bare + worktree layout", and the line under it read "A normal git repository
// in this folder." - a description of the *unchecked* state sitting under the
// checked label. Two segments each describe what they produce, and the note has
// one subject at a time.
//
// Both fields are optional, so the primary is never gated: a blank branch takes
// git's default and a blank URL adds no origin.
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
  const [layout, setLayout] = createSignal<Layout>("normal");
  const [branch, setBranch] = createSignal("");
  const [url, setUrl] = createSignal("");
  let first: HTMLInputElement | undefined;

  const note = () =>
    layout() === "normal"
      ? "A standard git repository with one working tree in this folder."
      : "A .bare repo in this folder, with each branch checked out as its own sibling folder.";

  const confirm = () => props.onConfirm({ branch: branch().trim(), url: url().trim(), bare: layout() === "bare" });

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!props.busy) confirm();
  }

  return (
    <Dialog
      open
      size="sheet"
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
      <div class={styles.spaceForm} onKeyDown={onKeyDown}>
        <div>
          <SegmentedControl
            class={styles.modeSeg}
            aria-label="Repository layout"
            options={[
              { value: "normal", label: "Normal repo" },
              { value: "bare", label: "Bare + worktree" },
            ]}
            value={layout()}
            onChange={setLayout}
          />
          <div class={styles.modeNote}>{note()}</div>
        </div>

        {/* Each field is named by the line above it rather than by an
            `aria-label` repeating that line, so the visible text and the
            accessible name cannot drift apart. The ids are static because only
            one of these dialogs can be open at a time. */}
        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>
            <span id={BRANCH_LABEL}>Initial branch</span>
          </div>
          <input
            ref={first}
            class={`${styles.spaceInput} ${styles.monoInput}`}
            aria-labelledby={BRANCH_LABEL}
            value={branch()}
            placeholder="main"
            onInput={(e) => setBranch(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
          {/* Under the field rather than in it: a placeholder that states a rule
              cannot be read once anything is typed, which is exactly when a
              rule about blankness is being decided. */}
          <div class={styles.spaceHelp}>Leave blank to use your git default.</div>
        </div>

        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>
            <span id={URL_LABEL}>Remote URL</span>
            <span class={styles.qualifier}>optional, added as origin</span>
          </div>
          <input
            class={`${styles.spaceInput} ${styles.monoInput}`}
            aria-labelledby={URL_LABEL}
            value={url()}
            placeholder="git@github.com:org/repo.git"
            onInput={(e) => setUrl(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
        </div>
      </div>
    </Dialog>
  );
}
