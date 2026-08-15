import { For, Show, createMemo, createResource, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Dropdown from "../../components/Menu/Dropdown";
import { MenuRow, MenuSub } from "../../components/Menu/rows";
import SymbolIcon from "../../components/SymbolIcon/SymbolIcon";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import { symbolsFor } from "../../utils/symbols";
import { pathCrumbs, siblingsAt, symbolTrail, dirOf, type PathCrumb } from "./breadcrumbTrail";
import styles from "./Breadcrumbs.module.css";

type Entry = { name: string; path: string; is_dir: boolean; ignored: boolean };

// The same one the tree hides. A picker that offered `.git` would be offering
// to open git's internals in an editor.
const HIDDEN = new Set([".git"]);

/** Null for a folder that could not be read, which is not the same answer as a
 *  folder with nothing in it. The tree can swallow the difference because it
 *  shows nothing either way; a picker has to say a sentence, and "this folder is
 *  empty" is a claim a failed read cannot support. */
async function readDir(path: string): Promise<Entry[] | null> {
  try {
    const list = await invoke<Entry[]>("fs_read_dir", { path });
    return list.filter((e) => !HIDDEN.has(e.name));
  } catch {
    return null;
  }
}

/**
 * Where the file sits, and where the caret sits inside it.
 *
 * Reads the symbol store rather than asking a server, the same way
 * `OutlinePanel` does and for the same reason: the editor holds the only live
 * client, so it publishes once and every symbol surface reads. The path half
 * needs no server at all, which is why the bar still renders (and its pickers
 * still work) for a plain text file in a project with no language server.
 *
 * Every crumb is a picker, not a link. Opening the file you are already looking
 * at is the one thing a breadcrumb click can never usefully do, so a click
 * offers what you could have opened instead: the folder's other entries, or the
 * symbol's siblings.
 *
 * **A crumb is its own menu's trigger.** Every other dropdown in Sway is a
 * `Tooltip`'s element already and needs a wrapper around it; a crumb is a plain
 * button, so it can be the trigger itself, which is also what puts
 * `aria-haspopup` and `aria-expanded` on the thing the keyboard actually
 * reaches. Nothing here holds an open-menu signal either: one menu per crumb is
 * what replaced the single `picker()` that used to say where the one menu hung
 * and which of two lists it was showing.
 */
export default function Breadcrumbs(props: {
  root: string | null;
  path: string | null;
  /** The caret in the active file, or null when there is no caret to speak of
   *  (nothing open, or a caret last seen in a file that is no longer shown).
   *  Null renders the path half alone rather than a stale symbol trail. */
  caret: { line: number; column: number } | null;
}) {
  const crumbs = createMemo(() => pathCrumbs(props.root, props.path));
  const nodes = createMemo(() => symbolsFor(props.path));
  const trail = createMemo(() => {
    const at = props.caret;
    return at ? symbolTrail(nodes(), at.line, at.column) : [];
  });

  function goTo(d: OpenInEditor) {
    // The one recording site: going through the event is what earns this pick
    // its jump-list entry, exactly like a tree click or a go-to-definition.
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, d);
  }

  // A folder crumb lists itself; the file crumb lists what it sits beside.
  const dirFor = (crumb: PathCrumb) => (crumb.isDir ? crumb.path : dirOf(crumb.path));

  return (
    <Show when={crumbs().length}>
      <nav class={styles.bar} aria-label="Breadcrumbs">
        <For each={crumbs()}>
          {(crumb, i) => (
            <>
              <Show when={i()}>
                <Sep />
              </Show>
              <Crumb menu={<DirLevel dir={dirFor(crumb)} here={props.path} onPick={goTo} />}>
                {crumb.name}
              </Crumb>
            </>
          )}
        </For>
        <For each={trail()}>
          {(node, i) => (
            <>
              <Sep />
              <Crumb
                menu={
                  <Rows
                    each={siblingsAt(nodes(), trail(), i())}
                    empty="No symbols at this level."
                    row={(sibling) => (
                      <MenuRow
                        onClick={() =>
                          goTo({
                            path: sibling.path,
                            line: sibling.selectLine,
                            col: sibling.selectColumn,
                          })
                        }
                      >
                        <SymbolIcon kind={sibling.kind} />
                        <span class="tab-name">{sibling.name}</span>
                      </MenuRow>
                    )}
                  />
                }
              >
                <SymbolIcon kind={node.kind} class={styles.kind} />
                {node.name}
              </Crumb>
            </>
          )}
        </For>
      </nav>
    </Show>
  );
}

/** One crumb, and the menu it opens under itself. `bottom-start` is the whole of
 *  what the old `right` anchor field bought: it never end-aligned anything, it
 *  described the crumb's span so the hand-rolled clamp could keep a wide menu on
 *  screen, and Kobalte anchors on the trigger's real rect and flips for itself. */
function Crumb(props: { menu: JSX.Element; children: JSX.Element }) {
  return (
    <Dropdown as="button" type="button" class={styles.crumb} placement="bottom-start" menu={props.menu}>
      {props.children}
    </Dropdown>
  );
}

/**
 * One folder's entries, with each subfolder as a level that opens beside it.
 *
 * Recursive, and lazily so: `MenuSub` mounts a level's contents only while that
 * level is open, so this `createResource` is what makes "one folder read per
 * folder opened" true rather than a hope. Descending used to mutate the open
 * picker's `dir` in place, which meant the level you came from left the screen
 * and the only way back was Escape.
 */
function DirLevel(props: { dir: string; here: string | null; onPick: (d: OpenInEditor) => void }) {
  const [entries] = createResource(() => props.dir, readDir);

  return (
    <Show when={!entries.loading} fallback={<MenuRow disabled>Reading the folder…</MenuRow>}>
      <Show when={entries()} fallback={<MenuRow disabled>Could not read this folder.</MenuRow>}>
        {(list) => (
          <Rows
            each={list()}
            empty="This folder is empty."
            row={(entry) => (
              <Show
                when={entry.is_dir}
                fallback={
                  <MenuRow onClick={() => props.onPick({ path: entry.path })}>
                    <EntryName entry={entry} here={props.here} />
                  </MenuRow>
                }
              >
                <MenuSub
                  label={<EntryName entry={entry} here={props.here} />}
                  textValue={entry.name}
                >
                  <DirLevel dir={entry.path} here={props.here} onPick={props.onPick} />
                </MenuSub>
              </Show>
            )}
          />
        )}
      </Show>
    </Show>
  );
}

/** Gitignored entries are dimmed rather than hidden, matching the tree:
 *  node_modules is somewhere people do go, just not often. The file already open
 *  is marked rather than dropped, since its absence from its own folder's list
 *  would read as the list being wrong. */
function EntryName(props: { entry: Entry; here: string | null }) {
  return (
    <span
      class="tab-name"
      aria-current={props.entry.path === props.here ? "true" : undefined}
      classList={{
        [styles.dimmed]: props.entry.ignored,
        [styles.here]: props.entry.path === props.here,
      }}
    >
      {props.entry.name}
    </span>
  );
}

function Sep() {
  return (
    <span class={styles.sep} aria-hidden="true">
      <Icon icon={ChevronRight} />
    </span>
  );
}

/** A list, or one row saying why there is none. An empty menu is a menu that
 *  looks broken; the sentence is what says the folder really is empty. */
function Rows<T>(props: { each: readonly T[]; empty: string; row: (item: T) => JSX.Element }) {
  return (
    <Show when={props.each.length} fallback={<MenuRow disabled>{props.empty}</MenuRow>}>
      <For each={props.each}>{props.row}</For>
    </Show>
  );
}
