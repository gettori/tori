// The model palette: agents on the left, their models on the right, one filter
// over both.
//
// The lock is structural. A draft is handed every chat-capable agent and a live
// session is handed exactly one, so "you can only switch models now" is a
// property of the list rather than a mode this component has to be told about.
//
// Built on `Dialog` for the shell (portal, backdrop, Escape, focus trap, focus
// restore) but not on `Combobox`: that primitive owns one collection's arrow
// keys and seeds its own highlight, and two panes with Tab between them is a
// second collection it has no way to yield to.
import { For, Show, createMemo, createSignal, createUniqueId, type JSX } from "solid-js";
import { Check, Wrench } from "lucide-solid";
import AgentGlyph from "../../components/Icon/AgentGlyph";
import Dialog from "../../components/Dialog/Dialog";
import Icon from "../../components/Icon/Icon";
import Tooltip from "../../components/Tooltip/Tooltip";
import { filterProviders, type PaletteProvider } from "./agentPaletteData";
import type { PickableModel } from "../../utils/chatModels";
import styles from "./AgentPalette.module.css";

type Pane = "providers" | "models";

export default function AgentPalette(props: {
  providers: readonly PaletteProvider[];
  /** The agent in force, so its row opens highlighted and marked. */
  agentId: string;
  /** The `--model` value in force, or null when nothing has been picked. */
  value: string | null;
  onSelect: (agentId: string, model: PickableModel) => void;
  /** A row moved under the cursor. The caller decides whether that is worth a
   *  probe; the palette never spawns anything itself. */
  onHighlight?: (agentId: string) => void;
  /** A "Fix" row was activated. Takes the reader to wherever the agent's health
   *  is actually fixable. */
  onFix?: (agentId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [pane, setPane] = createSignal<Pane>("models");
  const [hiProvider, setHiProvider] = createSignal<string | null>(props.agentId);
  const [hiModel, setHiModel] = createSignal<string | null>(props.value);
  let input: HTMLInputElement | undefined;

  const filtered = createMemo(() => filterProviders(props.providers, query()));
  // Falling back to the first row rather than to nothing: the filter can drop
  // whatever was highlighted, and a palette with rows and no highlight has no
  // answer for Enter.
  const provider = createMemo(
    () => filtered().find((p) => p.agentId === hiProvider()) ?? filtered()[0] ?? null,
  );
  const models = createMemo<readonly PickableModel[]>(() => provider()?.models ?? []);
  const model = createMemo(
    () => models().find((m) => m.value === hiModel()) ?? models()[0] ?? null,
  );

  function highlightProvider(agentId: string) {
    setHiProvider(agentId);
    // Dropped rather than kept: the new agent's list is a different list, and a
    // value carried across it would highlight nothing.
    setHiModel(null);
    props.onHighlight?.(agentId);
  }

  function move(delta: number) {
    if (pane() === "providers") {
      const rows = filtered();
      if (!rows.length) return;
      const at = rows.findIndex((p) => p === provider());
      highlightProvider(rows[(at + delta + rows.length) % rows.length].agentId);
      return;
    }
    const rows = models();
    if (!rows.length) return;
    const at = rows.findIndex((m) => m === model());
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
    if (picked && target.selectable) props.onSelect(target.agentId, picked);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") return e.preventDefault(), move(1);
    if (e.key === "ArrowUp") return e.preventDefault(), move(-1);
    if (e.key === "Tab") return e.preventDefault(), setPane(pane() === "models" ? "providers" : "models");
    if (e.key === "Enter") return e.preventDefault(), commit();
  }

  // Per instance, not a constant: every chat tab has a palette of its own, and a
  // global hotkey can leave one open behind another. Two dialogs sharing a row
  // id would make `aria-activedescendant` ambiguous.
  const id = createUniqueId();
  const paneId = (kind: Pane) => `${id}-${kind}`;
  const rowId = (kind: Pane, key: string) => `${id}-${kind}-${key}`;
  const activeId = () => {
    const key = pane() === "providers" ? provider()?.agentId : model()?.value;
    return key === undefined || key === null ? undefined : rowId(pane(), key);
  };

  return (
    <Dialog
      open
      title="Pick a model"
      titleHidden
      size="wide"
      class={styles.panel}
      initialFocus={() => input}
      onClose={props.onClose}
      onKeyDown={onKeyDown}
    >
      <input
        ref={(el) => (input = el)}
        class={styles.filter}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={`${paneId("providers")} ${paneId("models")}`}
        aria-activedescendant={activeId()}
        aria-label="Filter agents and models"
        placeholder="Search agents and models"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />

      <div class={styles.panes}>
        <div
          id={paneId("providers")}
          class={styles.pane}
          classList={{ [styles.paneActive]: pane() === "providers" }}
          role="listbox"
          aria-label="Agents"
        >
          <For each={filtered()}>
            {(p) => (
              <div
                id={rowId("providers", p.agentId)}
                class={styles.row}
                classList={{ [styles.rowActive]: pane() === "providers" && p === provider() }}
                role="option"
                aria-selected={p.agentId === props.agentId}
                onClick={() => {
                  highlightProvider(p.agentId);
                  setPane("models");
                }}
              >
                <AgentGlyph id={p.agentId} label={p.label} size={16} />
                <span class={styles.rowName}>{p.label}</span>
                <ProviderState provider={p} onFix={() => props.onFix?.(p.agentId)} />
              </div>
            )}
          </For>
          <Show when={filtered().length === 0}>
            <div class={styles.empty} role="status">
              No agents match
            </div>
          </Show>
        </div>

        <div
          id={paneId("models")}
          class={styles.pane}
          classList={{ [styles.paneActive]: pane() === "models" }}
          role="listbox"
          aria-label="Models"
        >
          <For each={models()}>
            {(m) => (
              <div
                id={rowId("models", m.value)}
                class={styles.row}
                classList={{
                  [styles.rowActive]: pane() === "models" && m === model(),
                  [styles.rowInert]: !provider()?.selectable,
                }}
                role="option"
                aria-selected={m.value === props.value && provider()?.agentId === props.agentId}
                aria-disabled={!provider()?.selectable}
                onClick={() => {
                  const target = provider();
                  if (target?.selectable) props.onSelect(target.agentId, m);
                }}
              >
                <span class={styles.rowBody}>
                  <span class={styles.rowName}>{m.label}</span>
                  <Show when={m.description}>
                    {(d) => <span class={styles.rowDesc}>{d()}</span>}
                  </Show>
                </span>
                <Show when={m.value === props.value && provider()?.agentId === props.agentId}>
                  <Icon icon={Check} size={14} />
                </Show>
              </div>
            )}
          </For>
          <Show when={models().length === 0}>
            <div class={styles.empty} role="status">
              {provider() ? "No models known yet" : "No models match"}
            </div>
          </Show>
        </div>
      </div>

      <div class={styles.keys} aria-hidden="true">
        <span>
          <kbd>up</kbd>
          <kbd>down</kbd> move
        </span>
        <span>
          <kbd>tab</kbd> switch pane
        </span>
        <span>
          <kbd>enter</kbd> select
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </Dialog>
  );
}

/** The right-hand end of an agent row: what Sway knows, or the one thing the
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
          <span class={styles.rowMeta}>{state.kind === "probing" ? "Probing" : state.count}</span>
        )
      }
    </Show>
  );
}
