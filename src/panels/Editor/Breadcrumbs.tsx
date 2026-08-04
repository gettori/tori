import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight } from "lucide-solid";
import Icon from "../../components/Icon/Icon";
import Menu, { MenuRow } from "../../components/Menu/Menu";
import SymbolIcon from "../../components/SymbolIcon/SymbolIcon";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import { symbolsFor, type SymbolNode } from "../../utils/symbols";
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

/** An open picker: where it hangs, and which of the two lists it is showing.
 *  One signal rather than two, because only one can be open at a time and two
 *  would have to be kept from disagreeing about that. */
type Picker =
  | { x: number; y: number; right: number; kind: "dir"; dir: string }
  | { x: number; y: number; right: number; kind: "symbol"; nodes: readonly SymbolNode[] };

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

  const [picker, setPicker] = createSignal<Picker | null>(null);
  // Only the directory list needs fetching; the symbol list is already in hand.
  const openDir = () => {
    const p = picker();
    return p?.kind === "dir" ? p.dir : null;
  };
  const openSymbols = () => {
    const p = picker();
    return p?.kind === "symbol" ? p.nodes : null;
  };
  const [entries] = createResource(openDir, readDir);

  /** Hang a picker off the crumb that was clicked, not off the pointer: the bar
   *  is a row of small targets, and a menu that appeared wherever the click
   *  landed would sit under a different crumb each time. */
  function anchor(e: MouseEvent & { currentTarget: HTMLElement }) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left, y: r.bottom, right: r.right };
  }

  function pickFolder(e: MouseEvent & { currentTarget: HTMLElement }, crumb: PathCrumb) {
    // A folder crumb lists itself; the file crumb lists what it sits beside.
    setPicker({ ...anchor(e), kind: "dir", dir: crumb.isDir ? crumb.path : dirOf(crumb.path) });
  }

  function pickSymbol(e: MouseEvent & { currentTarget: HTMLElement }, depth: number) {
    setPicker({ ...anchor(e), kind: "symbol", nodes: siblingsAt(nodes(), trail(), depth) });
  }

  function goTo(d: OpenInEditor) {
    setPicker(null);
    // The one recording site: going through the event is what earns this pick
    // its jump-list entry, exactly like a tree click or a go-to-definition.
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, d);
  }

  return (
    <Show when={crumbs().length}>
      <nav class={styles.bar} aria-label="Breadcrumbs">
        <For each={crumbs()}>
          {(crumb, i) => (
            <>
              <Show when={i()}>
                <Sep />
              </Show>
              <button class={styles.crumb} onClick={(e) => pickFolder(e, crumb)}>
                {crumb.name}
              </button>
            </>
          )}
        </For>
        <For each={trail()}>
          {(node, i) => (
            <>
              <Sep />
              <button class={styles.crumb} onClick={(e) => pickSymbol(e, i())}>
                <SymbolIcon kind={node.kind} class={styles.kind} />
                {node.name}
              </button>
            </>
          )}
        </For>
      </nav>
      {/* Not `keyed`: drilling into a subfolder is a new picker object, and a
          keyed Show would unmount and remount the whole menu for it, replaying
          the popover's unpainted placement frame in the middle of navigating. */}
      <Show when={picker()}>
        {(open) => (
          <Menu x={open().x} y={open().y} right={open().right} onClose={() => setPicker(null)}>
            <Show
              when={openSymbols()}
              fallback={
                <Show when={!entries.loading} fallback={<MenuRow disabled>Reading the folder…</MenuRow>}>
                  <Show
                    when={entries()}
                    fallback={<MenuRow disabled>Could not read this folder.</MenuRow>}
                  >
                    {(list) => (
                      <Rows
                        each={list()}
                        empty="This folder is empty."
                        row={(entry) => (
                          <MenuRow
                            // A folder leads further into the picker rather than
                            // committing a choice; closing here would shut the
                            // menu the row was navigating within.
                            keepOpen={entry.is_dir}
                            onClick={() =>
                              entry.is_dir
                                ? setPicker((p) => (p?.kind === "dir" ? { ...p, dir: entry.path } : p))
                                : goTo({ path: entry.path })
                            }
                          >
                            <span
                              class="tab-name"
                              aria-current={entry.path === props.path ? "true" : undefined}
                              classList={{
                                [styles.dimmed]: entry.ignored,
                                [styles.here]: entry.path === props.path,
                              }}
                            >
                              {entry.name}
                            </span>
                            <Show when={entry.is_dir}>
                              <Icon icon={ChevronRight} />
                            </Show>
                          </MenuRow>
                        )}
                      />
                    )}
                  </Show>
                </Show>
              }
            >
              {(nodes) => (
                <Rows
                  each={nodes()}
                  empty="No symbols at this level."
                  row={(node) => (
                    <MenuRow
                      onClick={() =>
                        goTo({ path: node.path, line: node.selectLine, col: node.selectColumn })
                      }
                    >
                      <SymbolIcon kind={node.kind} />
                      <span class="tab-name">{node.name}</span>
                    </MenuRow>
                  )}
                />
              )}
            </Show>
          </Menu>
        )}
      </Show>
    </Show>
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
