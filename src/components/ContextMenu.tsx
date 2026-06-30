import { For, onCleanup, onMount, createSignal } from "solid-js";
import { Portal } from "solid-js/web";

// A right-click menu entry: an action row, or a visual separator.
export type MenuItem =
  | { separator: true }
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean };

// Where the menu opens and what it shows. Held by the caller as a signal that is
// set on `contextmenu` and cleared on close.
export type MenuState = { x: number; y: number; items: MenuItem[] };

// A portaled, viewport-overflow-safe context menu. Mirrors the tab-bar dropdown
// pattern (portal out of clipping ancestors, fixed positioning) and adds cursor
// anchoring with edge clamping, plus escape / outside-click close.
export default function ContextMenu(props: { menu: MenuState; onClose: () => void }) {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: props.menu.x, top: props.menu.y });

  // The menu's own size is known only after mount, so clamp it into the viewport
  // then (flip back from the right/bottom edge rather than overflow).
  onMount(() => {
    requestAnimationFrame(() => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pad = 6;
      let left = props.menu.x;
      let top = props.menu.y;
      if (left + r.width > window.innerWidth - pad) left = window.innerWidth - r.width - pad;
      if (top + r.height > window.innerHeight - pad) top = window.innerHeight - r.height - pad;
      setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
    });
  });

  function onDocMouseDown(e: MouseEvent) {
    if (el && !el.contains(e.target as Node)) props.onClose();
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
  }
  onMount(() => {
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDocMouseDown);
    document.removeEventListener("keydown", onKeyDown);
  });

  return (
    <Portal>
      <div
        ref={el}
        class="ctx-menu"
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <For each={props.menu.items}>
          {(it) =>
            "separator" in it ? (
              <div class="ctx-sep" />
            ) : (
              <div
                class="ctx-item"
                classList={{ danger: !!it.danger, disabled: !!it.disabled }}
                onClick={() => {
                  if (it.disabled) return;
                  props.onClose();
                  it.onClick();
                }}
              >
                {it.label}
              </div>
            )
          }
        </For>
      </div>
    </Portal>
  );
}
