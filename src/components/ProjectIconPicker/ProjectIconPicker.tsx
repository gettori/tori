import { createEffect, createSignal, on, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Upload } from "lucide-solid";
import styles from "./ProjectIconPicker.module.css";
import Icon from "../Icon/Icon";
import IconGrid from "../IconGrid/IconGrid";
import ProjectIcon from "../Icon/ProjectIcon";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import { PICKER_ICONS, drawShelf, restingShelf, searchIcons } from "../Icon/iconRegistry";
import { isFileDrag, droppedPaths } from "../../utils/externalDrop";

/** What the picker hands back. Exactly one branch is in force at a time, which
 *  mirrors the storage: `[[project_meta]]` holds a name or a file, never both.
 *  - `{}`            -> automatic (the project's favicon, else a derived glyph)
 *  - `{ icon }`      -> a Lucide name from the picker set
 *  - `{ file }`      -> an image to copy into the icon store (a SOURCE path,
 *                       not the stored one; the backend does the copying) */
export type ProjectIconChoice = { icon?: string; file?: string };

type Source = "auto" | "upload" | "pick";

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const sourceOf = (icon: string | null, iconFile: string | null): Source =>
  iconFile ? "upload" : icon ? "pick" : "auto";

/**
 * A project's sidebar icon: automatic, an uploaded image, or one of the
 * picker's glyphs, saved the moment one is chosen.
 *
 * **The three sources are a mode, and the result is previewed.** The tile at the
 * top is what the row will look like; the strip under it is which of the three
 * is answering. Automatic saves on its segment, because it has nothing else to
 * choose. Upload and Pick save on the file or the glyph, so moving the strip to
 * look at them changes nothing until something is picked.
 *
 * Files dragged in from Finder arrive as ordinary `dragover`/`drop` events and
 * the path comes back from the drag pasteboard; see `utils/externalDrop.ts` for
 * why the DOM cannot supply it.
 */
export default function ProjectIconPicker(props: {
  /** The project's absolute path: the seed the automatic glyph is derived from. */
  seed: string;
  /** The project's name, for the sample sidebar row the preview shows. */
  name?: string;
  /** Currently stored Lucide name, or null. */
  icon: string | null;
  /** Currently stored image (an absolute path in the icon store), or null. */
  iconFile: string | null;
  /** The favicon discovery found, shown as the automatic option's preview. */
  favicon: string | null;
  busy: boolean;
  onChoose: (choice: ProjectIconChoice) => void;
  /** Opens the native file picker; resolves to a path, or null when cancelled. */
  onPickFile: () => Promise<string | null>;
}) {
  const [source, setSource] = createSignal<Source>(sourceOf(props.icon, props.iconFile));
  const [icon, setIcon] = createSignal<string | null>(props.icon);
  const [file, setFile] = createSignal<string | null>(props.iconFile);
  const [picking, setPicking] = createSignal(false);
  const [over, setOver] = createSignal(false);
  // Mirrors the grid's own query, which it does not publish otherwise, so the
  // "+N more" line can go when a search is what is on screen.
  const [query, setQuery] = createSignal("");
  const shelf = drawShelf();

  // A change made elsewhere (the sidebar, another window) lands here through
  // the stored props, and the picker follows it rather than showing the past.
  createEffect(
    on(
      () => [props.icon, props.iconFile] as const,
      ([storedIcon, storedFile]) => {
        setIcon(storedIcon);
        setFile(storedFile);
        setSource(sourceOf(storedIcon, storedFile));
      },
      { defer: true },
    ),
  );

  const resting = () => restingShelf(shelf, icon());

  const choose = (next: ProjectIconChoice) => {
    if (props.busy) return;
    // An unchanged image is not re-uploaded: re-copying the stored file would
    // just rewrite the same bytes under the same name for no reason.
    if (next.file && next.file === props.iconFile) return;
    props.onChoose(next);
  };

  const pickSource = (next: Source) => {
    setSource(next);
    if (next === "auto" && (props.icon || props.iconFile)) choose({});
  };

  const takeFile = (path: string) => {
    setFile(path);
    choose({ file: path });
  };

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
      if (path) takeFile(path);
    } finally {
      setPicking(false);
    }
  }

  async function onDrop(e: DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setOver(false);
    const [path] = await droppedPaths();
    if (path) takeFile(path);
  }

  const art = () => (
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
  );

  return (
    <div class={styles.picker}>
      <div class={styles.preview}>
        <div class={styles.tile}>{art()}</div>
        <div class={styles.copy}>
          <div class={styles.copyTitle}>{copy().title}</div>
          <div class={styles.copyBody}>{copy().body}</div>
        </div>
        <Show when={props.name}>
          {(name) => (
            <div class={styles.sample}>
              <span class={styles.sampleCaption}>In the sidebar</span>
              <span class={styles.sampleRow} aria-hidden="true">
                <span class={styles.sampleIcon}>{art()}</span>
                <span class={styles.sampleName}>{name()}</span>
              </span>
            </div>
          )}
        </Show>
      </div>

      <SegmentedControl
        class={styles.modes}
        aria-label="Where the icon comes from"
        options={[
          { value: "auto", label: "Automatic" },
          { value: "upload", label: "Upload" },
          { value: "pick", label: "Pick an icon" },
        ]}
        value={source()}
        onChange={pickSource}
      />

      <Show when={source() === "upload"}>
        <button
          type="button"
          class={styles.dropzone}
          classList={{ [styles.dropzoneOver]: over() }}
          disabled={picking() || props.busy}
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
        <div class={styles.grid}>
          <IconGrid
            aria-label="Project icon"
            value={icon()}
            onChange={(name) => {
              if (name == null) return;
              setIcon(name);
              choose({ icon: name });
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
              onQuery: setQuery,
            }}
          />
          <div class={styles.more}>
            {query().trim()
              ? `${searchIcons(query()).length} matches of ${PICKER_ICONS.length}`
              : `Showing ${resting().length} of ${PICKER_ICONS.length}, search to reach the rest`}
          </div>
        </div>
      </Show>
    </div>
  );
}
