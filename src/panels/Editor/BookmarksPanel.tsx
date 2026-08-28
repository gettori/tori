import { For, Index, Show } from "solid-js";
import { Pencil, X } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import Tooltip from "../../components/Tooltip/Tooltip";
import FileIcon from "../../seti/FileIcon";
import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import { groupByMemberRoot, memberSectionsHeaded, type MemberRoot } from "../../utils/featureMembers";
import MemberSection from "../../components/MemberSection/MemberSection";
import styles from "./BookmarksPanel.module.css";

export type BookmarkRow = { path: string; line: number; label?: string };

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** A row's second line: where the file is, without repeating its name. Relative
 *  to its own root, because that part is the same for every row under it and
 *  would push the part that differs off the edge. Inside a Feature that root is
 *  the member the file is in, not the member you happen to be looking at. */
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
 *
 * Inside a Feature the rows already span every member, because the store keys on
 * `feature:<id>`; what the members add is which repo each row is in, and a mark
 * under none of them still shows, in a trailing section of its own. Removing a
 * repository keeps its worktree by default, so those files are still on disk.
 */
export default function BookmarksPanel(props: {
  rows: readonly BookmarkRow[];
  root: string | null;
  /** The multi-root form, one section per Feature member. A branch unit passes
   *  none and every row is relative to its single root. */
  roots?: MemberRoot[];
  onLabel: (row: BookmarkRow) => void;
  onRemove: (row: BookmarkRow) => void;
}) {
  const scope = (): MemberRoot[] => {
    if (props.roots) return props.roots;
    return props.root ? [{ path: props.root, repoPath: props.root, label: "" }] : [];
  };
  const headed = () => memberSectionsHeaded(props.roots);
  const sections = () => groupByMemberRoot(props.rows, (r) => r.path, scope());

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
        {/* `Index`, not `For`: the sections are rebuilt whenever a mark is added
            or removed, and a referentially-keyed list would remount each one
            and reopen a member the reader had collapsed. */}
        <Index each={sections()}>
          {(section) => (
            <MemberSection root={section().root} headed={headed()} count={section().items.length}>
              <For each={section().items}>
                {(row) => (
                  <div class={styles.row}>
                    {/* No `aria-label`: the spans below are the file's name and
                        where it is, which is what the row should be called. A
                        label here would replace both with the bare path. */}
                    <Tooltip
                      as="button"
                      type="button"
                      class={styles.go}
                      label={`${row.path}:${row.line}`}
                      onClick={() => emitWith(OPEN_IN_EDITOR, { path: row.path, line: row.line })}
                    >
                      <FileIcon name={basename(row.path)} />
                      <span class={styles.name}>
                        {basename(row.path)}
                        <span class={styles.line}>:{row.line}</span>
                      </span>
                      {/* The label when there is one, the folder when there is
                          not. A row can spare one line of context, and a name
                          someone chose says more than a path they already
                          know. */}
                      <span class={styles.detail}>
                        {row.label ?? folderOf(row.path, section().root?.path ?? null)}
                      </span>
                    </Tooltip>
                    <IconButton
                      icon={<Icon icon={Pencil} />}
                      tooltip={row.label ? "Rename this bookmark" : "Name this bookmark"}
                      onClick={() => props.onLabel(row)}
                    />
                    <IconButton
                      icon={<Icon icon={X} />}
                      tooltip="Remove this bookmark"
                      onClick={() => props.onRemove(row)}
                    />
                  </div>
                )}
              </For>
            </MemberSection>
          )}
        </Index>
      </Show>
    </div>
  );
}
