import { createSignal, For, Show, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { convertFileSrc } from "@tauri-apps/api/core";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import ProjectIcon from "../Icon/ProjectIcon";
import { searchIcons } from "../Icon/iconRegistry";
import { Upload } from "lucide-solid";

/** What the dialog hands back. Exactly one branch is in force at a time, which
 *  mirrors the storage: `[[project_meta]]` holds a name or a file, never both.
 *  - `{}`            → automatic (the project's favicon, else a derived glyph)
 *  - `{ icon }`      → a Lucide name from the picker set
 *  - `{ file }`      → an image to copy into the icon store (a SOURCE path,
 *                      not the stored one; the backend does the copying) */
export type ProjectIconChoice = { icon?: string; file?: string };

// Change a project's sidebar icon: automatic, an uploaded image, or one of the
// picker's glyphs (searchable, since the set outgrew a single screenful). The
// three are one selection, so choosing any of them un-chooses the others - the
// user picks what the row shows, not a stack of fallbacks. Enter confirms,
// Escape or a backdrop click cancels.
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
  // One selection, three shapes. Seeded from what is stored, so reopening the
  // dialog shows the current state rather than resetting to automatic.
  const [sel, setSel] = createSignal<ProjectIconChoice>(
    props.iconFile ? { file: props.iconFile } : props.icon ? { icon: props.icon } : {},
  );
  const [query, setQuery] = createSignal("");
  const [picking, setPicking] = createSignal(false);
  let first: HTMLInputElement | undefined;

  onMount(() => requestAnimationFrame(() => first?.focus()));

  const isAuto = () => !sel().icon && !sel().file;
  const file = () => sel().file;

  async function upload() {
    if (picking()) return;
    setPicking(true);
    try {
      const path = await props.onPickFile();
      if (path) setSel({ file: path });
    } finally {
      setPicking(false);
    }
  }

  const confirm = () => {
    if (props.busy) return;
    // An unchanged image is not re-uploaded: re-copying the stored file would
    // just rewrite the same bytes under the same name for no reason.
    if (file() && file() === props.iconFile) props.onCancel();
    else props.onConfirm(sel());
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  }

  return (
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => props.onCancel()}>
        <div class={styles.modal} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class={styles.modalTitle}>Icon for “{props.projectName}”</div>

          <div class={styles.iconModes}>
            <button
              type="button"
              class={styles.iconMode}
              classList={{ [styles.iconSelected]: isAuto() }}
              aria-pressed={isAuto()}
              onClick={() => setSel({})}
            >
              <ProjectIcon seed={props.seed} favicon={props.favicon ?? undefined} />
              <span>{props.favicon ? "Project favicon" : "Automatic"}</span>
            </button>
            <button
              type="button"
              class={styles.iconMode}
              classList={{ [styles.iconSelected]: file() != null }}
              aria-pressed={file() != null}
              disabled={picking()}
              onClick={() => void upload()}
            >
              <Show when={file()} fallback={<Icon icon={Upload} />}>
                {(f) => <img src={convertFileSrc(f())} alt="" draggable={false} />}
              </Show>
              <span>{file() ? "Change image…" : "Upload image…"}</span>
            </button>
          </div>
          <div class={styles.modalNote}>SVG, PNG or ICO, up to 2 MB.</div>

          <div class={styles.modalLabel}>Or pick an icon</div>
          <input
            ref={first}
            class={styles.modalInput}
            value={query()}
            placeholder="Search icons"
            aria-label="Search icons"
            onInput={(e) => setQuery(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
          <div class={styles.iconGrid} role="group" aria-label="Project icon">
            <For each={searchIcons(query())}>
              {(entry) => (
                <button
                  type="button"
                  class={styles.iconTile}
                  classList={{ [styles.iconSelected]: sel().icon === entry.name }}
                  aria-pressed={sel().icon === entry.name}
                  title={entry.name}
                  onClick={() => setSel({ icon: entry.name })}
                >
                  <Icon icon={entry.icon} />
                </button>
              )}
            </For>
          </div>

          <div class={styles.modalActions}>
            <Button onClick={() => props.onCancel()}>Cancel</Button>
            <Button variant="primary" disabled={props.busy} onClick={() => confirm()}>
              {props.busy ? "Working…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
