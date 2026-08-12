import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import Dialog from "../Dialog/Dialog";

export type NewProjectMode = "folder" | "clone" | "bare";

// Create something under a space, in one dialog. Replaces the separate "New
// folder", "Clone repo…" and "Bare + worktree…" space-menu items: a segmented
// control picks the mode, a Name field is always shown, and a URL field appears
// only for clone/bare (auto-filling the name from the URL until it is edited by
// hand).
//
// The shell is `Dialog`, which owns the portal, the backdrop, Escape and the
// focus trap. Enter stays here, on a wrapper around the fields, because it means
// "submit this form"; Escape does not, since Kobalte reports it as `onClose`.
const URL_LABEL = "new-project-url-label";
const NAME_LABEL = "new-project-name-label";

export default function NewProjectDialog(props: {
  spaceName: string;
  busy: boolean;
  onConfirm: (opts: { mode: NewProjectMode; name: string; url: string }) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = createSignal<NewProjectMode>("folder");
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  // Track manual name edits so URL auto-fill stops clobbering a hand-typed name.
  const [nameEdited, setNameEdited] = createSignal(false);
  let first: HTMLInputElement | undefined;

  const needsUrl = () => mode() !== "folder";
  const nameFromUrl = (u: string) =>
    u.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") ?? "";

  function onUrlInput(v: string) {
    setUrl(v);
    if (!nameEdited()) setName(nameFromUrl(v.trim()));
  }

  const helper = () => {
    switch (mode()) {
      case "folder":
        return "A plain, non-git folder.";
      case "clone":
        return "Clone a git repository into a new folder.";
      case "bare":
        return "A .bare repo with one initial worktree; add more branches as their own folders.";
    }
  };

  const canConfirm = () => !!name().trim() && (!needsUrl() || !!url().trim());
  const confirm = () => {
    if (!canConfirm()) return;
    props.onConfirm({ mode: mode(), name: name().trim(), url: url().trim() });
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!props.busy) confirm();
  }

  const segs: { value: NewProjectMode; label: string }[] = [
    { value: "folder", label: "Folder" },
    { value: "clone", label: "Clone" },
    { value: "bare", label: "Bare + worktree" },
  ];

  return (
    <Dialog
      open
      title={`New in “${props.spaceName}”`}
      onClose={() => props.onCancel()}
      initialFocus={() => first}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            variant="primary"
            disabled={props.busy || !canConfirm()}
            onClick={() => confirm()}
          >
            {props.busy ? "Working…" : "Create"}
          </Button>
        </>
      }
    >
      <div onKeyDown={onKeyDown}>
        <SegmentedControl
          class={styles.newSeg}
          aria-label="What to create"
          options={segs}
          value={mode()}
          onChange={setMode}
        />
        <div class={styles.modalMsg}>{helper()}</div>

        {/* Each field is named by the line above it rather than by an
            `aria-label` repeating that line, so the visible text and the
            accessible name cannot drift apart. The ids are static because only
            one of these dialogs can be open at a time. */}
        <Show when={needsUrl()}>
          <div id={URL_LABEL} class={styles.modalLabel}>
            Repository URL
          </div>
          <input
            class={styles.modalInput}
            aria-labelledby={URL_LABEL}
            value={url()}
            placeholder="https://…"
            onInput={(e) => onUrlInput(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
        </Show>

        <div id={NAME_LABEL} class={styles.modalLabel}>
          {needsUrl() ? "Folder name" : "Name"}
        </div>
        <input
          ref={first}
          class={styles.modalInput}
          aria-labelledby={NAME_LABEL}
          value={name()}
          placeholder={needsUrl() ? "defaults from the URL" : "folder name"}
          onInput={(e) => {
            setNameEdited(true);
            setName(e.currentTarget.value);
          }}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
      </div>
    </Dialog>
  );
}
