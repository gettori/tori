import { createEffect, createMemo, createSignal, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Chevron from "../../components/Chevron/Chevron";
import Button from "../../components/Button/Button";
import Menu, { type MenuItem } from "../../components/Menu/Menu";
import Popover from "../../components/Popover/Popover";
import TabMark from "./TabMark";
import { emitWith, SESSION_ACTION, type SessionAction } from "../../utils/events";
import { sessions, historical, checkHistorical, markAdopted, type SessionMeta } from "../../utils/sessionStore";
import { sessionStatus, sessionCertainty } from "../../utils/sessionActivity";
import { bucketByLastActive } from "../../utils/sessionBuckets";
import { ago } from "../../utils/relativeTime";
import styles from "./HistoryPanel.module.css";

/**
 * Every session anchored on the workspace on screen, as a dropdown off the tab
 * bar's History button.
 *
 * **Scoped to one folder, deliberately.** The sidebar's tree was the only way
 * to reach a session and it made you navigate to find one; this is the opposite
 * trade - no navigation at all, but nothing outside the branch you are working
 * in. Wider scope is the command palette's job.
 *
 * **Two orderings, because they answer different questions.** What is open now
 * is a small set you switch between, so it sits at the top whatever its age;
 * everything else is history, so it falls into `last_active` eras. A session is
 * in exactly one of the two.
 *
 * **A `<Popover>`**, right-aligned to the History button, which is what puts it
 * on the same portalling, clamping and dismissal as every menu in the app.
 */
export default function HistoryPanel(props: {
  /** The branch-unit folder whose sessions this lists. */
  folder: string;
  /** Where you are, stated rather than navigable: the panel cannot change it. */
  breadcrumb: string;
  /** Sessions this workspace currently has open in a tab. */
  openSessionIds: readonly string[];
  /** The History button's rect, in viewport coordinates. */
  anchor: { left: number; right: number; top: number };
  /** The button that opened it, so its own click is not also read as an
   *  outside-click that closes what it is trying to toggle. */
  anchorEl?: HTMLElement;
  onClose: () => void;
}) {
  let el: HTMLDivElement | undefined;
  let searchEl: HTMLInputElement | undefined;
  const [query, setQuery] = createSignal("");
  const [histOpen, setHistOpen] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // The verdict writes to disk (it auto-adopts), so it is asked for exactly the
  // folder whose Historical section is about to render and for no other. Opening
  // the panel on some other branch must never quietly adopt this one. An effect
  // rather than `onMount` because the panel is not re-created when the workspace
  // under it changes - only when it is closed and reopened.
  createEffect(on(() => props.folder, (folder) => void checkHistorical(folder)));

  // The search field takes focus, and gives it back to whatever had it. Without
  // the second half, dismissing the panel leaves the terminal unfocused and the
  // next keystroke goes nowhere.
  onMount(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    searchEl?.focus();
    onCleanup(() => returnTo?.focus?.());
  });

  // Arrow keys and Enter, so `role="option"` is a description of how the list
  // works rather than a claim about it. Bound at the document while the panel is
  // open (it is the only thing on screen that arrows should mean anything to),
  // which is also what lets them work from inside the search field. Escape is
  // Popover's, along with the outside click.
  function onKeyDown(e: KeyboardEvent) {
    const rows = visibleRows();
    if (!rows.length) return;
    if (e.key === "ArrowDown") step(e, 1, rows.length);
    else if (e.key === "ArrowUp") step(e, -1, rows.length);
    else if (e.key === "Enter") {
      e.preventDefault();
      act(rows[active()], "open");
    }
  }

  function step(e: KeyboardEvent, by: number, n: number) {
    e.preventDefault();
    setActive((active() + by + n) % n);
    // The highlight is useless if it walks off the bottom of a 47-row list.
    queueMicrotask(() =>
      el?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
    );
  }
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  const label = (s: SessionMeta) => s.name || s.title;
  const q = () => query().trim().toLowerCase();

  const listed = createMemo(() =>
    (sessions()[props.folder] ?? []).filter((s) => !q() || label(s).toLowerCase().includes(q())),
  );

  const isOpen = (s: SessionMeta) => props.openSessionIds.includes(s.id);
  const openNow = () => listed().filter(isOpen).sort((a, b) => b.last_active - a.last_active);
  // Exactly the complement, so nothing is listed twice and nothing is dropped.
  const rest = () => listed().filter((s) => !isOpen(s));
  const buckets = () => bucketByLastActive(rest(), Math.floor(Date.now() / 1000));

  // A folder recreated over old transcripts: its history is probably somebody
  // else's, so it is collapsed behind one line until adopted. What is open in a
  // tab right now is never a ghost, so `OPEN NOW` stays out of it.
  const isHistorical = () => historical()[props.folder] === true;

  // Every row actually on screen, in render order: what the arrow keys walk.
  // Derived from the same three sources the markup renders from, so a collapsed
  // Historical section is not silently navigable.
  const visibleRows = createMemo(() => {
    const rows = [...openNow()];
    if (isHistorical()) {
      if (histOpen()) rows.push(...rest());
    } else {
      for (const b of buckets()) rows.push(...b.sessions);
    }
    return rows;
  });

  const [active, setActive] = createSignal(0);
  const isActive = (s: SessionMeta) => visibleRows()[active()] === s;
  // Typing narrows the list under the highlight, so it must not be left past
  // the end of what is now shown.
  createEffect(() => {
    const n = visibleRows().length;
    if (active() >= n) setActive(n ? n - 1 : 0);
  });

  async function adopt() {
    try {
      await invoke("adopt_path", { path: props.folder });
      markAdopted(props.folder);
    } catch {
      /* the section simply stays collapsed; nothing was written */
    }
  }

  function act(s: SessionMeta, action: SessionAction["action"]) {
    emitWith<SessionAction>(SESSION_ACTION, { sessionId: s.id, action });
    props.onClose();
  }

  // Rename and delete only. Everything else the sidebar's row offers is either
  // about the tree (New session, Checkout) or is a copy affordance the palette
  // already covers, and a dropdown that lists ten actions per row is a menu you
  // read rather than a list you scan.
  const rowMenu = (s: SessionMeta): MenuItem[] => [
    { label: "Rename…", onClick: () => act(s, "rename") },
    { separator: true },
    { label: "Delete", danger: true, onClick: () => act(s, "delete") },
  ];

  function openRowMenu(e: MouseEvent, s: SessionMeta) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(s) });
  }

  const row = (s: SessionMeta) => (
    <div
      class={styles.row}
      classList={{ [styles.rowActive]: isActive(s) }}
      role="option"
      aria-selected={isActive(s)}
      title={label(s)}
      onClick={() => act(s, "open")}
      onContextMenu={(e) => openRowMenu(e, s)}
    >
      {/* One glyph position for agent and status together, the tab strip's rule
          rather than the sidebar's four-glyph one: these rows are scanned, and
          a row that changes shape when a session merely goes quiet pulls the
          eye to the wrong one. */}
      <TabMark
        agentId={s.agent ?? "claude"}
        status={sessionStatus(s.id)}
        certainty={sessionCertainty(s.id)}
      />
      <span class={styles.rowLabel}>{label(s)}</span>
      <span class={styles.rowWhen}>{ago(s.last_active)}</span>
    </div>
  );

  return (
    <>
      {/* The dialog is the panel; only the scrolling list is a listbox. A search
          field and a disclosure header are not options, and a listbox whose
          children are neither is one a screen reader reads back wrong. */}
      <Popover
        ref={(node) => (el = node)}
        anchor={props.anchor}
        align="end"
        anchorEl={props.anchorEl}
        // A row's context menu is portalled elsewhere, so a click or Escape
        // inside it is "outside" this panel and would close the thing the menu
        // belongs to.
        dismissable={!menu()}
        onClose={props.onClose}
        class={styles.panel}
        role="dialog"
        aria-label="Session history"
      >
        <div class={styles.head}>
          <div class={styles.crumb} title={props.folder}>
            {props.breadcrumb}
          </div>
          <input
            ref={searchEl}
            class={styles.search}
            type="text"
            placeholder="Search sessions"
            aria-label="Search sessions"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>

        <div class={styles.list} role="listbox" aria-label="Sessions">
          <Show when={openNow().length}>
            <div class={styles.section}>Open now</div>
            <For each={openNow()}>{row}</For>
          </Show>

          <Show
            when={!isHistorical()}
            fallback={
              <Show when={rest().length}>
                <div
                  class={`${styles.section} ${styles.historical}`}
                  onClick={() => setHistOpen(!histOpen())}
                  title="Sessions predating this recreated folder"
                >
                  <Chevron open={histOpen()} />
                  <span>Historical ({rest().length})</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    style={{ "margin-left": "auto" }}
                    title="Adopt these sessions into the normal listing"
                    onClick={(e) => {
                      e.stopPropagation();
                      void adopt();
                    }}
                  >
                    Adopt
                  </Button>
                </div>
                <Show when={histOpen()}>
                  <For each={rest()}>{row}</For>
                </Show>
              </Show>
            }
          >
            <For each={buckets()}>
              {(b) => (
                <>
                  <div class={styles.section}>{b.label}</div>
                  <For each={b.sessions}>{row}</For>
                </>
              )}
            </For>
          </Show>

          <Show when={!listed().length}>
            <div class={styles.empty}>{q() ? "No sessions match" : "No sessions here yet"}</div>
          </Show>
        </div>
      </Popover>

      {/* A sibling, not a child: `.panel` is `overflow: hidden` and carries its
          own z-index, so a menu nested inside it would be both clipped and
          trapped under the panel's stacking context. */}
      <Show when={menu()}>
        <Menu x={menu()!.x} y={menu()!.y} items={menu()!.items} onClose={() => setMenu(null)} />
      </Show>
    </>
  );
}
