import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import Button from "../components/Button/Button";
import { anchorLayer, openLayer, type LayerPlacement } from "./layer";

function ModalLayer(props: { onClose: () => void; children: JSX.Element }) {
  let el!: HTMLDialogElement;
  createEffect(() => {
    const release = openLayer({
      element: el,
      show: () => el.showModal(),
      hide: () => el.close(),
      modal: true,
      onDismiss: () => props.onClose(),
    });
    onCleanup(release);
  });
  return (
    <dialog ref={el} aria-label="Outer dialog" data-testid="layer-dialog" style={{ padding: "24px", width: "420px" }}>
      {props.children}
    </dialog>
  );
}

function FloatingLayer(props: {
  anchor: HTMLElement;
  placement: LayerPlacement;
  label: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  let el!: HTMLDivElement;
  createEffect(() => {
    const anchor = props.anchor;
    const unanchor = anchorLayer(anchor, el, props.placement, 4);
    const release = openLayer({
      element: el,
      show: () => el.showPopover(),
      hide: () => el.hidePopover(),
      onDismiss: () => props.onClose(),
      ignorePress: (target) => anchor.contains(target),
    });
    onCleanup(() => {
      release();
      unanchor();
    });
  });
  return (
    <div
      ref={el}
      popover="manual"
      role="group"
      aria-label={props.label}
      style={{
        padding: "12px",
        background: "var(--canvas-card)",
        border: "1px solid var(--border-default)",
        "border-radius": "var(--tori-radius-lg)",
      }}
    >
      {props.children}
    </div>
  );
}

function NestedLayers() {
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [popoverOpen, setPopoverOpen] = createSignal(false);
  const [nestedOpen, setNestedOpen] = createSignal(false);
  const [popoverAnchor, setPopoverAnchor] = createSignal<HTMLElement>();
  const [nestedAnchor, setNestedAnchor] = createSignal<HTMLElement>();

  return (
    <>
      <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
      <Show when={dialogOpen()}>
        <ModalLayer onClose={() => setDialogOpen(false)}>
          <p>Escape or an outside press closes one layer at a time.</p>
          <span ref={setPopoverAnchor} style={{ display: "inline-block" }}>
            <Button onClick={() => setPopoverOpen((open) => !open)}>Open popover</Button>
          </span>
          <Show when={popoverOpen() && popoverAnchor()}>
            {(anchor) => (
              <FloatingLayer
                anchor={anchor()}
                placement="bottom-start"
                label="Popover"
                onClose={() => setPopoverOpen(false)}
              >
                <span ref={setNestedAnchor} style={{ display: "inline-block" }}>
                  <Button onClick={() => setNestedOpen((open) => !open)}>Open nested</Button>
                </span>
                <Show when={nestedOpen() && nestedAnchor()}>
                  {(inner) => (
                    <FloatingLayer
                      anchor={inner()}
                      placement="right-start"
                      label="Nested layer"
                      onClose={() => setNestedOpen(false)}
                    >
                      <Button>Nested action</Button>
                    </FloatingLayer>
                  )}
                </Show>
              </FloatingLayer>
            )}
          </Show>
        </ModalLayer>
      </Show>
    </>
  );
}

const meta = {
  title: "Foundations/Layers",
  component: NestedLayers,
} satisfies Meta<typeof NestedLayers>;

export default meta;

export const Nested: StoryObj<typeof meta> = {};
