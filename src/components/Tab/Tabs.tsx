import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  splitProps,
  untrack,
  useContext,
  type Component,
  type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { createItemOrder, createRovingFocus } from "../../lib/keyboard";
import { callHandler, type TriggerHandler } from "../callHandler";

type TabsValue = {
  id: () => string;
  order: ReturnType<typeof createItemOrder>;
  roving: ReturnType<typeof createRovingFocus>;
  selected: () => string | undefined;
  select: (value: string) => void;
  noteRemoved: (el: HTMLElement) => void;
  noteBlur: () => void;
};

const TabsContext = createContext<TabsValue>();

const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export interface TabsRootProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onChange"> {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}

function Root(props: TabsRootProps) {
  const [local, rest] = splitProps(props, ["value", "defaultValue", "onChange", "id"]);
  const fallbackId = `tabs-${createUniqueId()}`;
  const [uncontrolled, setUncontrolled] = createSignal(local.defaultValue);
  const order = createItemOrder();

  const selected = createMemo(() => local.value ?? uncontrolled());

  const select = (value: string) => {
    if (value === selected()) return;
    if (local.value === undefined) setUncontrolled(value);
    local.onChange?.(value);
  };
  const roving = createRovingFocus({
    keys: order.keys,
    orientation: "horizontal",
    selected,
    wrap: true,
    followSelected: true,
    allowModifiers: true,
    preventScroll: true,
  });
  const id = () => local.id ?? fallbackId;

  let focusedTabRemoved = false;

  // Owners learn of a fallback through `onChange`: closing the selected tab
  // relies on it to pick a neighbour, and a panel with no active member to pick one.
  createEffect(() => {
    const all = order.allKeys();
    const enabled = order.keys();
    const current = selected();
    untrack(() => {
      if (all.length > 0 && (current === undefined || !all.includes(current))) {
        const fallback = enabled[0] ?? all[0];
        if (local.value === undefined) setUncontrolled(fallback);
        local.onChange?.(fallback);
      }
      if (!focusedTabRemoved) return;
      focusedTabRemoved = false;
      const next = selected();
      roving.focus(next !== undefined && enabled.includes(next) ? next : enabled[0]);
    });
  });

  const noteRemoved = (el: HTMLElement) => {
    if (el.contains(document.activeElement)) focusedTabRemoved = true;
  };
  // Chromium blurs a removed element and WebKit does not, so only WebKit keeps focus in the strip.
  const noteBlur = () => {
    focusedTabRemoved = false;
  };

  return (
    <TabsContext.Provider value={{ id, order, roving, selected, select, noteRemoved, noteBlur }}>
      <div id={id()} data-orientation="horizontal" {...rest} />
    </TabsContext.Provider>
  );
}

function useTabs() {
  const tabs = useContext(TabsContext);
  if (!tabs) throw new Error("A tab needs a Tabs.Root above it");
  return tabs;
}

function List(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const tabs = useTabs();
  const [local, rest] = splitProps(props, ["ref", "onKeyDown"]);

  const onKeyDown = (e: KeyboardEvent) => {
    callHandler(e, local.onKeyDown as TriggerHandler);
    const handled = e.defaultPrevented;
    tabs.roving.root.onKeyDown(e);
    const landed = tabs.roving.active();
    const focusOnly = e.key.startsWith("Arrow") && (APPLE ? e.altKey : e.ctrlKey);
    if (!handled && e.defaultPrevented && landed !== null && !focusOnly) tabs.select(landed);
  };

  return (
    <div
      ref={(el) => {
        tabs.order.watch(el);
        (local.ref as ((el: HTMLDivElement) => void) | undefined)?.(el);
      }}
      role="tablist"
      aria-orientation="horizontal"
      data-orientation="horizontal"
      onKeyDown={onKeyDown}
      {...rest}
    />
  );
}

export type TabsTriggerProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "value" | "type"> & {
  value: string;
  type?: "submit" | "reset" | "button";
  as?: Component<any>;
  [prop: string]: unknown;
};

function Trigger(props: TabsTriggerProps) {
  const tabs = useTabs();
  const [local, rest] = splitProps(props, [
    "as",
    "value",
    "disabled",
    "id",
    "ref",
    "onPointerDown",
    "onClick",
    "onKeyDown",
    "onMouseDown",
    "onFocus",
    "onBlur",
  ]);
  const item = tabs.roving.item(local.value);
  const isSelected = () => tabs.selected() === local.value;
  let pointerType: string | undefined;

  const handlers = {
    ref: (el: HTMLButtonElement) => {
      item.ref(el);
      tabs.order.register({ key: local.value, element: el, disabled: () => !!local.disabled });
      onCleanup(() => tabs.noteRemoved(el));
      (local.ref as ((el: HTMLButtonElement) => void) | undefined)?.(el);
    },
    onPointerDown: (e: PointerEvent) => {
      callHandler(e, local.onPointerDown as TriggerHandler);
      if (local.disabled) return;
      pointerType = e.pointerType;
      if (e.pointerType === "mouse" && e.button === 0) tabs.select(local.value);
    },
    onClick: (e: MouseEvent & { currentTarget: HTMLElement }) => {
      callHandler(e, local.onClick as TriggerHandler);
      if (local.disabled) return;
      if (pointerType !== "mouse") tabs.select(local.value);
      // WebKit does not focus a clicked button.
      e.currentTarget.focus({ preventScroll: true });
    },
    onKeyDown: (e: KeyboardEvent) => {
      callHandler(e, local.onKeyDown as TriggerHandler);
      if (!local.disabled && !e.defaultPrevented && (e.key === "Enter" || e.key === " ")) tabs.select(local.value);
    },
    onMouseDown: (e: MouseEvent) => {
      callHandler(e, local.onMouseDown as TriggerHandler);
      if (local.disabled) e.preventDefault();
    },
    onFocus: (e: FocusEvent) => {
      callHandler(e, local.onFocus as TriggerHandler);
      if (!local.disabled) item.onFocus();
    },
    onBlur: (e: FocusEvent) => {
      callHandler(e, local.onBlur as TriggerHandler);
      tabs.noteBlur();
    },
  };

  return (
    <Dynamic
      component={(local.as ?? "button") as "button"}
      type="button"
      id={local.id ?? `${tabs.id()}-trigger-${local.value}`}
      role="tab"
      disabled={local.disabled}
      tabindex={local.disabled ? undefined : item.tabindex}
      aria-selected={isSelected() ? "true" : "false"}
      aria-disabled={local.disabled ? "true" : undefined}
      data-key={local.value}
      data-orientation="horizontal"
      data-selected={isSelected() ? "" : undefined}
      data-highlighted={!local.disabled && item.tabindex === 0 ? "" : undefined}
      data-disabled={local.disabled ? "" : undefined}
      {...handlers}
      {...(rest as JSX.ButtonHTMLAttributes<HTMLButtonElement>)}
    />
  );
}

export const Tabs = { Root, List, Trigger };
