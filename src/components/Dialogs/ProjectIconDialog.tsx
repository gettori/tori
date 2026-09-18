import { createSignal, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Upload } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import IconGrid from "../IconGrid/IconGrid";
import ProjectIcon from "../Icon/ProjectIcon";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import { PICKER_ICONS, drawShelf, restingShelf, searchIcons } from "../Icon/iconRegistry";
import { isFileDrag, droppedPaths } from "../../utils/externalDrop";

/** What the dialog hands back. Exactly one branch is in force at a time, which
 *  mirrors the storage: `[[project_meta]]` holds a name or a file, never both.
 *  - `{}`            → automatic (the project's favicon, else a derived glyph)
 *  - `{ icon }`      → a Lucide name from the picker set
 *  - `{ file }`      → an image to copy into the icon store (a SOURCE path,
 *                      not the stored one; the backend does the copying) */
export type ProjectIconChoice = { icon?: string; file?: string };

type Source = "auto" | "upload" | "pick";

/** An image's own name, for reporting a file that has been chosen but not saved. */
function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * Change a project's sidebar icon: automatic, an uploaded image, or one of the
 * picker's glyphs.
 *
 * **The three sources are a mode, and the result is previewed.** They used to be
 * two large buttons with the glyph grid always open below them, so nothing said
 * the three were exclusive and the chosen result was never shown at the size it
 * is worn. The tile at the top is what the row will look like; the strip under
 * it is which of the three is answering.
 *
 * **The upload constraint lives in the dropzone.** `SVG, PNG or ICO, up to 2 MB`
 * used to sit under the buttons, where it was also on screen in the two modes it
 * says nothing about.
 *
 * Files dragged in from Finder arrive as ordinary `dragover`/`drop` events and
 * the path comes back from the drag pasteboard; see `utils/externalDrop.ts` for
 * why the DOM cannot supply it.
 *
 * The shell is `Dialog`. Enter stays here, through its `onKeyDown`, because the
 * Save button is `disabled` while there is nothing to save and a disabled button
 * is never clicked. Escape does not: Kobalte reports it as `onClose`.
 */
export default function ProjectIconDialog(props: {
  projectName: string;
  /** The project's absolute path: the seed the automatic glyph is derived from. */
  seed: string;
  /** Currently stored Lucide name, or null. */
  icon: string | null;
  /** Currently stored image (an absolute path in the icon store), or null. */
  iconFile: string | null;
  /** The favicon discovery found, shown as the automatic option's preview. */
  favicon: string | null;
  busy: boolean;
  onConfirm: (choice: ProjectIconChoice) => void;
  onCancel: () => void;
  /** Opens the native file picker; resolves to a path, or null when cancelled. */
  onPickFile: () => Promise<string | null>;
}) {
  // Seeded from what is stored, so reopening shows the current state rather
  // than resetting to automatic. Each mode keeps its own value while the strip
  // moves: switching away and back must not throw away a file just chosen.
  const [source, setSource] = createSignal<Source>(
    props.iconFile ? "upload" : props.icon ? "pick" : "auto",
  );
  const [icon, setIcon] = createSignal<string | null>(props.icon);
  const [file, setFile] = createSignal<string | null>(props.iconFile);
  const [picking, setPicking] = createSignal(false);
  const [over, setOver] = createSignal(false);
  // Mirrors the grid's own query, which it does not publish otherwise, so the
  // "+N more" line can go when a search is what is on screen.
  const [query, setQuery] = createSignal("");
  // Drawn once for the life of the dialog; see `drawShelf` on why.
  const shelf = drawShelf();
  let search: HTMLInputElement | undefined;

  // What the grid shows at rest: a short shelf rather than the whole set, with
  // whatever is stored forced into it.
  const resting = () => restingShelf(shelf, icon());
  const hidden = () => PICKER_ICONS.length - resting().length;

  const choice = (): ProjectIconChoice => {
    if (source() === "upload") return file() ? { file: file()! } : {};
    if (source() === "pick") return icon() ? { icon: icon()! } : {};
    return {};
  };
  const canSave = () =>
    source() === "auto" || (source() === "upload" ? !!file() : !!icon());

  const copy = () => {
    switch (source()) {
      case "auto":
        return props.favicon
          ? {
              title: "The project's own favicon",
              body: "An image Tori found inside the project. It follows the project, so replacing it there replaces it here.",
            }
          : {
              title: "Derived from the folder",
              body: "Nothing inside the project names an icon, so the glyph comes from the folder's path. It picks up a favicon the day the project grows one.",
            };
      case "upload":
        return file()
          ? {
              title: "Uploaded image",
              body: "Your own file, scaled to the tile. Replaces whatever the project says about itself.",
            }
          : {
              title: "No image yet",
              body: "Choose a file below, or drop one on it. It replaces whatever the project says about itself.",
            };
      case "pick":
        return icon()
          ? {
              title: "Picked icon",
              body: "Chosen from the set below. Stays fixed until you change it.",
            }
          : {
              title: "No icon picked",
              body: "Choose one from the set below. It stays fixed until you change it.",
            };
    }
  };

  async function upload() {
    if (picking()) return;
    setPicking(true);
    try {
      const path = await props.onPickFile();
      if (path) setFile(path);
    } finally {
      setPicking(false);
    }
  }

  async function onDrop(e: DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setOver(false);
    const [path] = await droppedPaths();
    if (path) setFile(path);
  }

  const confirm = () => {
    if (props.busy || !canSave()) return;
    const next = choice();
    // An unchanged image is not re-uploaded: re-copying the stored file would
    // just rewrite the same bytes under the same name for no reason.
    if (next.file && next.file === props.iconFile) props.onCancel();
    else props.onConfirm(next);
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    confirm();
  }

  return (
    <Dialog
      open
      size="sheet"
      title={`Icon for “${props.projectName}”`}
      onClose={() => props.onCancel()}
      onKeyDown={onKeyDown}
      // Only resolves when the dialog opens straight into Pick, which is what a
      // project with a chosen glyph does; the other two modes have no field to
      // land in and `Dialog` falls back to the panel.
      initialFocus={() => search}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={props.busy || !canSave()} onClick={() => confirm()}>
            {props.busy ? "Working…" : "Save"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <div class={styles.iconPreview}>
          <div class={styles.previewTile}>
            <Show
              when={source() === "upload" && file()}
              fallback={
                <ProjectIcon
                  seed={props.seed}
                  favicon={props.favicon ?? undefined}
                  icon={source() === "pick" ? (icon() ?? undefined) : undefined}
                />
              }
            >
              {(f) => <img src={convertFileSrc(f())} alt="" draggable={false} />}
            </Show>
          </div>
          <div class={styles.previewCopy}>
            <div class={styles.previewTitle}>{copy().title}</div>
            <div class={styles.previewBody}>{copy().body}</div>
          </div>
        </div>

        <SegmentedControl
          class={styles.modeSeg}
          aria-label="Where the icon comes from"
          options={[
            { value: "auto", label: "Automatic" },
            { value: "upload", label: "Upload" },
            { value: "pick", label: "Pick an icon" },
          ]}
          value={source()}
          onChange={setSource}
        />

        {/* Automatic has no body: the preview panel above is the whole answer. */}
        <Show when={source() === "upload"}>
          <button
            type="button"
            class={styles.dropzone}
            classList={{ [styles.dropzoneOver]: over() }}
            disabled={picking()}
            onClick={() => void upload()}
            onDragOver={(e) => {
              if (!isFileDrag(e)) return;
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => void onDrop(e)}
          >
            <Icon icon={Upload} aria-hidden="true" />
            <Show
              when={file()}
              fallback={
                <span>
                  Drop an image, or <span class={styles.dropAction}>choose a file</span>
                </span>
              }
            >
              {(f) => (
                <>
                  <span class={styles.dropName}>{baseName(f())}</span>
                  <span class={styles.dropAction}>Choose a different file</span>
                </>
              )}
            </Show>
            <span class={styles.dropSpec}>SVG, PNG or ICO, up to 2 MB, square works best</span>
          </button>
        </Show>

        <Show when={source() === "pick"}>
          {/* No leading tile: "no glyph" is the Automatic segment above, which
              is a different mode rather than a value in this grid, so `null`
              never comes back out of it. */}
          <div class={styles.pickerBody}>
            <IconGrid
              aria-label="Project icon"
              value={icon()}
              onChange={(name) => {
                if (name != null) setIcon(name);
              }}
              tiles={(typed) =>
                (typed.trim() ? searchIcons(typed) : resting()).map((entry) => ({
                  value: entry.name,
                  label: entry.name,
                  content: <Icon icon={entry.icon} />,
                }))
              }
              search={{
                label: "Search icons",
                placeholder: "Search icons",
                ref: (el) => (search = el),
                onQuery: setQuery,
              }}
            />
            {/* Only at rest. During a search the grid is showing every match,
                so there is no remainder to name. */}
            <Show when={!query().trim() && hidden() > 0}>
              <div class={styles.pickerMore}>+{hidden()} more, search to reach them</div>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}
