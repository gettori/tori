import { For, Show } from "solid-js";
import { Pencil, X } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import FileIcon from "../../seti/FileIcon";
import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import styles from "./BookmarksPanel.module.css";

export type BookmarkRow = { path: string; line: number; label?: string };

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** A row's second line: where the file is, without repeating its name. Relative
 *  to the workspace, because the root is the same for every row and would push
 *  the part that differs off the edge. */
function folderOf(path: string, root: string | null): string {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (root && dir === root) return "";
  return root && dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir;
}

/**
 * The lines you marked, across this workspace.
 *
 * Reads rows rather than the store, so it neither knows how bookmarks are kept
 * nor which workspace is showing: the pane owns both, the same way it owns the
 * jump list the omnibox reads.
 *
 * Ordered by path then line, from `bookmarkRows`. Deliberately not by when they
 * were made: a list that reorders itself as you mark things is one you cannot
 * learn the shape of, and the recency answer is what the jump list is for.
 */
export default function BookmarksPanel(props: {
  rows: readonly BookmarkRow[];
  root: string | null;
  onLabel: (row: BookmarkRow) => void;
  onRemove: (row: BookmarkRow) => void;
}) {
  return (
    <div class={styles.panel}>
      <Show
        when={props.rows.length}
        fallback={
          <div class={styles.empty}>
            No bookmarks yet. Click the gutter beside a line to mark it.
          </div>
        }
      >
        <For each={props.rows}>
          {(row) => (
            <div class={styles.row}>
              <button
                class={styles.go}
                title={`${row.path}:${row.line}`}
                onClick={() => emitWith(OPEN_IN_EDITOR, { path: row.path, line: row.line })}
              >
                <FileIcon name={basename(row.path)} />
                <span class={styles.name}>
                  {basename(row.path)}
                  <span class={styles.line}>:{row.line}</span>
                </span>
                {/* The label when there is one, the folder when there is not.
                    A row can spare one line of context, and a name someone
                    chose says more than a path they already know. */}
                <span class={styles.detail}>{row.label ?? folderOf(row.path, props.root)}</span>
              </button>
              <IconButton
                icon={<Icon icon={Pencil} />}
                title={row.label ? "Rename this bookmark" : "Name this bookmark"}
                onClick={() => props.onLabel(row)}
              />
              <IconButton
                icon={<Icon icon={X} />}
                title="Remove this bookmark"
                onClick={() => props.onRemove(row)}
              />
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
