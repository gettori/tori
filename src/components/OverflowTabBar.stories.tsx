import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { FileText, Plus } from "lucide-solid";
import Icon from "./Icon/Icon";
import IconButton from "./IconButton/IconButton";
import OverflowTabBar from "./OverflowTabBar";
import Tab from "./Tab/Tab";

type File = { id: string; name: string };

const meta = {
  title: "Components/OverflowTabBar",
  component: OverflowTabBar,
  args: {
    items: [],
    activeId: null,
    idOf: (t: File) => t.id,
    onActivate: () => {},
    onReorder: () => {},
    renderTab: () => null,
    renderMenuItem: () => null,
  },
} satisfies Meta<typeof OverflowTabBar<File>>;

export default meta;
type Story = StoryObj<typeof meta>;

const FILES: File[] = [
  "README.md",
  "tokens.css",
  "settings.rs",
  "resolver.ts",
  "roles.ts",
  "bundled.ts",
  "OverflowTabBar.tsx",
  "Tab.tsx",
  "Editor.tsx",
  "Terminal.tsx",
].map((name, i) => ({ id: `f${i}`, name }));

/** The editor strip's own rule, copied rather than imported: `editorTabs` is a
 *  CSS module inside a panel, and the bar takes a `class` rather than a `style`,
 *  so a story cannot dress it the way the others dress theirs. */
const STRIP_CSS = `
.sb-strip {
  display: flex;
  align-items: center;
  gap: calc(4px * var(--ui-scale));
  min-height: calc(40px * var(--ui-scale));
  padding: 0 calc(6px * var(--ui-scale));
  background: var(--canvas-card);
  border-bottom: 1px solid var(--border-default);
  overflow: hidden;
}`;

function Strip(props: { width: string; trailing?: boolean }) {
  const [items, setItems] = createSignal(FILES);
  const [active, setActive] = createSignal<string | null>("f0");
  return (
    <div style={{ width: props.width, resize: "horizontal", overflow: "auto" }}>
      <OverflowTabBar
        class="sb-strip"
        items={items()}
        activeId={active()}
        idOf={(t) => t.id}
        onActivate={setActive}
        onReorder={setItems}
        trailing={
          props.trailing ? (
            <IconButton icon={<Icon icon={Plus} />} aria-label="New file" tooltip="New file" />
          ) : undefined
        }
        renderTab={(t) => (
          <Tab
            value={t.id}
            icon={<Icon icon={FileText} />}
            tooltip={`/src/${t.name}`}
            onClose={() => setItems((fs) => fs.filter((x) => x.id !== t.id))}
          >
            {t.name}
          </Tab>
        )}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
      <style>{STRIP_CSS}</style>
    </div>
  );
}

/** A strip too narrow for its tabs, which is the state this component exists
 *  for: it never scrolls, it draws the tabs that fully fit and counts the rest
 *  behind a `+N` menu. Drag the resize handle to watch the row collapse and
 *  recover.
 *
 *  Two things are worth reading with a screen reader rather than with eyes. Each
 *  tab announces its place in the **open** list rather than in the row on screen
 *  ("3 of 10", not "3 of 3"), because a strip that says "3 of 3" tells you the
 *  other seven do not exist. And the arrows only reach the tabs that are drawn,
 *  so an overflowed tab is keyboard-reachable through the `+N` menu alone. */
export const Overflowing: Story = {
  render: () => <Strip width="520px" />,
};

/** The same strip with room for everything, so no `+N` appears at all. */
export const Roomy: Story = {
  render: () => <Strip width="1200px" />,
};

/** With a pinned trailing action, the way the editor hangs its filetree toggle
 *  and the terminal its New button. It sits outside the tablist, since a
 *  tablist may own nothing but tabs, and its width is reserved before the fit is
 *  measured rather than after, so the row never overlaps it. */
export const WithTrailing: Story = {
  render: () => <Strip width="520px" trailing />,
};
