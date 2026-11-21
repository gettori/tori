import { createContext, splitProps, useContext, type Component, type JSX, type ValidComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createItemOrder, createRovingFocus } from "../../lib/keyboard";
import { callHandler, type TriggerHandler } from "../callHandler";

type GroupValue = {
  order: ReturnType<typeof createItemOrder>;
  roving: ReturnType<typeof createRovingFocus>;
  pressed: (value: string) => boolean;
  press: (value: string) => void;
};

const GroupContext = createContext<GroupValue>();

export interface ToggleGroupRootProps extends JSX.HTMLAttributes<HTMLDivElement> {
  pressed: (value: string) => boolean;
  onPress: (value: string) => void;
}

function Root(props: ToggleGroupRootProps) {
  const [local, rest] = splitProps(props, ["pressed", "onPress", "ref", "onKeyDown", "onMouseDown"]);
  const order = createItemOrder();
  const roving = createRovingFocus({
    keys: order.keys,
    orientation: "horizontal",
    selected: () => order.keys().find((key) => local.pressed(key)),
    wrap: true,
    rootTabStop: true,
    allowModifiers: true,
    preventScroll: true,
  });

  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    callHandler(e, local.onKeyDown as TriggerHandler);
    roving.root.onKeyDown(e);
    // A vertical arrow inside the strip must not scroll the pane behind it.
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.currentTarget.contains(e.target as Node)) {
      e.preventDefault();
    }
  };

  const onMouseDown = (e: MouseEvent & { currentTarget: HTMLDivElement }) => {
    callHandler(e, local.onMouseDown as TriggerHandler);
    if (e.target === e.currentTarget) e.preventDefault();
  };

  return (
    <GroupContext.Provider value={{ order, roving, pressed: local.pressed, press: (v) => local.onPress(v) }}>
      <div
        ref={local.ref}
        role="group"
        data-orientation="horizontal"
        tabindex={roving.root.tabindex}
        onFocus={roving.root.onFocus}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        {...rest}
      />
    </GroupContext.Provider>
  );
}

export type ToggleGroupItemProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "value" | "type"> & {
  value: string;
  type?: "submit" | "reset" | "button";
};

function Item<P extends Record<string, any> = {}>(
  props: Omit<ToggleGroupItemProps, keyof P> & P & { value: string; disabled?: boolean; as?: Component<P> },
) {
  const group = useContext(GroupContext);
  if (!group) throw new Error("ToggleGroup.Item needs a ToggleGroup.Root");
  const [local, rest] = splitProps(props as ToggleGroupItemProps & { as?: ValidComponent }, [
    "as",
    "value",
    "disabled",
    "ref",
    "onPointerDown",
    "onClick",
    "onKeyDown",
    "onMouseDown",
    "onFocus",
  ]);
  const item = group.roving.item(local.value);
  let pointerType: string | undefined;

  const handlers = {
    ref: (el: HTMLButtonElement) => {
      item.ref(el);
      group.order.register({ key: local.value, element: el, disabled: () => !!local.disabled });
      (local.ref as ((el: HTMLButtonElement) => void) | undefined)?.(el);
    },
    onPointerDown: (e: PointerEvent) => {
      callHandler(e, local.onPointerDown as TriggerHandler);
      if (local.disabled) return;
      pointerType = e.pointerType;
      if (e.pointerType === "mouse" && e.button === 0) group.press(local.value);
    },
    onClick: (e: MouseEvent) => {
      callHandler(e, local.onClick as TriggerHandler);
      if (!local.disabled && pointerType !== "mouse") group.press(local.value);
    },
    onKeyDown: (e: KeyboardEvent) => {
      const activates = e.key === "Enter" || e.key === " ";
      // The press happens here, so the button's own click would be a second one.
      if (activates) e.preventDefault();
      callHandler(e, local.onKeyDown as TriggerHandler);
      if (activates && !local.disabled) group.press(local.value);
    },
    onMouseDown: (e: MouseEvent) => {
      callHandler(e, local.onMouseDown as TriggerHandler);
      if (local.disabled) e.preventDefault();
    },
    onFocus: (e: FocusEvent) => {
      callHandler(e, local.onFocus as TriggerHandler);
      if (!local.disabled) item.onFocus();
    },
  };

  return (
    <Dynamic
      component={(local.as ?? "button") as "button"}
      type="button"
      disabled={local.disabled}
      tabindex={local.disabled ? undefined : item.tabindex}
      aria-pressed={group.pressed(local.value) ? "true" : "false"}
      data-pressed={group.pressed(local.value) ? "" : undefined}
      data-disabled={local.disabled ? "" : undefined}
      data-orientation="horizontal"
      {...handlers}
      {...rest}
    />
  );
}

export const ToggleGroup = {
  Root,
  Item,
  ButtonItem: Item as Component<ToggleGroupItemProps>,
};
