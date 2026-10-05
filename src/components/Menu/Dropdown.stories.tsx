import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For, createSignal } from "solid-js";
import Button from "../Button/Button";
import Dropdown, { type MenuPlacement } from "./Dropdown";
import { MenuRow, MenuSeparator, MenuSub } from "./rows";

const PLACEMENTS: MenuPlacement[] = ["bottom-start", "bottom-end", "top-start", "top-end"];

const meta = {
  title: "Components/Dropdown",
  component: Dropdown,
  argTypes: {
    placement: { control: "select", options: PLACEMENTS },
    modal: { control: "boolean" },
  },
  args: {
    children: "Actions",
    items: [
      { label: "New session", onClick: () => {} },
      { label: "Commit log", onClick: () => {} },
      { separator: true },
      { label: "Remove worktree", onClick: () => {}, danger: true },
    ],
  },
} satisfies Meta<typeof Dropdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The trigger case: the split buttons, the tab-overflow list, the model picker.
 *  Kobalte anchors the menu to the trigger itself, which is what deletes the
 *  `getBoundingClientRect` measuring every one of those sites does today. */
export const Playground: Story = {};

/** Placement is a preference, not a promise: Kobalte flips a menu that would
 *  leave the viewport. Drag the preview short and `bottom-start` becomes
 *  `top-start` on its own, which is what the composer's picker used to need an
 *  `openAbove` flag for. */
export const Placements: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: "var(--tori-space-6)",
        padding: "120px var(--tori-space-6)",
      }}
    >
      <For each={PLACEMENTS}>
        {(placement) => (
          <Dropdown
            placement={placement}
            items={[
              { label: "First", onClick: () => {} },
              { label: "Second", onClick: () => {} },
            ]}
          >
            {placement}
          </Dropdown>
        )}
      </For>
    </div>
  ),
};

/** No trigger at all. The menu is opened from state and placed at a point, which
 *  is what CodeEditor's code-action menu needs: the caret is not an element.
 *  Click anywhere in the box, then press Escape - focus goes back to where it
 *  was, which Kobalte cannot do on its own here because there is no trigger for
 *  it to aim at. */
export const AtAPoint: Story = {
  render: () => {
    const [anchor, setAnchor] = createSignal<{ x: number; y: number }>();
    return (
      <div
        style={{
          height: "320px",
          display: "grid",
          "place-items": "center",
          border: "1px dashed var(--border-default)",
          "border-radius": "var(--tori-radius-lg)",
          color: "var(--fg-muted)",
        }}
        onClick={(e) => setAnchor({ x: e.clientX, y: e.clientY })}
      >
        <Button onClick={() => setAnchor(undefined)}>Somewhere to return to</Button>
        <Dropdown
          open={anchor() != null}
          anchor={anchor() ?? { x: 0, y: 0 }}
          onOpenChange={(open) => !open && setAnchor(undefined)}
          items={[
            { label: "Add import for `useDialogSurface`", onClick: () => {} },
            { label: "Rename symbol", onClick: () => {} },
            { separator: true },
            { label: "Ignore this diagnostic", onClick: () => {}, warn: true },
          ]}
        />
      </div>
    );
  },
};

/** The same row layer the context menus use, so a dropdown with rich rows and a
 *  right-click menu with rich rows cannot drift apart. */
export const CustomRows: Story = {
  render: () => (
    <Dropdown
      menu={
        <>
          <MenuRow onClick={() => {}}>
            <span class="tab-name">Editor.tsx</span>
            <span style={{ color: "var(--fg-muted)" }}>M</span>
          </MenuRow>
          <MenuRow onClick={() => {}}>
            <span class="tab-name">LeftSidebar.tsx</span>
          </MenuRow>
          <MenuSeparator />
          <MenuRow onClick={() => {}} danger>
            Close all
          </MenuRow>
        </>
      }
    >
      +2
    </Dropdown>
  ),
};

/** A level that opens beside its row rather than replacing the list. This is
 *  what Breadcrumbs' folder picker became: the old one navigated *in place*, so
 *  the way back out was the Escape key and the trail you had walked was gone
 *  from the screen. A flyout keeps every level you opened on screen at once.
 *
 *  Hover the row, or press ArrowRight on it. ArrowLeft comes back. */
export const Submenus: Story = {
  render: () => (
    <Dropdown
      menu={
        <>
          <MenuRow onClick={() => {}}>package.json</MenuRow>
          <MenuSub label={<span class="tab-name">src</span>}>
            <MenuRow onClick={() => {}}>main.tsx</MenuRow>
            <MenuSub label={<span class="tab-name">panels</span>}>
              <MenuRow onClick={() => {}}>Editor.tsx</MenuRow>
              <MenuRow onClick={() => {}}>Terminal.tsx</MenuRow>
            </MenuSub>
          </MenuSub>
          <MenuSub label={<span class="tab-name">node_modules</span>} disabled>
            <MenuRow onClick={() => {}}>Never reached.</MenuRow>
          </MenuSub>
        </>
      }
    >
      src
    </Dropdown>
  ),
};
