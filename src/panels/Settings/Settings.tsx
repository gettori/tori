import { createEffect, createMemo, createSignal, on, onMount, For, Show, type Component } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { Bot, Braces, FileCode, MessageSquare, Palette, Plug, type LucideIcon } from "lucide-solid";
import { matchingEntries } from "./settingsSearch";
import { SETTING_TABS, type SettingTab } from "../../utils/settingsCatalog";
import { nextSegmentIndex } from "../../components/controls";
import Tab from "../../components/Tab/Tab";
import Icon from "../../components/Icon/Icon";
import Button from "../../components/Button/Button";
import AgentsPane from "./panes/AgentsPane";
import AppearancePane from "./panes/AppearancePane";
import ChatPane from "./panes/ChatPane";
import EditorPane from "./panes/EditorPane";
import IntegrationsPane from "./panes/IntegrationsPane";
import LanguagesPane from "./panes/LanguagesPane";
import type { PaneProps } from "./paneKit";
import styles from "./Settings.module.css";

/** Re-exported because the Editor rows moved to `paneKit` when the panel became
 *  six panes, and `editorSection.test.tsx` reads the list from here. */
export { EDITOR_TOGGLES } from "./paneKit";

/**
 * The strip's glyphs, resolved from the catalogue's icon *names*.
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
  agents: AgentsPane,
  chat: ChatPane,
  editor: EditorPane,
  languages: LanguagesPane,
  appearance: AppearancePane,
  integrations: IntegrationsPane,
};

const tabId = (id: SettingTab) => `settings-tab-${id}`;
const paneId = (id: SettingTab) => `settings-pane-${id}`;

/** What the focus trap counts as a stop. `[hidden]` is not excluded by the
 *  selector, so the inactive panes are filtered out by ancestor below: they are
 *  in the DOM (which is what keeps a pane's scroll position across a tab
 *  switch) but must not be reachable by Tab. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The in-app settings screen. Reads the reactive settings store and writes back
// through saveSettings (which persists to settings.json and applies live). A
// portaled modal: six tabs over the catalogue's sections, one header search
// across all of them, Escape / backdrop click to close.
export default function Settings(props: { onClose: () => void; welcome?: boolean; query?: string }) {
  let firstControl: HTMLInputElement | undefined;
  let panelEl!: HTMLDivElement;
  let stripEl!: HTMLDivElement;

  /** The filter box. Seeded from the prop rather than bound to it, because a
   *  `Preferences: ...` command opens the panel *at* a setting and the user has
   *  to be able to type past it the moment it lands. */
  const [query, setQuery] = createSignal(props.query ?? "");
  const [active, setActive] = createSignal<SettingTab>("agents");

  const matches = createMemo(() => matchingEntries(query()));
  /** Everything when nothing is typed, only what matched when something is. */
  const shown = (id: string) => {
    const m = matches();
    return !m || m.ids.has(id);
  };
  const nothingMatched = () => matches()?.total === 0;

  /**
   * Select the first tab holding a match for `q`.
   *
   * Only ever called for a **command-initiated** query, never for typing. A
   * palette row is the user pointing at one setting, so landing on its tab is
   * carrying out the instruction; a keystroke in the search box is not, and
   * moving the panel under someone mid-word is the behaviour this panel's
   * decisions rule out.
   */
  function landOn(q: string) {
    const m = matchingEntries(q);
    if (!m || m.total === 0) return;
    const tab = SETTING_TABS.find((t) => m.counts[t.id] > 0);
    if (tab) setActive(tab.id);
  }

  onMount(() => {
    if (props.query) landOn(props.query);
    requestAnimationFrame(() => firstControl?.focus());
  });

  // A later command re-filters a panel that is already open. ⌘K reaches the
  // palette over this modal, and opening an open panel remounts nothing, so
  // without this the row would close the palette and appear to do nothing.
  // Deferred, so it is only a *change* of prop that overwrites what is typed.
  createEffect(
    on(
      () => props.query,
      (q) => {
        setQuery(q ?? "");
        if (q) landOn(q);
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
      if (query() !== "") setQuery("");
      else props.onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // `[hidden]` excludes the inactive panes, and `tabindex="-1"` the five tabs
    // the roving index has parked: both are still matched by the selector's
    // `button`/`input` clauses, and neither is a stop a real browser would make.
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

  /** Arrow/Home/End across the strip, shared with the segmented control so the
   *  two cannot disagree about what a wrap is. Automatic activation: the arrow
   *  both moves focus and selects, which is what a six-tab strip with no
   *  expensive panes should do. */
  function onStripKeyDown(e: KeyboardEvent) {
    const current = SETTING_TABS.findIndex((t) => t.id === active());
    const next = nextSegmentIndex(current, e.key, SETTING_TABS.length);
    if (next === current) return;
    e.preventDefault();
    setActive(SETTING_TABS[next].id);
    stripEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
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
            <div class={styles.titleRow}>
              <div class={styles.title}>Settings</div>
              <Button variant="ghost" size="xs" aria-label="Close" title="Close" onClick={() => props.onClose()}>
                ×
              </Button>
            </div>
            {/* One box above the strip, not one per tab: it searches every tab,
                and a box inside a pane would read as filtering that pane alone. */}
            <input
              ref={firstControl}
              class={`${styles.input} ${styles.search}`}
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <div
              ref={stripEl}
              class={styles.strip}
              role="tablist"
              aria-label="Settings sections"
              onKeyDown={onStripKeyDown}
            >
              <For each={SETTING_TABS}>
                {(t) => (
                  <Tab
                    active={active() === t.id}
                    id={tabId(t.id)}
                    aria-controls={paneId(t.id)}
                    // Roving tabindex: one stop for the whole strip, so Tab
                    // steps past it into the pane rather than through six.
                    tabindex={active() === t.id ? 0 : -1}
                    icon={<Icon icon={TAB_ICONS[t.icon]} />}
                    onClick={() => setActive(t.id)}
                  >
                    {t.label}
                  </Tab>
                )}
              </For>
            </div>
          </div>

          <div class={styles.body}>
            {/* Agents leads the strip: it is the tab first-run opens onto, and
                the one answering "will this work with my setup?". */}
            <Show when={props.welcome}>
              <div class={styles.welcome}>
                Welcome to Sway. It drives the agent CLIs you already have, so start by
                checking which ones it found below, then open a folder in the sidebar to
                begin a session.
              </div>
            </Show>
            <Show when={nothingMatched()}>
              <div class={styles.hint}>No setting matches “{query().trim()}”.</div>
            </Show>

            {/* Every pane stays mounted and the inactive ones are `hidden`: a
                tab switch keeps each pane's scroll position and its in-flight
                edits, and `hidden` is what keeps them out of the focus trap. */}
            <For each={SETTING_TABS}>
              {(t) => (
                <div
                  id={paneId(t.id)}
                  role="tabpanel"
                  aria-labelledby={tabId(t.id)}
                  hidden={active() !== t.id}
                >
                  <Dynamic component={PANES[t.id]} shown={shown} />
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  );
}
