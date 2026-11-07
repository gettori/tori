import { createSignal, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import Checkbox from "../Checkbox/Checkbox";
import Dialog from "../Dialog/Dialog";
import { createMoveForm, MoveFields } from "./MoveIntoSpace";
import { nameFromUrl, type NewProjectMode } from "../../utils/newProject";

// Create a folder or a clone under a space. The worktree layout is a box on
// Clone, on by default, not a third mode: both layouts ask the same fields.
//
// **The mode note holds its own height.** The notes differ in length, so without
// a floor under the row the fields below it jump every time the mode changes -
// under the cursor, in the middle of a form. The floor is the tallest of them.
//
// The shell is `Dialog`, which owns the portal, the backdrop, Escape and the
// focus trap. Enter stays here, on a wrapper around the fields, because it means
// "submit this form"; Escape does not, since Kobalte reports it as `onClose`.
const URL_LABEL = "new-project-url-label";
const NAME_LABEL = "new-project-name-label";

export type MoveHere = {
  base: string;
  home: string;
  initial?: boolean;
  pickFolder: () => Promise<string | null>;
  countRunning: (path: string) => Promise<number>;
  onMoved: (to: string, warnings: string[]) => void;
};

export default function NewProjectDialog(props: {
  spaceName: string;
  busy: boolean;
  onConfirm: (opts: { mode: NewProjectMode; name: string; url: string; worktreeLayout: boolean }) => void;
  onCancel: () => void;
  move?: MoveHere;
}) {
  const [mode, setMode] = createSignal<NewProjectMode | "move">(props.move?.initial ? "move" : "folder");
  const [movePath, setMovePath] = createSignal<string | null>(null);
  const moveForm = createMoveForm({
    path: movePath,
    base: () => props.move?.base ?? "",
    space: () => (mode() === "move" ? props.spaceName : null),
    countRunning: (p) => props.move?.countRunning(p) ?? Promise.resolve(0),
  });
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [worktreeLayout, setWorktreeLayout] = createSignal(true);
  // Track manual name edits so URL auto-fill stops clobbering a hand-typed name.
  const [nameEdited, setNameEdited] = createSignal(false);
  let first: HTMLInputElement | undefined;

  const needsUrl = () => mode() === "clone";

  function onUrlInput(v: string) {
    setUrl(v);
    if (!nameEdited()) setName(nameFromUrl(v.trim()));
  }

  const helper = () => {
    switch (mode()) {
      case "folder":
        return "A plain folder, no git. Nothing is cloned.";
      case "clone":
        return worktreeLayout()
          ? "Clones into a .bare repo with the default branch as its own folder. Add more branches later as their own folders."
          : "Clones a git repository into a new folder inside this space.";
      case "move":
        return `Moves a folder from anywhere on this disk into ${props.spaceName}.`;
    }
  };

  async function chooseMoveFolder() {
    const at = await props.move?.pickFolder();
    if (at) setMovePath(at);
  }

  async function confirmMove() {
    const done = await moveForm.submit();
    if (done) props.move?.onMoved(done.to, done.warnings);
  }

  // The URL is the only required field in the two git modes: a blank folder name
  // is not missing, it is the placeholder's promise that the URL supplies one.
  const folderName = () => name().trim() || (needsUrl() ? nameFromUrl(url().trim()) : "");
  const canConfirm = () => (needsUrl() ? !!url().trim() : !!name().trim());
  const confirm = () => {
    const m = mode();
    if (m === "move") return void confirmMove();
    if (!canConfirm()) return;
    props.onConfirm({
      mode: m,
      name: folderName(),
      url: url().trim(),
      worktreeLayout: mode() === "clone" && worktreeLayout(),
    });
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!working()) confirm();
  }

  const segs = (): { value: NewProjectMode | "move"; label: string }[] => [
    { value: "folder", label: "Folder" },
    { value: "clone", label: "Clone" },
    ...(props.move ? [{ value: "move" as const, label: "Move here" }] : []),
  ];
  const working = () => props.busy || moveForm.busy();
  const ready = () => (mode() === "move" ? moveForm.canMove() : canConfirm());

  return (
    <Dialog
      open
      title={`New in “${props.spaceName}”`}
      onClose={() => props.onCancel()}
      initialFocus={() => first}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={working() || !ready()} onClick={() => confirm()}>
            {working() ? "Working…" : mode() === "move" ? "Move" : "Create"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm} onKeyDown={onKeyDown}>
        <div>
          <SegmentedControl
            class={styles.modeSeg}
            aria-label="What to create"
            options={segs()}
            value={mode()}
            onChange={setMode}
          />
          <div class={styles.modeNote}>{helper()}</div>
          <Show when={needsUrl()}>
            <Checkbox
              class={styles.wtCheck}
              checked={worktreeLayout()}
              onChange={setWorktreeLayout}
              label="Worktree layout"
            />
          </Show>
        </div>

        <Show when={mode() === "move" && props.move}>
          {(move) => (
            <MoveFields form={moveForm} path={movePath()} home={move().home} onChange={() => void chooseMoveFolder()} />
          )}
        </Show>

        <Show when={mode() !== "move"}>
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
                <span class={styles.spaceRequired} aria-hidden="true">
                  Required
                </span>
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
                <span class={styles.spaceRequired} aria-hidden="true">
                  Required
                </span>
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
        </Show>
      </div>
    </Dialog>
  );
}
