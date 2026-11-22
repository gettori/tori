import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

export type RovingOrientation = "horizontal" | "vertical" | "both";

export interface RovingFocusOptions {
  keys: Accessor<readonly string[]>;
  orientation: RovingOrientation;
  selected?: Accessor<string | null | undefined>;
  wrap?: boolean;
  rootTabStop?: boolean;
  followSelected?: boolean;
  allowModifiers?: boolean;
  preventScroll?: boolean;
}

interface OrderedItem {
  key: string;
  element: HTMLElement;
  disabled: Accessor<boolean>;
}

const inDocumentOrder = (a: OrderedItem, b: OrderedItem) => {
  const position = a.element.compareDocumentPosition(b.element);
  if (position & Node.DOCUMENT_POSITION_DISCONNECTED) return 0;
  return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
};

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

export function createItemOrder() {
  const [items, setItems] = createSignal<readonly OrderedItem[]>([]);
  const keys = createMemo(() => items().flatMap((item) => (item.disabled() ? [] : [item.key])), {
    equals: sameKeys,
  });
  const allKeys = createMemo(() => items().map((item) => item.key), { equals: sameKeys });
  return {
    keys,
    allKeys,
    register(item: OrderedItem) {
      setItems((list) => [...list, item]);
      return () => setItems((list) => list.filter((other) => other !== item));
    },
    watch(container: HTMLElement) {
      const observer = new MutationObserver(() => setItems((list) => [...list].sort(inDocumentOrder)));
      observer.observe(container, { childList: true });
      return () => observer.disconnect();
    },
  };
}

function stepFor(key: string, orientation: RovingOrientation) {
  if (orientation !== "vertical") {
    if (key === "ArrowRight") return 1;
    if (key === "ArrowLeft") return -1;
  }
  if (orientation !== "horizontal") {
    if (key === "ArrowDown") return 1;
    if (key === "ArrowUp") return -1;
  }
  return 0;
}

export function createRovingFocus(options: RovingFocusOptions) {
  const [lastFocused, setLastFocused] = createSignal<string | null>(null);
  const elements = new Map<string, HTMLElement>();

  const active = createMemo(() => {
    const key = lastFocused();
    return key !== null && options.keys().includes(key) ? key : null;
  });

  const entry = () => {
    const keys = options.keys();
    const selected = options.selected?.();
    return selected != null && keys.includes(selected) ? selected : keys[0];
  };

  const tabStop = () => {
    const key = active();
    if (key !== null && (!options.followSelected || elements.get(key)?.contains(document.activeElement))) return key;
    return options.rootTabStop ? key : (entry() ?? null);
  };
  const focus = (key: string | undefined) => {
    if (key !== undefined) elements.get(key)?.focus({ preventScroll: options.preventScroll });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (!options.allowModifiers && (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)) return;
    const keys = options.keys();
    const from = keys.findIndex((key) => elements.get(key)?.contains(e.target as Node));
    if (from < 0) return;

    let to: number;
    if (e.key === "Home") to = 0;
    else if (e.key === "End") to = keys.length - 1;
    else {
      const step = stepFor(e.key, options.orientation);
      if (step === 0) return;
      to = options.wrap
        ? (from + step + keys.length) % keys.length
        : Math.min(keys.length - 1, Math.max(0, from + step));
    }
    e.preventDefault();
    focus(keys[to]);
    return keys[to];
  };

  return {
    active,
    focus,
    root: {
      get tabindex() {
        if (!options.rootTabStop) return undefined;
        return active() === null ? 0 : -1;
      },
      onFocus: (e: FocusEvent) => {
        if (e.target === e.currentTarget) focus(entry());
      },
      onKeyDown,
    },
    item: (key: string) => {
      let own: HTMLElement | undefined;
      onCleanup(() => {
        if (own && elements.get(key) === own) elements.delete(key);
      });
      return {
        ref: (el: HTMLElement) => {
          own = el;
          elements.set(key, el);
        },
        get tabindex() {
          return tabStop() === key ? 0 : -1;
        },
        onFocus: () => setLastFocused(key),
      };
    },
  };
}

export interface TypeaheadOptions {
  keys: Accessor<readonly string[]>;
  text: (key: string) => string;
  current: Accessor<string | null | undefined>;
  onMatch: (key: string) => void;
}

const TYPEAHEAD_RESET_MS = 500;

export function createTypeahead(options: TypeaheadOptions) {
  let search = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const find = (needle: string, from: string | null | undefined) => {
    const keys = options.keys();
    const start = from == null ? 0 : Math.max(0, keys.indexOf(from));
    const lowered = needle.toLocaleLowerCase();
    return keys.slice(start).find((key) => options.text(key).toLocaleLowerCase().startsWith(lowered));
  };
  const findFromCurrent = (needle: string) => find(needle, options.current()) ?? find(needle, null);

  return (e: KeyboardEvent) => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
    // A space with nothing typed yet is the control's own activation key.
    if (e.key === " " && search.trim().length === 0) return;
    if (e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
    }

    search += e.key;
    let match = findFromCurrent(search);
    if (match === undefined && [...search].every((char) => char === search[0])) {
      search = search[0];
      match = findFromCurrent(search);
    }
    if (match !== undefined) options.onMatch(match);

    clearTimeout(timer);
    timer = setTimeout(() => (search = ""), TYPEAHEAD_RESET_MS);
  };
}
