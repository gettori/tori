// The model palette: agents on the left, their models on the right, one filter
// over both.
//
// The lock is structural. A draft is handed every chat-capable agent and a live
// session is handed exactly one, so "you can only switch models now" is a
// property of the list rather than a mode this component has to be told about.
//
// Built on `Popover` for the shell (anchored to the pill that opened it, portal,
// Escape, outside press, focus restore) but not on `Combobox`: that primitive
// owns one collection's arrow keys and seeds its own highlight, and two panes
// with Tab between them is a second collection it has no way to yield to.
//
// Anchored rather than centred, since a model is a property of the composer bar
// and a modal over the transcript claimed more of the screen, and more of the
// user's attention, than picking one is worth.
import { For, Show, createMemo, createSignal, createUniqueId, type JSX } from "solid-js";
import {
  ArrowDown,
  ArrowRightToLine,
  ArrowUp,
  Check,
  Command,
  CornerDownLeft,
  RefreshCw,
  Search,
  Wrench,
} from "lucide-solid";
import AgentGlyph from "../../components/Icon/AgentGlyph";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import Popover from "../../components/Popover/Popover";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import { filterProviders, splitModelDisplay, type PaletteProvider } from "./agentPaletteData";
import type { PickableModel } from "../../utils/chatModels";
import styles from "./AgentPalette.module.css";

type Pane = "providers" | "models";

export default function AgentPalette(props: {
  providers: readonly PaletteProvider[];
  /** The pill this hangs off. Its own press is the pill's to interpret rather
   *  than an outside dismissal, or the two would fight over one click. */
  anchorEl?: HTMLElement;
  /** The agent in force, so its row opens highlighted and marked. */
  agentId: string;
  /** And which of its accounts, since an agent with two of them is two rows and
   *  only one of them is the one in force. `null` is the default account. */
  profile: string | null;
  /** The `--model` value in force, or null when nothing has been picked. */
  value: string | null;
  onSelect: (agentId: string, profile: string | null, model: PickableModel) => void;
  /** A row moved under the cursor. The caller decides whether that is worth a
   *  probe; the palette never spawns anything itself. */
  onHighlight?: (agentId: string, profile: string | null) => void;
  /** A "Fix" row was activated. Takes the reader to wherever the agent's health
   *  is actually fixable. Per agent, not per account: one page carries both the
   *  install and every account's sign-in. */
  onFix?: (agentId: string) => void;
  /** Ask this account of this agent for its models again. Absent hides the
   *  control, which is how a palette fed by a live session says a recheck would
   *  buy it nothing. */
  onRecheck?: (agentId: string, profile: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [pane, setPane] = createSignal<Pane>("models");
  /** The row this chat is actually on. An agent with two accounts is two rows
   *  and only one of them wears the marks. */
  const isCurrent = (p: PaletteProvider) => p.agentId === props.agentId && p.profile === props.profile;
  // Null until the reader names a row. The row in force is the fallback below
  // rather than a seed here, because a seed is a snapshot: a palette whose
  // provider list arrives after mount would have snapshotted nothing.
  const [hiProvider, setHiProvider] = createSignal<string | null>(null);
  const [hiModel, setHiModel] = createSignal<string | null>(props.value);
  // Whether the reader has driven this list yet. Not derivable from `hiModel`,
  // which opens already naming the model in force.
  const [roved, setRoved] = createSignal(false);
  let input: HTMLInputElement | undefined;

  const filtered = createMemo(() => filterProviders(props.providers, query()));
  // The row in force, then the first row, rather than nothing: the palette
  // opens on the pair this chat is already on, and the filter can drop whatever
  // was highlighted, leaving a list with rows and no answer for Enter.
  const provider = createMemo(
    () => filtered().find((p) => p.key === hiProvider()) ?? filtered().find(isCurrent) ?? filtered()[0] ?? null,
  );
  const models = createMemo<readonly PickableModel[]>(() => provider()?.models ?? []);
  const model = createMemo(() => models().find((m) => m.value === hiModel()) ?? models()[0] ?? null);
  /** The cursor as a row somebody named: the reader's arrows, or the model in
   *  force when the palette opened on one. Null while nothing in this list has
   *  been named, which is where `model()`'s fallback takes over. */
  const namedModel = createMemo(() => models().find((m) => m.value === hiModel()) ?? null);
  /** What actually gets a fill. Two conditions, and both are about not lighting
   *  a row the reader did not put the cursor on: the fallback would light the
   *  first row of every untouched list, and the model in force already wears
   *  its own mark, so painting it on open would say "hovered" about a row that
   *  only means "running". */
  const shownModel = () => (roved() ? namedModel() : null);

  function highlightProvider(p: PaletteProvider) {
    setHiProvider(p.key);
    // Dropped rather than kept: the new row's list is a different list, and a
    // value carried across it would highlight nothing.
    setHiModel(null);
    setRoved(false);
    props.onHighlight?.(p.agentId, p.profile);
  }

  function move(delta: number) {
    if (pane() === "providers") {
      const rows = filtered();
      if (!rows.length) return;
      const at = rows.findIndex((p) => p === provider());
      highlightProvider(rows[(at + delta + rows.length) % rows.length]);
      return;
    }
    const rows = models();
    if (!rows.length) return;
    setRoved(true);
    const at = rows.findIndex((m) => m === namedModel());
    // Nothing named yet: the first press names an end of the list rather than
    // stepping off a cursor nobody can see.
    if (at < 0) {
      return setHiModel((delta > 0 ? rows[0] : rows[rows.length - 1]).value);
    }
    setHiModel(rows[(at + delta + rows.length) % rows.length].value);
  }

  function commit() {
    const target = provider();
    if (!target) return;
    if (pane() === "providers") {
      if (target.selectable) return setPane("models");
      return props.onFix?.(target.agentId);
    }
    const picked = model();
    if (picked && target.selectable) props.onSelect(target.agentId, target.profile, picked);
  }

  function onKeyDown(e: KeyboardEvent) {
    // Claimed here rather than left to the app: the palette is the one place
    // that knows *which* agent's settings the reader means, and the footer says
    // this key does something, so it has to.
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      props.onFix?.(provider()?.agentId ?? props.agentId);
      return;
    }
    if (e.key === "ArrowDown") return (e.preventDefault(), move(1));
    if (e.key === "ArrowUp") return (e.preventDefault(), move(-1));
    if (e.key === "Tab") return (e.preventDefault(), setPane(pane() === "models" ? "providers" : "models"));
    if (e.key === "Enter") return (e.preventDefault(), commit());
  }

  /** The heading's fact slot: the count, or the agent's own state when that is
   *  the reason the list is short or empty. Bare number, since the heading's
   *  title already says what it counts. */
  const headFact = () => {
    const p = provider();
    if (!p) return "nothing to show";
    if (p.health.kind === "fix") return p.health.reason.toLowerCase();
    if (p.health.kind === "probing") return "probing";
    // The plan leads the count where there is one: it is what says whose answer
    // this list is, which only means anything once there are two accounts to
    // tell apart. Same rule the agent card's models pane follows.
    return [p.plan, `${models().length}`].filter(Boolean).join(", ");
  };

  /** What there is to filter, over the whole hand rather than the filtered
   *  view: the placeholder names the inventory, and one that shrank as you
   *  typed would be describing its own effect. A locked session drops the
   *  provider clause, since "across 1 provider" is the lock restated as if it
   *  were a count. */
  const filterHint = () => {
    if (props.providers.length === 0) return "Nothing to filter";
    const total = props.providers.reduce((n, p) => n + p.models.length, 0);
    const m = `${total} ${total === 1 ? "model" : "models"}`;
    return props.providers.length === 1 ? `Filter ${m}` : `Filter ${m} across ${props.providers.length} providers`;
  };

  // Per instance, not a constant: every chat tab has a palette of its own, and a
  // global hotkey can leave one open behind another. Two panels sharing a row
  // id would make `aria-activedescendant` ambiguous.
  const id = createUniqueId();
  const paneId = (kind: Pane) => `${id}-${kind}`;
  // Spaces are the one character a key cannot carry in here:
  // `aria-activedescendant` is a space-separated list of ids, so a row id with
  // one in it would name two elements. Neither an agent id nor an account id
  // contains a space, so replacing the join is lossless.
  const rowId = (kind: Pane, key: string) => `${id}-${kind}-${key.replace(/ /g, "-")}`;
  const activeId = () => {
    // The named row, not `model()`'s fallback: a row nothing has named carries
    // no mark of any kind, and announcing it would tell a screen reader
    // something the screen does not say. The model in force does qualify, since
    // it is marked from the moment the palette opens.
    const key = pane() === "providers" ? provider()?.key : namedModel()?.value;
    return key === undefined || key === null ? undefined : rowId(pane(), key);
  };

  const inForce = (m: PickableModel) => {
    const p = provider();
    return m.value === props.value && !!p && isCurrent(p);
  };

  /** The row's second line: the provider's own sentence when it sent one, else
   *  the model's id, which is what an ACP catalogue has instead of prose. Empty
   *  when the label already is the id, rather than printing it twice. */
  const rowSub = (m: PickableModel) => m.description || (m.value !== m.label ? m.value : "");

  /** The split display for agents whose labels carry a provider path, per the
   *  adapter's own flag. Null everywhere else, including for a flagged agent's
   *  plain-named model, which falls back to the ordinary two lines. */
  const display = (m: PickableModel) => (provider()?.splitModels ? splitModelDisplay(m.label, m.value) : null);

  return (
    <Popover
      anchorEl={props.anchorEl}
      // Above the pill and left-aligned to it, the same placement the menu
      // pills use: the composer sits at the bottom of the pane, so a panel
      // below its trigger would have nowhere to go but back over it.
      placement="top-start"
      initialFocus={() => input}
      onClose={props.onClose}
      class={styles.panel}
      aria-label="Pick a model"
    >
      {/* One bar over both panes, since the one query narrows agents and models
          together. The placeholder is the inventory, so an empty field already
          says what there is to search. */}
      <div class={styles.filterBar}>
        <Icon icon={Search} size={14} />
        <input
          ref={(el) => (input = el)}
          class={styles.filterInput}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${paneId("providers")} ${paneId("models")}`}
          aria-activedescendant={activeId()}
          aria-label="Filter agents and models"
          placeholder={filterHint()}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          // On the field rather than on the panel: focus never leaves it while
          // the palette is open, so this is every keyboard path there is.
          // Escape and the outside press are Popover's.
          onKeyDown={onKeyDown}
        />
        <kbd class={styles.escKey} aria-hidden="true">
          esc
        </kbd>
      </div>

      <div class={styles.panes}>
        <div class={styles.agents} classList={{ [styles.paneActive]: pane() === "providers" }}>
          <OverlayScroll class={styles.scroll}>
            <div id={paneId("providers")} role="listbox" aria-label="Agents">
              <For each={filtered()}>
                {(p) => (
                  <div
                    id={rowId("providers", p.key)}
                    class={styles.row}
                    // Not gated on the pane: this row names what the list on
                    // the right is *of*, which stays true while the arrows are
                    // over there. Which pane the keys are in is the bar's job
                    // (`.agents.paneActive`), not the fill's.
                    classList={{ [styles.rowActive]: p === provider() }}
                    role="option"
                    aria-selected={isCurrent(p)}
                    onClick={() => {
                      highlightProvider(p);
                      setPane("models");
                    }}
                  >
                    <span class={styles.glyph}>
                      <AgentGlyph id={p.agentId} label={p.label} size={17} />
                      <HealthDot health={p.health} />
                    </span>
                    <span class={styles.rowName}>{p.label}</span>
                    <ProviderState provider={p} onFix={() => props.onFix?.(p.agentId)} />
                  </div>
                )}
              </For>
              {/* Two different nothings. An empty hand is a setting the reader
                  can go change, and saying "no agents match" about a list that
                  was never going to have any would send them to retype a
                  filter that is not the problem. */}
              <Show when={filtered().length === 0}>
                <div class={styles.empty} role="status">
                  <Show when={props.providers.length === 0} fallback="No agents match">
                    No agents enabled. Turn one on in Settings.
                  </Show>
                </div>
              </Show>
            </div>
          </OverlayScroll>
        </div>

        <div class={styles.models} classList={{ [styles.paneActive]: pane() === "models" }}>
          {/* The agent as itself, then its list introduced the way Settings
              introduces the same list (`.groupHead`): the word, a rule, the
              count. No glyph: the left pane already wears it, and twice at
              this distance read as decoration. */}
          <div class={styles.head}>
            <Show when={provider()} keyed fallback={<div class={styles.headAgent}>No agent</div>}>
              {(p) => (
                <>
                  <div class={styles.headAgent}>
                    <span class={styles.headName}>{p.label}</span>
                    <Show when={p.version}>{(v) => <span class={styles.headVersion}>v{v()}</span>}</Show>
                    <span class={styles.headRule} />
                    <span class={styles.headFact}>{headFact()}</span>
                    <Show when={props.onRecheck}>
                      {(recheck) => (
                        <Tooltip
                          as="button"
                          type="button"
                          class={styles.recheck}
                          classList={{
                            [styles.recheckBusy]: p.health.kind === "probing",
                          }}
                          aria-label={`Check ${p.label} for new models`}
                          label="Check again"
                          disabled={p.health.kind === "probing"}
                          onMouseDown={(e: MouseEvent) => e.preventDefault()}
                          onClick={() => recheck()(p.agentId, p.profile)}
                        >
                          <Icon icon={RefreshCw} size={15} />
                        </Tooltip>
                      )}
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </div>

          <OverlayScroll class={styles.scroll}>
            <div id={paneId("models")} role="listbox" aria-label="Models">
              <For each={models()}>
                {(m) => (
                  <div
                    id={rowId("models", m.value)}
                    class={styles.row}
                    classList={{
                      [styles.modelRow]: true,
                      [styles.rowActive]: pane() === "models" && m === shownModel(),
                      [styles.rowInert]: !provider()?.selectable,
                      [styles.rowCurrent]: inForce(m),
                    }}
                    role="option"
                    aria-selected={inForce(m)}
                    aria-disabled={!provider()?.selectable}
                    onClick={() => {
                      const target = provider();
                      if (target?.selectable) props.onSelect(target.agentId, target.profile, m);
                    }}
                  >
                    <span class={styles.rowText}>
                      <span class={styles.rowTitle}>
                        <span class={styles.rowName} classList={{ [styles.rowId]: m.userConfigured }}>
                          {display(m)?.name ?? m.label}
                        </span>
                        <Show when={inForce(m)}>
                          <span class={styles.check}>
                            <Icon icon={Check} size={15} />
                          </span>
                        </Show>
                      </span>
                      <Show
                        when={display(m)}
                        fallback={
                          <Show when={rowSub(m)}>
                            {(d) => (
                              <span
                                class={styles.rowDesc}
                                classList={{
                                  [styles.rowDescId]: !m.description,
                                }}
                              >
                                {d()}
                              </span>
                            )}
                          </Show>
                        }
                      >
                        {(d) => (
                          <span class={`${styles.rowDesc} ${styles.rowRoute}`}>
                            <For each={d().segments}>
                              {(seg, i) => (
                                <>
                                  <Show when={i() > 0}>
                                    <span class={styles.sep} aria-hidden="true" />
                                  </Show>
                                  <span
                                    classList={{
                                      [styles.rowDescId]: i() === d().segments.length - 1,
                                    }}
                                  >
                                    {seg}
                                  </span>
                                </>
                              )}
                            </For>
                          </span>
                        )}
                      </Show>
                    </span>
                  </div>
                )}
              </For>
              <Show when={models().length === 0}>
                <div class={styles.empty} role="status">
                  {provider() ? "No models known yet" : "No models match"}
                </div>
              </Show>
            </div>
          </OverlayScroll>
        </div>
      </div>

      <div class={styles.footer}>
        {/* The keys as their own glyphs. A keycap reads as a key at a glance
            where its name has to be read as a word first, and the row is short
            enough that the label beside each one carries the meaning. */}
        <div class={styles.keys} aria-hidden="true">
          <span>
            <kbd>
              <Icon icon={ArrowUp} size={12} />
            </kbd>
            <kbd>
              <Icon icon={ArrowDown} size={12} />
            </kbd>{" "}
            move
          </span>
          <span class={styles.sep} />
          <span>
            <kbd>
              <Icon icon={ArrowRightToLine} size={12} />
            </kbd>{" "}
            switch provider
          </span>
          <span class={styles.sep} />
          <span>
            <kbd>
              <Icon icon={CornerDownLeft} size={12} />
            </kbd>{" "}
            select
          </span>
        </div>
        <button
          type="button"
          class={styles.settings}
          // The highlighted agent, or this chat's own when the list is empty:
          // with nothing enabled this button is the way out, so it has to lead
          // somewhere rather than go dead exactly when it is needed.
          onClick={() => props.onFix?.(provider()?.agentId ?? props.agentId)}
        >
          agent settings
          <kbd>
            <Icon icon={Command} size={12} />
          </kbd>
          <kbd>,</kbd>
        </button>
      </div>
    </Popover>
  );
}

/**
 * The agent's state as a light, at the head of its row.
 *
 * Restates the Settings pane's dot recipe, tone for tone, so one agent cannot
 * look healthy in one surface and broken in the other: green for an agent that
 * answered, amber while it is being asked, and a hollow ring for one that is
 * not there. The word beside it is what says which.
 */
function HealthDot(props: { health: PaletteProvider["health"] }): JSX.Element {
  const tone = () => {
    if (props.health.kind === "count") return styles.dotOk;
    return props.health.kind === "probing" ? styles.dotWait : styles.dotOff;
  };
  return <span class={`${styles.dot} ${tone()}`} aria-hidden="true" />;
}

/** The right-hand end of an agent row: what Tori knows, or the one thing the
 *  user can do about not knowing it. */
function ProviderState(props: { provider: PaletteProvider; onFix: () => void }): JSX.Element {
  // `keyed` hands the value itself rather than an accessor, which is what lets
  // the union narrow inside the branch.
  return (
    <Show when={props.provider.health} keyed>
      {(state) =>
        state.kind === "fix" ? (
          // `Tooltip`, not a native `title`: a `title` never reaches the
          // keyboard (issue 102), and this row's whole job is being reachable.
          <Tooltip
            as="button"
            type="button"
            class={styles.fix}
            aria-label={`Fix ${state.reason}`}
            label={state.reason}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              props.onFix();
            }}
          >
            <Icon icon={Wrench} size={12} />
            Fix
          </Tooltip>
        ) : (
          <span class={styles.rowMeta}>{state.kind === "probing" ? "probing" : state.count}</span>
        )
      }
    </Show>
  );
}
