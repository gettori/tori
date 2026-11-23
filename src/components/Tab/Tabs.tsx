import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  omit,
  untrack,
  useContext,
  type Component,
} from "solid-js";
import { type JSX, dynamic } from "@solidjs/web";
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

const TabsContext = createContext<TabsValue | null>(null);

const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export interface TabsRootProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onChange"> {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}

function Root(props: TabsRootProps) {
  const rest = omit(props, "value", "defaultValue", "onChange", "id");
  const fallbackId = `tabs-${createUniqueId()}`;
  const [uncontrolled, setUncontrolled] = createSignal(props.defaultValue);
  const order = createItemOrder();

  const selected = createMemo(() => props.value ?? uncontrolled());

  const select = (value: string) => {
    if (value === selected()) return;
    if (props.value === undefined) setUncontrolled(value);
    props.onChange?.(value);
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
  const id = () => (props.id ?? fallbackId) as string;

  let focusedTabRemoved = false;

  // Owners learn of a fallback through `onChange`: closing the selected tab
  // relies on it to pick a neighbour, and a panel with no active member to pick one.
  createEffect(
    () => ({
      all: order.allKeys(),
      enabled: order.keys(),
      current: selected(),
      controlled: props.value !== undefined,
    }),
    ({ all, enabled, current, controlled }) => {
      if (all.length > 0 && (current === undefined || !all.includes(current))) {
        const fallback = enabled[0] ?? all[0];
        if (!controlled) setUncontrolled(fallback);
        props.onChange?.(fallback);
      }
      if (!focusedTabRemoved) return;
      focusedTabRemoved = false;
      // After the fallback above commits, which cannot happen inside this callback.
      queueMicrotask(() => {
        const next = selected();
        roving.focus(next !== undefined && enabled.includes(next) ? next : enabled[0]);
      });
    },
  );

  const noteRemoved = (el: HTMLElement) => {
    if (el.contains(document.activeElement)) focusedTabRemoved = true;
  };
  // Chromium blurs a removed element and WebKit does not, so only WebKit keeps focus in the strip.
  const noteBlur = () => {
    focusedTabRemoved = false;
  };

  return (
    <TabsContext value={{ id, order, roving, selected, select, noteRemoved, noteBlur }}>
      <div id={id()} data-orientation="horizontal" {...rest} />
    </TabsContext>
  );
}

function useTabs() {
  const tabs = useContext(TabsContext);
  if (!tabs) throw new Error("A tab needs a Tabs.Root above it");
  return tabs;
}

function List(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const tabs = useTabs();
  const rest = omit(props, "ref", "onKeyDown");
  let stopWatching: (() => void) | undefined;
  onCleanup(() => stopWatching?.());

  const onKeyDown = (e: KeyboardEvent) => {
    callHandler(e, props.onKeyDown as TriggerHandler);
    const handled = e.defaultPrevented;
    const landed = tabs.roving.root.onKeyDown(e);
    const focusOnly = e.key.startsWith("Arrow") && (APPLE ? e.altKey : e.ctrlKey);
    if (!handled && landed !== undefined && !focusOnly) tabs.select(landed);
  };

  return (
    <div
      ref={(el) => {
        stopWatching = tabs.order.watch(el);
        (props.ref as ((el: HTMLDivElement) => void) | undefined)?.(el);
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
  const rest = omit(
    props,
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
  );
  const item = untrack(() => tabs.roving.item(props.value));
  const isSelected = () => tabs.selected() === props.value;
  let pointerType: string | undefined;
  let element: HTMLButtonElement | undefined;
  let unregister: (() => void) | undefined;
  onCleanup(() => {
    if (element) tabs.noteRemoved(element);
    unregister?.();
  });

  const handlers = {
    ref: (el: HTMLButtonElement) => {
      element = el;
      item.ref(el);
      unregister = tabs.order.register({ key: props.value, element: el, disabled: () => !!props.disabled });
      (props.ref as ((el: HTMLButtonElement) => void) | undefined)?.(el);
    },
    onPointerDown: (e: PointerEvent) => {
      callHandler(e, props.onPointerDown as TriggerHandler);
      if (props.disabled) return;
      pointerType = e.pointerType;
      if (e.pointerType === "mouse" && e.button === 0) tabs.select(props.value);
    },
    onClick: (e: MouseEvent & { currentTarget: HTMLElement }) => {
      callHandler(e, props.onClick as TriggerHandler);
      if (props.disabled) return;
      if (pointerType !== "mouse") tabs.select(props.value);
      // WebKit does not focus a clicked button.
      e.currentTarget.focus({ preventScroll: true });
    },
    onKeyDown: (e: KeyboardEvent) => {
      callHandler(e, props.onKeyDown as TriggerHandler);
      if (!props.disabled && !e.defaultPrevented && (e.key === "Enter" || e.key === " ")) tabs.select(props.value);
    },
    onMouseDown: (e: MouseEvent) => {
      callHandler(e, props.onMouseDown as TriggerHandler);
      if (props.disabled) e.preventDefault();
    },
    onFocus: (e: FocusEvent) => {
      callHandler(e, props.onFocus as TriggerHandler);
      if (!props.disabled) item.onFocus();
    },
    onBlur: (e: FocusEvent) => {
      callHandler(e, props.onBlur as TriggerHandler);
      tabs.noteBlur();
    },
  };

  const Control = dynamic(() => (props.as ?? "button") as "button");
  return (
    <Control
      type="button"
      id={props.id ?? `${tabs.id()}-trigger-${props.value}`}
      role="tab"
      disabled={props.disabled}
      tabindex={props.disabled ? undefined : item.tabindex}
      aria-selected={isSelected() ? "true" : "false"}
      aria-disabled={props.disabled ? "true" : undefined}
      data-key={props.value}
      data-orientation="horizontal"
      data-selected={isSelected() ? "" : undefined}
      data-highlighted={!props.disabled && item.tabindex === 0 ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      {...handlers}
      {...(rest as JSX.ButtonHTMLAttributes<HTMLButtonElement>)}
    />
  );
}

export const Tabs = { Root, List, Trigger };
