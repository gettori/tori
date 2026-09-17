import { createMemo, createSignal, For, Show } from "solid-js";
import { FileText, Folder, FolderGit2 } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";

// The visible "Type <name> to confirm" line is also the field's accessible name
// (the `aria-labelledby` convention `NewProjectDialog` set in #99), so the two
// cannot drift apart. Static id: only one of these can be open at a time.
const CONFIRM_LABEL = "confirm-delete-space-label";

// One direct child of the space folder, as returned by `space_delete_preview`.
export type DeleteEntry = {
  name: string;
  kind: "repo" | "folder" | "file";
  dirty: boolean;
  unpushed: boolean;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const KIND_GLYPH = { repo: FolderGit2, folder: Folder, file: FileText } as const;

/**
 * The confirmation for an unrecoverable delete, with the facts that decide the
 * answer rather than a warning that asks for one.
 *
 * **The consequence is stated once, in plain ink.** Red body copy above a red
 * button competes with it, and the button is the thing that needs the colour.
 * What is red here is what is actually at risk: the unpushed count, and the
 * rows carrying it.
 *
 * **Rows with unpushed work sort to the top**, because that is the only part of
 * a delete that cannot be got back. Everything else on disk was either pushed
 * or was never worth keeping.
 *
 * The shell is `Dialog`. Enter stays on the **input**, deliberately not on the
 * panel as its siblings in this set do: the gate is a field, and answering the
 * key from anywhere in the dialog would widen it to the whole surface. Escape is
 * Kobalte's, reported as `onClose`.
 */
export default function ConfirmDeleteSpace(props: {
  spaceName: string;
  /** The folder about to go, for display: already folded to `~` by the caller,
   *  which is the half of this that knows the home directory. */
  path: string;
  entries: DeleteEntry[];
  loading: boolean;
  runningCount: number;
  sizeBytes: number | null;
  // Optional copy overrides so the same dialog serves a plain folder, not only a
  // space (defaults keep the space wording).
  title?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = createSignal("");
  const matches = () => value() === props.spaceName;
  let input: HTMLInputElement | undefined;

  // At-risk first, then whatever order the preview arrived in (the backend
  // sorts by name). A stable sort, so the tail keeps that order.
  const rows = createMemo(() =>
    [...props.entries].sort((a, b) => Number(b.unpushed) - Number(a.unpushed)),
  );
  const unpushedCount = () => props.entries.filter((e) => e.unpushed).length;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (matches()) props.onConfirm();
  }

  return (
    <Dialog
      open
      size="sheet"
      title={props.title ?? `Delete space “${props.spaceName}”?`}
      onClose={() => props.onCancel()}
      initialFocus={() => input}
      actions={
        <>
          {/* Why the button is off, beside the button, rather than a tooltip on
              a disabled control nothing can hover. It goes once it is armed:
              the answer to it is on screen by then. */}
          <Show when={!matches()}>
            <span class={styles.armHint}>Name must match to continue.</span>
          </Show>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="danger" disabled={!matches()} onClick={() => props.onConfirm()}>
            {props.confirmLabel ?? "Delete space"}
          </Button>
        </>
      }
    >
      <div class={styles.spaceForm}>
        <div class={styles.consequence}>
          This deletes the folder <span class={styles.consequencePath}>{props.path}</span> and
          everything below it from disk. It cannot be undone.
        </div>

        <div class={styles.statRow}>
          <div class={styles.stat}>
            <div class={styles.statLabel}>Agents running</div>
            <div class={styles.statValue}>{props.runningCount}</div>
          </div>
          <div class={styles.stat}>
            <div class={styles.statLabel}>On disk</div>
            <div class={styles.statValue}>
              {props.sizeBytes === null ? "…" : formatBytes(props.sizeBytes)}
            </div>
          </div>
          <div class={styles.stat} classList={{ [styles.statAtRisk]: unpushedCount() > 0 }}>
            <div class={styles.statLabel}>Unpushed</div>
            <div class={styles.statValue}>
              <Show when={!props.loading} fallback="…">
                {unpushedCount()} {unpushedCount() === 1 ? "repo" : "repos"}
              </Show>
            </div>
          </div>
        </div>

        <div class={styles.spaceField}>
          <div class={styles.spaceLabel}>Contents</div>
          <div class={styles.contents}>
            <Show
              when={rows().length}
              fallback={<div class={styles.contentsEmpty}>No contents (empty space)</div>}
            >
              <For each={rows()}>
                {(e) => (
                  <div class={styles.contentsRow}>
                    <Icon
                      icon={KIND_GLYPH[e.kind]}
                      class={e.unpushed ? styles.rowGlyphAtRisk : styles.rowGlyph}
                      aria-hidden="true"
                    />
                    <span class={styles.rowName}>{e.name}</span>
                    <span class={styles.rowBadges}>
                      <Show when={e.kind === "repo" && props.loading}>
                        <span class={styles.rowNote}>checking…</span>
                      </Show>
                      <Show when={!props.loading && e.dirty}>
                        <span class={styles.badge}>uncommitted</span>
                      </Show>
                      <Show when={!props.loading && e.unpushed}>
                        <span class={styles.badge}>unpushed</span>
                      </Show>
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

        <div class={styles.spaceField}>
          <div id={CONFIRM_LABEL} class={styles.spaceLabel}>
            Type <span class={styles.inlineName}>{props.spaceName}</span> to confirm
          </div>
          <input
            ref={input}
            class={`${styles.spaceInput} ${styles.monoInput}`}
            classList={{ [styles.armed]: matches() }}
            aria-labelledby={CONFIRM_LABEL}
            value={value()}
            placeholder={props.spaceName}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
        </div>
      </div>
    </Dialog>
  );
}
