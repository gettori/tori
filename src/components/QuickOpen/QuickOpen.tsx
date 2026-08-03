import { createSignal, createMemo, createEffect, on, onCleanup, onMount, For, Match, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, OPEN_IN_EDITOR } from "../../utils/events";
import FileIcon from "../../seti/FileIcon";
import SymbolIcon from "../SymbolIcon/SymbolIcon";
import { fuzzyScore } from "../../utils/fuzzy";
import { debounce } from "../../utils/debounce";
import { editorState } from "../../utils/editorState";
import { flattenSymbols, searchWorkspaceSymbols, symbolsFor, type SymbolNode } from "../../utils/symbols";
import styles from "./QuickOpen.module.css";

const MAX_RESULTS = 200;

// A leading `@` searches the open file's symbols, a leading `#` searches every
// running server's. Both are the prefixes VS Code uses, and both are one
// keystroke from the file finder rather than a separate palette to learn.
const DOC_PREFIX = "@";
const WS_PREFIX = "#";

type Mode = "file" | "doc" | "workspace";

type Row = { kind: "file"; rel: string } | { kind: "symbol"; node: SymbolNode };

function modeOf(query: string): Mode {
  if (query.startsWith(DOC_PREFIX)) return "doc";
  if (query.startsWith(WS_PREFIX)) return "workspace";
  return "file";
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** ⌘P fuzzy finder overlay: files by default, the active file's symbols after
 *  `@`, the whole project's symbols after `#`. Loads the project file list once
 *  on open; typing filters, ↑/↓ navigate, Enter opens, Esc closes. */
export default function QuickOpen(props: { root: string | null; onClose: () => void }) {
  const [files, setFiles] = createSignal<string[]>([]);
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const [wsHits, setWsHits] = createSignal<SymbolNode[]>([]);
  let input!: HTMLInputElement;

  const mode = () => modeOf(query());
  // The query with its mode prefix removed. Trimmed, so `@ foo` behaves.
  const term = () => (mode() === "file" ? query().trim() : query().slice(1).trim());

  // `workspace/symbol` is a round trip per running server, so it is not sent on
  // every keystroke. A token guards the order: a slow answer to an older query
  // must not overwrite a fast answer to a newer one.
  let wsToken = 0;
  // The debounce's timer cannot be cancelled, so closing the palette bumps the
  // token instead. Without it, Esc within the debounce window still sends a
  // request to every live server for a palette nobody is looking at.
  let closed = false;
  onCleanup(() => (closed = true));
  const runWorkspaceSearch = debounce((q: string) => {
    if (closed) return;
    const token = ++wsToken;
    void searchWorkspaceSymbols(q).then(
      (hits) => {
        if (token === wsToken) setWsHits(hits);
      },
      () => {
        if (token === wsToken) setWsHits([]);
      },
    );
  }, 180);

  createEffect(
    on([mode, term], ([m, q]) => {
      if (m !== "workspace") return;
      // Clearing first, so the previous query's hits are never shown under the
      // current one's text while the request is in flight.
      setWsHits([]);
      wsToken += 1;
      if (q) runWorkspaceSearch(q);
    }),
  );

  const docSymbols = createMemo(() => flattenSymbols(symbolsFor(editorState().activePath)));

  const results = createMemo<Row[]>(() => {
    const q = term();
    if (mode() === "doc") {
      const all = docSymbols();
      // No query: document order, which is the order the file reads in.
      if (!q) return all.slice(0, MAX_RESULTS).map((node) => ({ kind: "symbol", node }));
      const scored: { node: SymbolNode; score: number }[] = [];
      for (const node of all) {
        const s = fuzzyScore(q, node.name);
        if (s !== null) scored.push({ node, score: s });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, MAX_RESULTS).map((r) => ({ kind: "symbol", node: r.node }));
    }
    if (mode() === "workspace") {
      // Kept in the server's own order rather than re-scored here: it matched
      // the query against a whole index, which is more than a subsequence score
      // over the name can know.
      return wsHits().slice(0, MAX_RESULTS).map((node) => ({ kind: "symbol", node }));
    }
    const all = files();
    if (!q) return all.slice(0, MAX_RESULTS).map((rel) => ({ kind: "file", rel }));
    const scored: { rel: string; score: number }[] = [];
    for (const rel of all) {
      const s = fuzzyScore(q, rel);
      if (s !== null) scored.push({ rel, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => ({ kind: "file", rel: r.rel }));
  });

  // Keep the selection in range as results change.
  createEffect(() => {
    const n = results().length;
    if (index() >= n) setIndex(0);
  });

  onMount(async () => {
    input.focus();
    const root = props.root;
    if (!root) return;
    try {
      setFiles(await invoke<string[]>("list_project_files", { projectPath: root }));
    } catch {
      setFiles([]);
    }
  });

  function open(row: Row) {
    if (row.kind === "file") {
      const root = props.root;
      if (root) emitWith(OPEN_IN_EDITOR, { path: `${root}/${row.rel}` });
    } else {
      // The name, not the body: a class's opening brace is technically the
      // symbol and practically the wrong line to land on.
      emitWith(OPEN_IN_EDITOR, {
        path: row.node.path,
        line: row.node.selectLine,
        col: row.node.selectColumn,
      });
    }
    props.onClose();
  }

  function emptyText(): string {
    if (mode() === "doc") {
      return docSymbols().length ? "No matching symbols" : "No symbols in the open file";
    }
    if (mode() === "workspace") return term() ? "No matching symbols" : "Type to search project symbols";
    return "No matching files";
  }

  function onKeyDown(e: KeyboardEvent) {
    const n = results().length;
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results()[index()];
      if (hit) open(hit);
    }
  }

  return (
    <div class={styles.qoBackdrop} onClick={props.onClose}>
      <div class={styles.qoPanel} onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          class={styles.qoInput}
          placeholder="Go to file… (@ symbol, # project symbol)"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div class={styles.qoList}>
          <Show when={results().length} fallback={<div class={styles.qoEmpty}>{emptyText()}</div>}>
            <For each={results()}>
              {(row, i) => (
                <div
                  class={styles.qoItem}
                  classList={{ [styles.active]: i() === index() }}
                  onClick={() => open(row)}
                  onMouseEnter={() => setIndex(i())}
                >
                  <Switch>
                    <Match when={row.kind === "file" ? row.rel : null}>
                      {(rel) => (
                        <>
                          <FileIcon name={basename(rel())} />
                          <span class={styles.qoName}>{rel()}</span>
                        </>
                      )}
                    </Match>
                    <Match when={row.kind === "symbol" ? row.node : null}>
                      {(node) => (
                        <>
                          <SymbolIcon kind={node().kind} />
                          <span class={styles.qoName}>{node().name}</span>
                          <span class={styles.qoMeta}>
                            {node().container ??
                              (mode() === "workspace" ? basename(node().path) : (node().detail ?? ""))}
                          </span>
                        </>
                      )}
                    </Match>
                  </Switch>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
