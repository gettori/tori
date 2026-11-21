import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Check, ChevronsUpDown } from "../Icon/icons";
import { createTypeahead } from "../../lib/keyboard";
import { anchorLayer, openLayer } from "../../lib/layer";
import { useDialogSurface } from "../Dialog/surface";
import Glide from "../Glide/Glide";
import Icon from "../Icon/Icon";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import type { ControlSize } from "../controls";
import { createListRows, optionKey, valueOfKey } from "../listRows";
import styles from "./Select.module.css";

/** One choice: the string the app stores, the label the user reads. */
export type SelectOption = { value: string; label: string; disabled?: boolean };

/** A labelled group of choices (AppearancePane's Bundled vs user themes). A
 *  list is either flat or grouped, never mixed. */
export type SelectGroup = { label: string; options: SelectOption[] };

/** One tab of a tabbed list (AppearancePane's Dark and Light): a strip at the
 *  top of the open listbox, and only the active tab's choices beneath it. */
export type SelectTab = { label: string; options: SelectOption[] | SelectGroup[] };

/** The reference's value, same as Menu's TRIGGER_GUTTER (adr_solid_ui_reference). */
const TRIGGER_GUTTER = 4;

function pageTarget(rows: readonly HTMLElement[], from: number, step: 1 | -1, viewport: number) {
  const top = rows[from].getBoundingClientRect().top;
  let to = from;
  for (let at = from + step; at >= 0 && at < rows.length; at += step) {
    if (Math.abs(rows[at].getBoundingClientRect().top - top) > viewport) break;
    to = at;
  }
  return to;
}

/**
 * The one select: a listbox behind a button, in Tori's chrome. This is for
 * committing one value out of a fixed list; a surface whose rows carry actions
 * is a menu (`Menu/`), and a filterable picker is the Omnibox's business.
 *
 * **An unknown value shows the placeholder, or nothing.** The one caller with an
 * unstable value space (AppearancePane) already resolves unknown ids to its own
 * default *before* this prop, because only the call site knows what an absent
 * value means.
 *
 * **Labeling is the call site's.** The trigger is a button, so it has no
 * `<label for>` to inherit; every consumer passes `aria-label` or points
 * `aria-labelledby` at its visible label (the settings rows via `rowLabelId`).
 *
 * **Tabs filter, they never commit.** With `tabs`, the listbox shows one tab's
 * choices and the trigger keeps showing the committed value even while the
 * other tab is open, so browsing is free. Every open starts on the tab that
 * holds the value.
 *
 * Chrome is split: this owns the trigger and listbox surface (in
 * `Select.module.css`), the caller's `class` adds layout (width) on the
 * trigger.
 */
export default function Select(props: {
  options: SelectOption[] | SelectGroup[];
  /** Replaces `options` with a tabbed list; `options` is ignored when set. */
  tabs?: SelectTab[];
  /** Names the tab strip for assistive tech. */
  tabsLabel?: string;
  value: string;
  onChange: (value: string) => void;
  size?: ControlSize;
  /** Shown while `value` names no option. */
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** The trigger button, for callers that move focus onto the control
   *  (DebugTargetDialog focuses the script picker when its mode appears). */
  ref?: (el: HTMLButtonElement) => void;
}) {
  const entries = createMemo(
    () =>
      (props.tabs ? props.tabs.flatMap((t): (SelectOption | SelectGroup)[] => t.options) : props.options) as (
        | SelectOption
        | SelectGroup
      )[],
  );
  const list = createListRows<SelectOption>(entries);
  const selected = createMemo(() => list.options().find((o) => o.value === props.value) ?? null);

  const tabOf = createMemo(() => {
    const owner = new Map<SelectOption | SelectGroup, number>();
    props.tabs?.forEach((t, i) => {
      for (const entry of t.options) {
        owner.set(entry, i);
        if ("options" in entry) for (const option of entry.options) owner.set(option, i);
      }
    });
    return owner;
  });
  const valueTab = () => (selected() ? (tabOf().get(selected()!) ?? 0) : 0);
  const [tab, setTab] = createSignal(valueTab());
  const offTab = (entry: SelectOption | SelectGroup) => props.tabs != null && tabOf().get(entry) !== tab();
  const isDisabled = (option: SelectOption) => !!option.disabled || offTab(option);
  const enabled = () =>
    list
      .options()
      .filter((option) => !isDisabled(option))
      .map((option) => option.value);

  const labelOf = (value: string) => {
    const row = list.row(optionKey(value));
    return row?.kind === "option" ? row.option.label : "";
  };

  const [open, setOpen] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  const [highlighted, setHighlighted] = createSignal<string | null>(null);
  const rowElements = new Map<string, HTMLElement>();
  const baseId = createUniqueId();
  const triggerId = `select-${baseId}-trigger`;
  const valueId = `select-${baseId}-value`;
  const listId = `select-${baseId}-listbox`;
  const dialogSurface = useDialogSurface();
  let pressType: string | undefined;

  const listLabelledBy = () => props["aria-labelledby"] ?? (props["aria-label"] ? triggerId : undefined);
  const triggerLabelledBy = () => [listLabelledBy(), valueId].filter(Boolean).join(" ");

  const openList = (edge?: "first" | "last") => {
    if (entries().length === 0) return;
    setTab(valueTab());
    const current = selected();
    const rows = enabled();
    const start =
      current && !isDisabled(current)
        ? current.value
        : edge === "first"
          ? rows[0]
          : edge === "last"
            ? rows[rows.length - 1]
            : undefined;
    setHighlighted(start ?? null);
    setOpen(true);
  };

  const closeList = () => {
    setOpen(false);
    setHighlighted(null);
    setTab(valueTab());
  };

  const toggle = (edge?: "first" | "last") => (open() ? closeList() : openList(edge));

  const change = (value: string) => {
    if (value !== props.value) props.onChange(value);
  };

  const commit = (value: string) => {
    change(value);
    // After the click this press belongs to, which would otherwise land on
    // whatever sits under the list.
    setTimeout(closeList, 1);
  };

  const highlight = (value: string | undefined, reveal = true) => {
    if (value === undefined) return;
    setHighlighted(value);
    const row = rowElements.get(value);
    row?.focus({ preventScroll: true });
    if (reveal) row?.scrollIntoView?.({ block: "nearest" });
  };

  const triggerTypeahead = createTypeahead({
    keys: enabled,
    text: (value) => labelOf(value),
    current: () => props.value,
    onMatch: change,
  });

  const onTriggerKeyDown = (e: KeyboardEvent) => {
    if (props.disabled) return;
    triggerTypeahead(e);
    if (e.key === " " && e.defaultPrevented) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.stopPropagation();
      e.preventDefault();
      toggle("first");
    } else if (e.key === "ArrowUp") {
      e.stopPropagation();
      e.preventDefault();
      toggle("last");
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const rows = enabled();
      const at = rows.indexOf(props.value);
      const next = at < 0 ? rows[0] : rows[at + (e.key === "ArrowLeft" ? -1 : 1)];
      if (next !== undefined) change(next);
    }
  };

  const renderRow = (key: string) => {
    const value = valueOfKey(key);
    if (value === undefined) {
      const group = () => {
        const row = list.row(key);
        return row?.kind === "section" ? row.group : undefined;
      };
      return (
        <li role="presentation" class={styles.section} hidden={!!group() && offTab(group()!)}>
          {group()?.label}
        </li>
      );
    }
    const option = () => {
      const row = list.row(key);
      return row?.kind === "option" ? row.option : undefined;
    };
    const disabled = () => !option() || isDisabled(option()!);
    const isSelected = () => selected()?.value === value;
    return (
      <li
        ref={(el) => {
          rowElements.set(value, el);
          onCleanup(() => rowElements.delete(value));
        }}
        role="option"
        class={styles.item}
        hidden={!!option() && offTab(option()!)}
        tabindex={disabled() ? undefined : highlighted() === value ? 0 : -1}
        aria-disabled={disabled() ? "true" : "false"}
        aria-selected={isSelected() ? "true" : "false"}
        data-disabled={disabled() ? "" : undefined}
        data-selected={isSelected() ? "" : undefined}
        data-highlighted={highlighted() === value ? "" : undefined}
        onPointerDown={(e) => {
          pressType = e.pointerType;
        }}
        onPointerUp={(e) => {
          if (!disabled() && e.pointerType === "mouse" && e.button === 0) commit(value);
        }}
        onClick={() => {
          if (!disabled() && pressType !== "mouse") commit(value);
          pressType = undefined;
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse" && !disabled() && highlighted() !== value) highlight(value, false);
        }}
        onMouseDown={(e) => {
          if (disabled()) e.preventDefault();
        }}
      >
        <div class={styles.itemLabel}>{option()?.label}</div>
        <Show when={isSelected()}>
          <div class={styles.check} aria-hidden="true">
            <Icon icon={Check} />
          </div>
        </Show>
      </li>
    );
  };

  return (
    <div role="group">
      <button
        ref={(el) => {
          setTrigger(el);
          props.ref?.(el);
        }}
        id={triggerId}
        type="button"
        class={[styles.trigger, styles[props.size ?? "md"], props.class].filter(Boolean).join(" ")}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? listId : undefined}
        aria-label={props["aria-label"]}
        aria-labelledby={triggerLabelledBy()}
        data-expanded={open() ? "" : undefined}
        data-closed={open() ? undefined : ""}
        onPointerDown={(e) => {
          e.currentTarget.dataset.pointerType = e.pointerType;
          if (props.disabled || e.pointerType === "touch" || e.button !== 0) return;
          // Keeps the button from taking focus back from the row that opening lands on.
          e.preventDefault();
          toggle();
        }}
        onClick={(e) => {
          if (!props.disabled && e.currentTarget.dataset.pointerType === "touch") toggle();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span id={valueId} class={styles.value} data-placeholder-shown={selected() ? undefined : ""}>
          {selected()?.label ?? props.placeholder}
        </span>
        <span class={styles.caret} aria-hidden="true">
          <Icon icon={ChevronsUpDown} />
        </span>
      </button>
      <Show when={open()}>
        {/* Mounted into the enclosing dialog's panel when there is one (the
            debug-target picker), to document.body otherwise; same call Dropdown
            makes, and for the same reason. */}
        <Portal mount={dialogSurface()}>
          <ListSurface
            trigger={trigger()}
            class={[styles.content, props.tabs && styles.tabbed].filter(Boolean).join(" ")}
            listClass={styles.listbox}
            tabsClass={styles.tabs}
            listId={listId}
            labelledBy={listLabelledBy()}
            hasTabs={!!props.tabs}
            keys={enabled}
            label={labelOf}
            highlighted={highlighted}
            highlight={highlight}
            rowElement={(value) => rowElements.get(value)}
            onCommit={commit}
            onDismiss={closeList}
            before={
              <>
                <Glide active={(surface) => surface.querySelector(`.${styles.item}[data-highlighted]`)} />
                <Show when={props.tabs}>
                  {(tabs) => (
                    <SegmentedControl
                      class={styles.tabs}
                      size="sm"
                      options={tabs().map((t, i) => ({ value: String(i), label: t.label }))}
                      value={String(tab())}
                      onChange={(i) => {
                        setTab(Number(i));
                        const current = highlighted();
                        if (current !== null && !enabled().includes(current)) setHighlighted(null);
                      }}
                      aria-label={props.tabsLabel}
                    />
                  )}
                </Show>
              </>
            }
          >
            <For each={list.keys()}>{renderRow}</For>
          </ListSurface>
        </Portal>
      </Show>
    </div>
  );
}

// Inside the portal so these effects run once it is connected: showPopover
// throws on a node that is not in the document.
function ListSurface(props: {
  trigger: HTMLElement | undefined;
  class: string;
  listClass: string;
  tabsClass: string;
  listId: string;
  labelledBy: string | undefined;
  hasTabs: boolean;
  keys: () => string[];
  label: (value: string) => string;
  highlighted: () => string | null;
  highlight: (value: string | undefined) => void;
  rowElement: (value: string) => HTMLElement | undefined;
  onCommit: (value: string) => void;
  onDismiss: () => void;
  before: JSX.Element;
  children: JSX.Element;
}) {
  let surface!: HTMLDivElement;
  let listbox!: HTMLUListElement;

  const typeahead = createTypeahead({
    keys: () => props.keys(),
    text: (value) => props.label(value),
    current: () => props.highlighted(),
    onMatch: (value) => props.highlight(value),
  });

  createEffect(() => {
    const anchor = props.trigger;
    if (!anchor) return;
    onCleanup(anchorLayer(anchor, surface, "bottom", TRIGGER_GUTTER));
  });

  createEffect(() =>
    untrack(() => {
      onCleanup(
        openLayer({
          element: surface,
          show: () => surface.showPopover(),
          hide: () => surface.hidePopover(),
          onDismiss: () => props.onDismiss(),
          ignorePress: (target) => !!props.trigger?.contains(target),
          dismissOnFocusOutside: true,
          returnFocus: () => props.trigger,
        }),
      );
      const moveFocus = () => {
        if (!surface.isConnected) return;
        const start = props.highlighted();
        if (start === null) listbox.focus({ preventScroll: true });
        else props.highlight(start);
      };
      // The press's own mousedown moves focus after this, so land behind it.
      if (window.event?.type === "pointerdown") setTimeout(moveFocus);
      else moveFocus();
    }),
  );

  const onSurfaceKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    if (!props.hasTabs) return;
    if (listbox.contains(e.target as Node)) {
      surface.querySelector<HTMLElement>(`.${props.tabsClass} [tabindex="0"]`)?.focus();
    } else {
      const current = props.highlighted();
      (current === null ? listbox : (props.rowElement(current) ?? listbox)).focus({ preventScroll: true });
    }
  };

  const onListKeyDown = (e: KeyboardEvent) => {
    const rows = props.keys();
    const current = props.highlighted();
    const at = current === null ? -1 : rows.indexOf(current);
    const page = (step: 1 | -1) => {
      const elements = rows.flatMap((value) => props.rowElement(value) ?? []);
      return rows[pageTarget(elements, at, step, surface.clientHeight)];
    };
    if (e.key === "ArrowDown") props.highlight(at < 0 ? rows[0] : rows[at + 1]);
    else if (e.key === "ArrowUp") props.highlight(at < 0 ? rows[rows.length - 1] : rows[at - 1]);
    else if (e.key === "Home") props.highlight(rows[0]);
    else if (e.key === "End") props.highlight(rows[rows.length - 1]);
    else if (e.key === "PageDown" && at >= 0) props.highlight(page(1));
    else if (e.key === "PageUp" && at >= 0) props.highlight(page(-1));
    else if (e.key === "Enter" || e.key === " ") {
      if (e.key === " ") {
        typeahead(e);
        if (e.defaultPrevented) return;
      }
      if (current !== null) props.onCommit(current);
    } else {
      typeahead(e);
      return;
    }
    e.preventDefault();
  };

  return (
    <div ref={surface} popover="manual" class={props.class} data-expanded="" onKeyDown={onSurfaceKeyDown}>
      {props.before}
      <ul
        ref={listbox}
        id={props.listId}
        role="listbox"
        tabindex={-1}
        class={props.listClass}
        aria-labelledby={props.labelledBy}
        onKeyDown={onListKeyDown}
      >
        {props.children}
      </ul>
    </div>
  );
}
