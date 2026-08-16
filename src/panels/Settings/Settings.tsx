import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  For,
  Show,
  type Component,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Braces, FileCode, MessageSquare, Palette, Plug, X, type LucideIcon } from "lucide-solid";
import { matchingEntries } from "./utils/settingsSearch";
import { SETTING_TABS, tabOfEntry, type SettingTab } from "../../utils/settingsCatalog";
import { agentHealth, ensureAgentHealthLoaded } from "../../utils/agentHealth";
import { debounce } from "../../utils/debounce";
import Icon from "../../components/Icon/Icon";
import IconButton from "../../components/IconButton/IconButton";
import HarnessPane from "./panes/HarnessPane/HarnessPane";
import AppearancePane from "./panes/AppearancePane/AppearancePane";
import ChatPane from "./panes/ChatPane/ChatPane";
import EditorPane from "./panes/EditorPane/EditorPane";
import IntegrationsPane from "./panes/IntegrationsPane/IntegrationsPane";
import LanguagesPane from "./panes/LanguagesPane/LanguagesPane";
import { overlayRoot } from "./settingsStore";
import { rowDomId, workspaceName, type PaneProps } from "./components/paneKit";
import styles from "./Settings.module.css";

/** Re-exported because the Editor rows moved to `paneKit` when the panel became
 *  six panes, and `editorSection.test.tsx` reads the list from here. */
export { EDITOR_TOGGLES } from "./components/paneKit";

/**
 * The rail's glyphs, resolved from the catalogue's icon *names*.
 *
 * The catalogue stores a name rather than a component on purpose - it is
 * reachable from the terminal's chunk, so six imported icons would land there
 * (see `utils/settingsCatalog.ts`). This is the one place that pays for them,
 * and `settingsPanel.test.tsx` fails if a tab names an icon this map has not
 * got.
 */
const TAB_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  "message-square": MessageSquare,
  "file-code": FileCode,
  braces: Braces,
  palette: Palette,
  plug: Plug,
};

const PANES: Record<SettingTab, Component<PaneProps>> = {
  agents: HarnessPane,
  chat: ChatPane,
  editor: EditorPane,
  languages: LanguagesPane,
  appearance: AppearancePane,
  integrations: IntegrationsPane,
};

/** Trigger and panel ids, supplied rather than left to Kobalte.
 *
 *  Kobalte generates both, but it hands a panel its `aria-labelledby` out of a
 *  plain `Map` that the triggers fill from an effect - so the panel renders
 *  before the map has anything in it, reads `undefined`, and never re-reads,
 *  because a `Map` is not reactive. Naming both ends removes the ordering from
 *  the question entirely. */
const tabId = (id: SettingTab) => `settings-tab-${id}`;
const paneId = (id: SettingTab) => `settings-pane-${id}`;

/** Where an ordinary change lands, named in the rail's footer. Written out
 *  rather than read from the backend: the panel would have to hold a resource
 *  for one line of text, and this path is fixed by `settings.rs`. */
const SETTINGS_PATH = "~/.config/sway/settings.json";

/** What the focus trap counts as a stop. `[hidden]` is not excluded by the
 *  selector, so the inactive panes are filtered out by ancestor below: they are
 *  in the DOM (which is what keeps a pane's scroll position across a category
 *  switch) but must not be reachable by Tab. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** How long the search box has to go quiet before the aggregate is announced.
 *  Long enough to cover typing, short enough that a reader who stops to listen
 *  is not left waiting on it. */
const ANNOUNCE_MS = 500;

/** How long a deep-linked row stays lit. Long enough to catch the eye after the
 *  pane has scrolled, short enough not to sit there as a second selection. */
const FLASH_MS = 1200;

// The in-app settings screen. Reads the reactive settings store and writes back
// through saveSettings (which persists to settings.json and applies live). A
// portaled modal: a category rail beside a detail pane, one header search across
// all of them, Escape / backdrop click to close.
export default function Settings(props: {
  onClose: () => void;
  welcome?: boolean;
  query?: string;
  /** The catalogue id a `Preferences:` command pointed at, revealed on open and
   *  again whenever a later command names a different one. */
  entry?: string;
}) {
  let firstControl: HTMLInputElement | undefined;
  let panelEl!: HTMLDivElement;
  let railEl!: HTMLDivElement;

  /** The filter box. Seeded from the prop rather than bound to it, because a
   *  `Preferences: ...` command opens the panel *at* a setting and the user has
   *  to be able to type past it the moment it lands. */
  const [query, setQuery] = createSignal(props.query ?? "");
  const [active, setActive] = createSignal<SettingTab>("agents");

  /** Typed here, which is not the same as "the box is non-empty": a
   *  `Preferences:` command arrives carrying a query but pointing at one row, so
   *  it lands on that row's category instead of answering across all six. */
  const [typed, setTyped] = createSignal(false);

  /** Which first-run greeting applies. Fetched only in welcome mode, since it
   *  is the only mode that renders one, and a failed fetch falls back to the
   *  ordinary copy rather than blocking the panel. */
  const [onboardingContent] = createResource(
    () => (props.welcome ? true : undefined),
    () => invoke<{ kind: string; supported?: string[] }>("onboarding_content").catch(() => undefined),
  );
  /** "Claude, Codex or OpenCode": an Oxford-comma-free list ending in "or",
   *  because the user needs any one of them, not all of them. */
  const supportedList = createMemo(() => {
    const names = onboardingContent()?.supported ?? [];
    if (names.length === 0) return "one of the agent CLIs Sway supports";
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  });

  const matches = createMemo(() => matchingEntries(query()));
  /** Everything when nothing is typed, only what matched when something is. */
  const shown = (id: string) => {
    const m = matches();
    return !m || m.ids.has(id);
  };
  const searching = () => typed() && matches() !== null;
  const nothingMatched = () => matches()?.total === 0;

  /** What the category holds, not what a query found. Only where there is a
   *  number worth a glance; the rest render nothing rather than a zero. */
  const railBadge = (id: SettingTab) => {
    if (id !== "agents") return undefined;
    const all = agentHealth();
    // Shape-checked, not truthiness: the store is filled from a backend command,
    // and an answer the rail did not expect must cost a badge, not six panes.
    if (!Array.isArray(all) || all.length === 0) return undefined;
    return `${all.filter((a) => a.status !== "notFound").length}/${all.length}`;
  };

  /** A fraction floating beside a word says nothing read aloud, so it joins the
   *  accessible name rather than being left for a reader to stumble into. */
  const tabName = (t: (typeof SETTING_TABS)[number]) => {
    const badge = railBadge(t.id);
    return badge ? `${t.label}, ${badge} installed` : undefined;
  };

  /** Command-initiated queries only, never typing: a palette row is the user
   *  pointing at one setting, and a keystroke is not. */
  function landOn(q: string) {
    setTyped(false);
    const m = matchingEntries(q);
    if (!m || m.total === 0) return;
    const tab = SETTING_TABS.find((t) => m.counts[t.id] > 0);
    if (tab) setActive(tab.id);
  }

  /** Both halves are the point: the rail selects nothing while results are on
   *  screen, so a click there is a request to leave them. */
  function openTab(tab: SettingTab) {
    setActive(tab);
    setQuery("");
    setTyped(false);
  }

  /** Focus *and* a flash, because focus alone is easy to miss on one switch in a
   *  list of switches. Deferred, since selecting the category is what un-hides
   *  the pane and nothing inside a `hidden` subtree can take focus. */
  function revealEntry(id: string) {
    const tab = tabOfEntry(id);
    if (!tab) return;
    // Carrying a query, but naming one row: go there, do not search.
    setTyped(false);
    setActive(tab);
    queueMicrotask(() => {
      const el = document.getElementById(rowDomId(id));
      if (!el) return;
      // Absent in jsdom, and not worth a stub: the scroll is decoration on top
      // of the focus, which is what actually moves the user.
      el.scrollIntoView?.({ block: "center" });
      // **Only a row takes focus.** A card section has no control of its own -
      // its contents are built at runtime - so the first thing inside it is
      // whatever that section happened to render, which for GitHub is a sign-out
      // button. Landing focus on it would arm the next Space or Enter. The
      // scroll and the flash still say "here", which is all a section can offer.
      // Fields before buttons, in two queries: a stepper puts its "−" first, so
      // one combined selector lands focus on the button that decrements it.
      if (el.classList.contains(styles.row)) {
        const field = el.querySelector<HTMLElement>("input, select, textarea");
        (field ?? el.querySelector<HTMLElement>("button"))?.focus();
      }
      el.classList.add(styles.rowFlash);
      setTimeout(() => el.classList.remove(styles.rowFlash), FLASH_MS);
    });
  }

  /** Throttled, because `polite` queues rather than replaces: announcing per
   *  keystroke reads out seven totals, six of them already stale. */
  const [announced, setAnnounced] = createSignal("");
  // Dropped on teardown rather than left to fire: closing the panel mid-search
  // would otherwise leave a timer writing to a signal nothing is listening to.
  let live = true;
  onCleanup(() => (live = false));
  const announce = debounce((text: string) => live && setAnnounced(text), ANNOUNCE_MS);
  createEffect(
    on(matches, (m) => {
      if (!m) return announce("");
      if (m.total === 0) return announce("No settings match");
      announce(`${m.total} ${m.total === 1 ? "setting matches" : "settings match"}`);
    }),
  );

  onMount(() => {
    ensureAgentHealthLoaded();
    if (props.entry) revealEntry(props.entry);
    else if (props.query) landOn(props.query);
    // The search box takes focus on an ordinary open. A deep link has already
    // aimed focus at a row, so stealing it back would undo the whole point.
    if (!props.entry) requestAnimationFrame(() => firstControl?.focus());
  });

  // A later command re-filters a panel that is already open. ⌘K reaches the
  // palette over this modal, and opening an open panel remounts nothing, so
  // without this the row would close the palette and appear to do nothing.
  // Deferred, so it is only a *change* of prop that overwrites what is typed.
  createEffect(
    on(
      () => [props.query, props.entry] as const,
      ([q, entry]) => {
        setQuery(q ?? "");
        if (entry) revealEntry(entry);
        else if (q) landOn(q);
      },
      { defer: true },
    ),
  );

  /**
   * Escape, in two stages whenever there is a query to clear, and Tab kept
   * inside the dialog - which is what `aria-modal` claims.
   *
   * **On the panel, not on `window`.** `ShortcutSheet` listens on the window in
   * the capture phase because a focused terminal swallows keydown before it
   * bubbles; this panel does not need that, because the focus trap below means
   * every keystroke already originates inside it. Reaching for the window here
   * would be actively wrong: ⌘K opens the palette *over* this modal, the palette
   * closes on its own Escape handler, and a capture-phase listener up here would
   * swallow that keystroke and clear this search box instead.
   *
   * `preventDefault` on the clearing press also stops WKWebView clearing the
   * `type="search"` box natively, which would leave the panel filtered by a
   * query the box no longer shows.
   */
  function onPanelKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      // Both, so `typed` never outlives the text it describes.
      if (query() !== "") {
        setQuery("");
        setTyped(false);
      } else props.onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // `[hidden]` excludes the inactive panes, and `tabindex="-1"` the five rail
    // items the roving index has parked: both are still matched by the
    // selector's `button`/`input` clauses, and neither is a stop a real browser
    // would make.
    const items = [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.closest("[hidden]") && el.getAttribute("tabindex") !== "-1",
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey ? at === first : at === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  /**
   * Enter, in the search box: go to the tab with the most matches.
   *
   * The one keystroke that *does* navigate, and it earns it by being a decision
   * rather than a byproduct of typing. Ties resolve to the earliest tab in strip
   * order - `>` keeps the first maximum, so the rule falls out of the scan
   * instead of needing to be applied. Pinned by test, because "whichever tab
   * happened to be scanned last" is what this silently becomes if the comparison
   * is ever loosened to `>=`.
   */
  function onSearchKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    const m = matches();
    if (!m || m.total === 0) return;
    e.preventDefault();
    let best = SETTING_TABS[0];
    for (const t of SETTING_TABS) if (m.counts[t.id] > m.counts[best.id]) best = t;
    if (m.counts[best.id] === 0) return;
    // Not `openTab`: that clears the box, and Enter is a decision about which
    // category to read the results in, not a request to drop them.
    setTyped(false);
    setActive(best.id);
  }

  /**
   * Arrow, Home and End across the rail.
   *
   * Hand-rolled, and this is the one strip in Sway that is: #93 moved the tab
   * strips onto Kobalte, but Kobalte's tabs always hold a selection, and this
   * rail holds none while a search is running - it forces a value back and
   * fires `onChange`, which lands here as the query being cleared under the
   * user. Vertical, so Up and Down move it; both orientations wrap, because a
   * six-item rail has no edge worth stopping at.
   */
  function onRailKeyDown(e: KeyboardEvent) {
    const n = SETTING_TABS.length;
    const current = SETTING_TABS.findIndex((t) => t.id === active());
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (current + 1) % n
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? (current - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : current;
    if (next === current) return;
    e.preventDefault();
    openTab(SETTING_TABS[next].id);
    railEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <Portal>
      <div class={styles.backdrop} onMouseDown={() => props.onClose()}>
        <div
          ref={panelEl}
          class={styles.panel}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onPanelKeyDown}
        >
          <div class={styles.header}>
            <div class={styles.title}>Settings</div>
            <IconButton
              icon={<Icon icon={X} />}
              size="sm"
              aria-label="Close"
              tooltip="Close"
              onClick={() => props.onClose()}
            />
          </div>

          <div class={styles.srOnly} role="status" aria-live="polite">
            {announced()}
          </div>

          <div class={styles.body}>
            <div class={styles.railCol}>
              {/* Above the list, where the sidebar keeps its project filter.
                  One box for the panel, not one per category: inside a pane it
                  would read as filtering that pane alone, and it sits outside
                  the tablist because a tablist owns tabs and a field is not
                  one. */}
              <div class={styles.railSearch}>
                <input
                  ref={firstControl}
                  class={styles.searchInput}
                  type="search"
                  aria-label="Search settings"
                  placeholder="Search all settings"
                  value={query()}
                  onInput={(e) => {
                    setQuery(e.currentTarget.value);
                    setTyped(true);
                  }}
                  onKeyDown={onSearchKeyDown}
                />
              </div>
              {/* The headings are plain text, not items: they group, they do not
                go anywhere, so neither Tab nor an arrow key stops on one.
                Roving tabindex and arrow wrap come from Kobalte, so the rail
                carries no keyboard code of its own; `orientation` on the Root
                is what makes Up and Down the keys that move it. */}
              <div
                ref={railEl}
                class={styles.rail}
                role="tablist"
                aria-orientation="vertical"
                aria-label="Settings sections"
                onKeyDown={onRailKeyDown}
              >
                <For each={SETTING_TABS}>
                  {(t, i) => {
                    const selected = () => !searching() && active() === t.id;
                    return (
                      <>
                        <Show when={i() === 0 || SETTING_TABS[i() - 1].group !== t.group}>
                          <div class={styles.railGroup}>{t.group}</div>
                        </Show>
                        <button
                          type="button"
                          role="tab"
                          id={tabId(t.id)}
                          class={styles.railItem}
                          classList={{ [styles.railItemActive]: selected() }}
                          // On the selected tab only: the attribute is what a
                          // reader follows to jump into the panel, and while a
                          // search is running there is no one panel to jump to.
                          aria-controls={selected() ? paneId(t.id) : undefined}
                          aria-selected={selected()}
                          aria-label={tabName(t)}
                          // Roving tabindex: one stop for the whole rail, so Tab
                          // steps past it into the pane rather than through six.
                          tabindex={active() === t.id ? 0 : -1}
                          onClick={() => openTab(t.id)}
                        >
                          <Icon icon={TAB_ICONS[t.icon]} />
                          <span class={styles.railLabel}>{t.label}</span>
                          <Show when={railBadge(t.id)}>
                            {(badge) => <span class={styles.railBadge}>{badge()}</span>}
                          </Show>
                        </button>
                      </>
                    );
                  }}
                </For>
              </div>

              {/* Where a change lands, which no row on screen can say. Outside
                  the list rather than inside it: a tablist owns tabs, and a
                  paragraph is not one. */}
              <div class={styles.railFoot}>
                <div class={styles.railFootTitle}>Your settings</div>
                <div class={styles.railFootNote}>
                  <Show
                    when={overlayRoot()}
                    fallback={
                      <>
                        Written to <code>{SETTINGS_PATH}</code>, and applied everywhere.
                      </>
                    }
                  >
                    Written to <code>{SETTINGS_PATH}</code>. Rows marked{" "}
                    <span class={styles.originBadge}>workspace</span> come from{" "}
                    <code>{workspaceName()}</code> instead.
                  </Show>
                </div>
              </div>
            </div>

            <div class={styles.pane}>
              {/* Two greetings: telling somebody with no CLI installed to check
                  what was found points them at a list of misses, which reads as
                  Sway being broken rather than as a step they have not taken. */}
              <Show when={props.welcome}>
                <Show
                  when={onboardingContent()?.kind === "noHarness"}
                  fallback={
                    <div class={styles.welcome}>
                      Welcome to Sway. It drives the agent CLIs you already have, so start by
                      checking which ones it found below, then open a folder in the sidebar to
                      begin a session.
                    </div>
                  }
                >
                  <div class={styles.welcome}>
                    Welcome to Sway. It drives an agent CLI you install yourself, and it could
                    not find one yet. Install {supportedList()}, then reopen this tab and Sway
                    will pick it up.
                  </div>
                </Show>
              </Show>

              {/* One nothing, not two: the old "N elsewhere" note existed only
                  because results used to stay inside the tab you were on. */}
              <Show when={nothingMatched()}>
                <div class={styles.note}>No setting matches “{query().trim()}”.</div>
              </Show>
              {/* Results mode only: a cross-category total over a pane showing
                  one category is a number nobody can check against. */}
              <Show when={searching() && matches()?.total}>
                {(total) => (
                  <div class={styles.resultCount}>
                    {total()} {total() === 1 ? "setting" : "settings"} matching
                  </div>
                )}
              </Show>

              {/* All six stay mounted so a switch keeps each pane's scroll and
                  in-flight edits, and `hidden` is what keeps the inactive ones
                  out of the focus trap. A search un-hides every one.

                  Plain containers rather than `Tabs.Content`: Kobalte writes
                  `hidden` on every panel but the selected one and wins over
                  the prop, so the search state - six panes open and nothing
                  selected - cannot be expressed through it. The rail is still
                  Kobalte's; `src/lib/tabs` documents that a list with no
                  `Content` claiming its values simply omits `aria-controls`,
                  so the pairing here is `aria-labelledby` on the panel. */}
              <For each={SETTING_TABS}>
                {(t) => (
                  <div
                    id={paneId(t.id)}
                    data-pane={t.id}
                    // A tabpanel only while it is one: six open panels under a
                    // tablist with nothing selected is not the tab pattern.
                    role={searching() ? "group" : "tabpanel"}
                    aria-label={searching() ? t.label : undefined}
                    aria-labelledby={searching() ? undefined : tabId(t.id)}
                    hidden={!searching() && active() !== t.id}
                  >
                    <Dynamic
                      component={PANES[t.id]}
                      shown={shown}
                      query={query()}
                      prefix={searching() ? t.label : undefined}
                      openTab={openTab}
                    />
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
