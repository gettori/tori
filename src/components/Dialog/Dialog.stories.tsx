import { lazyArg } from "../../../.storybook/lazyArg";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For } from "solid-js";
import Button from "../Button/Button";
import Dialog, { type DialogSize } from "./Dialog";

const SIZES: DialogSize[] = ["confirm", "sheet", "wide"];

const meta = {
  title: "Components/Dialog",
  component: Dialog,
  argTypes: {
    size: { control: "select", options: SIZES },
    open: { control: "boolean" },
    titleHidden: { control: "boolean" },
    title: { control: "text" },
    description: { control: "text" },
  },
  args: {
    open: true,
    size: "confirm",
    title: "Delete branch",
    description: "This cannot be undone.",
    onClose: () => {},
  },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const Actions = (props: { confirm?: string; danger?: boolean }) => (
  <>
    <Button>Cancel</Button>
    <Button variant={props.danger ? "danger" : "primary"}>{props.confirm ?? "OK"}</Button>
  </>
);

/** Every prop live in the controls panel. Only one dialog can be judged at a
 *  time: they are all centred on the viewport, so two open at once overlap. */
export const Playground: Story = {
  args: {
    children: "Delete `feature/omnibox` and everything on it?",
    actions: lazyArg(() => <Actions confirm="Delete" danger />),
  },
};

/** 420px. Prose and a button row, the shape 12 of the 14 legacy dialogs have. */
export const Confirm: Story = {
  args: {
    size: "confirm",
    children: "Delete `feature/omnibox` and everything on it?",
    actions: lazyArg(() => <Actions confirm="Delete" danger />),
  },
};

/** 480px, the width a form column wants. */
export const Sheet: Story = {
  args: {
    size: "sheet",
    title: "New project",
    description: "Names may not contain spaces.",
    children: lazyArg(() => (
      <label style={{ display: "grid", gap: "var(--tori-space-2)" }}>
        Project name
        <input />
      </label>
    )),
    actions: lazyArg(() => <Actions confirm="Create" />),
  },
};

/** The one size that grows with the window: floored at 680px, capped at 1040px,
 *  52vw between. Drag the preview wide, or switch to a large viewport: this
 *  panel gains columns while `confirm` and `sheet` hold their measure. */
export const Wide: Story = {
  args: {
    size: "wide",
    title: "Keyboard shortcuts",
    description: undefined,
    children: lazyArg(() => (
      <div
        style={{
          display: "grid",
          "grid-template-columns": "repeat(auto-fill, minmax(240px, 1fr))",
          gap: "var(--tori-space-4)",
        }}
      >
        <For each={Array.from({ length: 12 }, (_, i) => i)}>
          {(i) => (
            <div style={{ display: "flex", "justify-content": "space-between" }}>
              <span>Command {i}</span>
              <kbd>⌘{i}</kbd>
            </div>
          )}
        </For>
      </div>
    )),
  },
};

/** No title line in the layout, still named for a screen reader. The shortcut
 *  sheet's shape: migrating it must not invent a visible heading. */
export const HiddenTitle: Story = {
  args: {
    size: "wide",
    titleHidden: true,
    title: "Keyboard shortcuts",
    description: undefined,
    children: "A dialog whose design has no title line.",
  },
};

export const TopPlacement: Story = {
  args: {
    placement: "top",
    size: "palette",
    title: "Go to anything",
    titleHidden: true,
    description: undefined,
    children: "Pinned by its top edge, at the 640px size.",
  },
  render: (args) => (
    <>
      <Dialog {...meta.args} actions={<Actions confirm="Delete" danger />}>
        Centred on the window.
      </Dialog>
      <Dialog {...args} />
    </>
  ),
};

/** A body longer than the window. The panel is bounded, the body scrolls, and
 *  the actions row stays put: the page behind is scroll-locked, so an actions
 *  row pushed past the viewport would be unreachable. */
export const Overflowing: Story = {
  args: {
    size: "sheet",
    title: "Select a debug target",
    description: undefined,
    children: lazyArg(() => (
      <ul style={{ margin: 0, "padding-left": "var(--tori-space-6)" }}>
        <For each={Array.from({ length: 60 }, (_, i) => i)}>{(i) => <li>Target {i}</li>}</For>
      </ul>
    )),
    actions: lazyArg(() => <Actions confirm="Attach" />),
  },
};
