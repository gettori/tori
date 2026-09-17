import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import Dialog from "../Dialog/Dialog";
import { nameFromUrl, type NewProjectMode } from "../../utils/newProject";

// Create something under a space, in one dialog. Replaces the separate "New
// folder", "Clone repo…" and "Bare + worktree…" space-menu items: a segmented
// control picks the mode, and the fields follow it.
//
// **The mode note holds its own height.** The three notes are one, two and three
// lines of copy, so without a floor under the row the fields below it jump every
// time the mode changes - under the cursor, in the middle of a form. The floor
// is the tallest of the three.
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

  function onUrlInput(v: string) {
    setUrl(v);
    if (!nameEdited()) setName(nameFromUrl(v.trim()));
  }

  const helper = () => {
    switch (mode()) {
      case "folder":
        return "A plain folder, no git. Nothing is cloned.";
      case "clone":
        return "Clones a git repository into a new folder inside this space.";
      case "bare":
        return "A .bare repo plus one initial worktree. Add more branches later as their own folders.";
    }
  };

  // The URL is the only required field in the two git modes: a blank folder name
  // is not missing, it is the placeholder's promise that the URL supplies one.
  const folderName = () => name().trim() || (needsUrl() ? nameFromUrl(url().trim()) : "");
  const canConfirm = () => (needsUrl() ? !!url().trim() : !!name().trim());
  const confirm = () => {
    if (!canConfirm()) return;
    props.onConfirm({ mode: mode(), name: folderName(), url: url().trim() });
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
      <div class={styles.spaceForm} onKeyDown={onKeyDown}>
        <div>
          <SegmentedControl
            class={styles.modeSeg}
            aria-label="What to create"
            options={segs}
            value={mode()}
            onChange={setMode}
          />
          <div class={styles.modeNote}>{helper()}</div>
        </div>

        {/* Each field is named by the line above it rather than by an
            `aria-label` repeating that line, so the visible text and the
            accessible name cannot drift apart. The ids are static because only
            one of these dialogs can be open at a time. */}
        <Show when={needsUrl()}>
          <div class={styles.spaceField}>
            {/* The id names the words, not the row: see SpaceDialog on why the
                Required pill must stay out of the field's accessible name. */}
            <div class={styles.spaceLabel}>
              <span id={URL_LABEL}>Repository URL</span>
              <span class={styles.spaceRequired} aria-hidden="true">Required</span>
            </div>
            <input
              class={styles.spaceInput}
              aria-labelledby={URL_LABEL}
              aria-required={true}
              value={url()}
              placeholder="https://github.com/org/repo.git"
              onInput={(e) => onUrlInput(e.currentTarget.value)}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
            />
          </div>
        </Show>

        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>
            <span id={NAME_LABEL}>{needsUrl() ? "Folder name" : "Name"}</span>
            {/* Not in the git modes: there the URL is the required one, and a
                blank folder name is the placeholder's promise that the URL
                supplies it rather than something left undone. */}
            <Show when={!needsUrl()}>
              <span class={styles.spaceRequired} aria-hidden="true">Required</span>
            </Show>
          </div>
          <input
            ref={first}
            class={styles.spaceInput}
            aria-labelledby={NAME_LABEL}
            aria-required={!needsUrl()}
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
          <Show when={!needsUrl()}>
            <div class={styles.spaceHelp}>Created directly inside {props.spaceName}.</div>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
