import { createMemo, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { EditorSelection, type EditorState, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers, type Command, type Panel } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from "lucide-solid";
import { InlineToggle } from "./SearchFields";
import styles from "./FindWidget.module.css";

// A literal class, as the minimap's is: the element lives in CodeMirror's DOM
// and the theme below has to name it.
const FIND_CLASS = "cm-tori-find";

const MATCH_CAP = 9999;

type Match = { from: number; to: number };
type Matches = { ranges: Match[]; capped: boolean };
type QueryPatch = Partial<Pick<SearchQuery, "search" | "replace" | "caseSensitive" | "wholeWord" | "regexp">>;

// Shared by every editor, so the replace row a user opened in one file is still
// open in the next, as it is in VS Code.
const [replaceOpen, setReplaceOpen] = createSignal(false);

function collectMatches(query: SearchQuery, state: EditorState): Matches {
  const ranges: Match[] = [];
  if (!query.valid) return { ranges, capped: false };
  const cursor = query.getCursor(state);
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    if (ranges.length === MATCH_CAP) return { ranges, capped: true };
    ranges.push({ from: m.value.from, to: m.value.to });
  }
  return { ranges, capped: false };
}

function indexOfMatch(ranges: Match[], selected: SelectionRange): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].from < selected.from) lo = mid + 1;
    else if (ranges[mid].from > selected.from) hi = mid - 1;
    else return ranges[mid].to === selected.to ? mid : -1;
  }
  return -1;
}

function nearestMatch(query: SearchQuery, state: EditorState): SelectionRange | null {
  if (!query.valid) return null;
  let m = query.getCursor(state, state.selection.main.from).next();
  if (m.done) m = query.getCursor(state).next();
  return m.done ? null : EditorSelection.range(m.value.from, m.value.to);
}

// CodeMirror's default scrolls a match only just into view, which parks one
// from below on the bottom edge and can leave one from above under the widget.
function revealMatch(range: SelectionRange, view: EditorView) {
  const host = view.dom.querySelector<HTMLElement>(`.${FIND_CLASS}`);
  const covered = host ? host.offsetTop + host.offsetHeight : 0;
  const line = view.lineBlockAt(range.head);
  const top = view.scrollDOM.scrollTop - view.documentPadding.top;
  const onScreen = line.top >= top + covered && line.bottom <= top + view.scrollDOM.clientHeight;
  return EditorView.scrollIntoView(range, { y: onScreen ? "nearest" : "center" });
}

function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = FIND_CLASS;
  let findInput!: HTMLInputElement;

  const [query, setQuery] = createSignal(getSearchQuery(view.state));
  const [matches, setMatches] = createSignal(collectMatches(query(), view.state));
  const [selected, setSelected] = createSignal(view.state.selection.main);
  const [readOnly, setReadOnly] = createSignal(view.state.readOnly);

  const current = createMemo(() => indexOfMatch(matches().ranges, selected()));
  const none = () => matches().ranges.length === 0;
  const status = () => {
    const q = query();
    if (!q.search) return "";
    if (!q.valid) return "Invalid";
    const { ranges, capped } = matches();
    if (ranges.length === 0) return "No results";
    const total = `${ranges.length}${capped ? "+" : ""}`;
    return current() >= 0 ? `${current() + 1}/${total}` : total;
  };

  function commit(patch: QueryPatch) {
    const q = query();
    const next = new SearchQuery({
      search: q.search,
      replace: q.replace,
      caseSensitive: q.caseSensitive,
      wholeWord: q.wholeWord,
      regexp: q.regexp,
      literal: q.literal,
      ...patch,
    });
    if (next.eq(q)) return;
    // Typing in the replace field must not move the caret off the match it is
    // about to replace.
    const near = "replace" in patch ? null : nearestMatch(next, view.state);
    if (!near) return view.dispatch({ effects: setSearchQuery.of(next) });
    view.dispatch({
      selection: near,
      effects: [setSearchQuery.of(next), revealMatch(near, view)],
      userEvent: "select.search",
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (runScopeHandlers(view, e, "search-panel")) return e.preventDefault();
    if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    if (e.target !== findInput) (e.metaKey ? replaceAll : replaceNext)(view);
    else if (e.altKey) {
      selectMatches(view);
      view.focus();
    } else (e.shiftKey ? findPrevious : findNext)(view);
  }

  // Native listeners, not Solid's delegated ones: this root sits inside
  // CodeMirror's DOM, and a key must be claimed before it bubbles out of it.
  dom.addEventListener("keydown", onKeyDown);
  // A click on a button leaves the focus in whichever field or editor had it,
  // so Enter keeps stepping after a mouse press on an arrow.
  dom.addEventListener("mousedown", (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  });

  const dispose = render(
    () => (
      <div class={styles.widget} role="search">
        <Show when={!readOnly()}>
          <button
            type="button"
            class={styles.expand}
            aria-label="Toggle Replace"
            aria-expanded={replaceOpen()}
            onClick={() => setReplaceOpen(!replaceOpen())}
          >
            {replaceOpen() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </Show>
        <div class={styles.rows}>
          <div class={styles.row}>
            <div class={styles.field} classList={{ [styles.miss]: !!query().search && none() }}>
              <input
                ref={(el) => {
                  // What `openSearchPanel` looks for when Mod-f is pressed again.
                  el.setAttribute("main-field", "true");
                  findInput = el;
                }}
                class={styles.text}
                type="text"
                spellcheck={false}
                placeholder="Find"
                aria-label="Find"
                value={query().search}
                onInput={(e) => commit({ search: e.currentTarget.value })}
              />
              <span class={styles.status} aria-live="polite">
                {status()}
              </span>
              <InlineToggle
                icon={CaseSensitive}
                label="Match Case"
                active={query().caseSensitive}
                onClick={() => commit({ caseSensitive: !query().caseSensitive })}
              />
              <InlineToggle
                icon={WholeWord}
                label="Match Whole Word"
                active={query().wholeWord}
                onClick={() => commit({ wholeWord: !query().wholeWord })}
              />
              <InlineToggle
                icon={Regex}
                label="Use Regular Expression"
                active={query().regexp}
                onClick={() => commit({ regexp: !query().regexp })}
              />
            </div>
            <InlineToggle
              icon={ArrowUp}
              label="Previous Match (Shift+Enter)"
              disabled={none()}
              onClick={() => findPrevious(view)}
            />
            <InlineToggle
              icon={ArrowDown}
              label="Next Match (Enter)"
              disabled={none()}
              onClick={() => findNext(view)}
            />
            <InlineToggle icon={X} label="Close (Escape)" onClick={() => closeSearchPanel(view)} />
          </div>
          <Show when={replaceOpen() && !readOnly()}>
            <div class={styles.row}>
              <div class={`${styles.field} ${styles.wide}`}>
                <input
                  class={styles.text}
                  type="text"
                  spellcheck={false}
                  placeholder="Replace"
                  aria-label="Replace"
                  value={query().replace}
                  onInput={(e) => commit({ replace: e.currentTarget.value })}
                />
                <InlineToggle
                  icon={Replace}
                  label="Replace (Enter)"
                  disabled={none()}
                  onClick={() => replaceNext(view)}
                />
                <InlineToggle
                  icon={ReplaceAll}
                  label="Replace All (Cmd+Enter)"
                  disabled={none()}
                  onClick={() => replaceAll(view)}
                />
              </div>
            </div>
          </Show>
        </div>
      </div>
    ),
    dom,
  );

  // Through `requestMeasure`: this runs from the panel's `update`, where a
  // layout read throws.
  const clearMinimap = {
    key: dom,
    read: (v: EditorView) => v.dom.querySelector<HTMLElement>(".cm-minimap-gutter")?.offsetWidth ?? 0,
    write: (inset: number) => dom.style.setProperty("--find-inset", `${inset}px`),
  };

  return {
    dom,
    top: true,
    mount() {
      findInput.focus();
      findInput.select();
      view.requestMeasure(clearMinimap);
    },
    update(u) {
      const next = getSearchQuery(u.state);
      const queryChanged = !next.eq(query());
      if (queryChanged) setQuery(next);
      if (queryChanged || u.docChanged) setMatches(collectMatches(next, u.state));
      if (u.selectionSet || u.docChanged) setSelected(u.state.selection.main);
      setReadOnly(u.state.readOnly);
      if (u.geometryChanged || u.transactions.some((tr) => tr.reconfigured)) view.requestMeasure(clearMinimap);
    },
    destroy: dispose,
  };
}

const openReplace: Command = (view) => {
  if (view.state.readOnly) return false;
  setReplaceOpen(true);
  return openSearchPanel(view);
};

const edge = "calc(14px * var(--ui-scale) + var(--find-inset, 0px))";

const findTheme = EditorView.baseTheme({
  // The panel takes no height: it hangs off the top panel strip, over the code,
  // so opening find does not push the file down.
  [`.${FIND_CLASS}`]: {
    position: "absolute",
    top: "calc(6px * var(--ui-scale))",
    right: edge,
    maxWidth: `calc(100% - ${edge} - 14px * var(--ui-scale))`,
  },
  // The strip's own border would otherwise draw a line across an empty strip.
  [`.cm-panels-top:has(> .${FIND_CLASS}:only-child)`]: { borderBottom: "none" },
});

/** Find and replace as VS Code draws it: a widget over the top right corner. */
export function findWidget(): Extension {
  return [
    search({ top: true, createPanel: createFindPanel, scrollToMatch: revealMatch }),
    keymap.of([{ key: "Mod-Alt-f", run: openReplace, scope: "editor search-panel" }]),
    findTheme,
  ];
}
