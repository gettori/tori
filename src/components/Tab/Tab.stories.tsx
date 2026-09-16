import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, For } from "solid-js";
import { FileText, FileCode, Braces } from "lucide-solid";
import Icon from "../Icon/Icon";
import { Tabs } from "../../lib/tabs";
import Tab from "./Tab";

const meta = {
  title: "Components/Tab",
  component: Tab,
  args: { value: "a" },
} satisfies Meta<typeof Tab>;

export default meta;
type Story = StoryObj<typeof meta>;

const FILES = [
  { value: "readme", label: "README.md", icon: FileText },
  { value: "tokens", label: "tokens.css", icon: Braces },
  { value: "settings", label: "settings.rs", icon: FileCode },
];

/** The pill on its own strip.
 *
 *  A `Tab` is always a Kobalte trigger, so it needs a `Tabs.Root` and a
 *  `Tabs.List` over it: selection, the roving tab stop and arrow navigation all
 *  come from the strip rather than from the call site. Rendered on its own it
 *  throws, deliberately, rather than quietly becoming a button wearing
 *  `role="tab"`.
 *
 *  Keyboard is the automatic-activation pattern, one model across all four of
 *  Tori's strips: Tab enters the strip on the selected pill and leaves it in one
 *  press, and arrows move *and* select as they go. */
export const Default: Story = {
  render: () => {
    const [open, setOpen] = createSignal("readme");
    return (
      <Tabs.Root value={open()} onChange={setOpen}>
        <Tabs.List
          aria-label="Open files"
          style={{ display: "flex", "align-items": "center", gap: "calc(4px * var(--ui-scale))" }}
        >
          <For each={FILES}>
            {(f) => (
              <Tab value={f.value} icon={<Icon icon={f.icon} />} tooltip={`/src/${f.label}`}>
                {f.label}
              </Tab>
            )}
          </For>
        </Tabs.List>
      </Tabs.Root>
    );
  },
};

/** With a close affordance, which is the shape the editor and terminal strips
 *  use.
 *
 *  The close is a **sibling** of the trigger rather than a child of it, and it
 *  is hidden from assistive tech: `role="tablist"` may own nothing but
 *  `role="tab"`, so a labelled button beside the trigger fails
 *  `aria-required-children` and one nested inside it fails `nested-interactive`.
 *  It is a pointer affordance and nothing else. **Delete or Backspace on the
 *  focused tab is the path that is actually announced**, which is also why the
 *  strip is one tab stop rather than two per tab. */
export const Closable: Story = {
  render: () => {
    const [open, setOpen] = createSignal(FILES);
    const [active, setActive] = createSignal("readme");
    return (
      <Tabs.Root value={active()} onChange={setActive}>
        <Tabs.List
          aria-label="Open files"
          style={{ display: "flex", "align-items": "center", gap: "calc(4px * var(--ui-scale))" }}
        >
          <For each={open()}>
            {(f) => (
              <Tab
                value={f.value}
                icon={<Icon icon={f.icon} />}
                onClose={() => setOpen((fs) => fs.filter((x) => x.value !== f.value))}
              >
                {f.label}
              </Tab>
            )}
          </For>
        </Tabs.List>
      </Tabs.Root>
    );
  },
};

/** Trailing content, which the strips use for state a tab carries whether or not
 *  you are looking at it: a dirty dot in the editor, an agent's status mark in
 *  the terminal. It sits inside the trigger, so it joins the tab's accessible
 *  name - a dot with no text of its own contributes nothing, but anything that
 *  reads aloud would. */
export const WithTrailing: Story = {
  render: () => {
    const [active, setActive] = createSignal("readme");
    return (
      <Tabs.Root value={active()} onChange={setActive}>
        <Tabs.List
          aria-label="Open files"
          style={{ display: "flex", "align-items": "center", gap: "calc(4px * var(--ui-scale))" }}
        >
          <For each={FILES}>
            {(f, i) => (
              <Tab
                value={f.value}
                icon={<Icon icon={f.icon} />}
                trailing={i() === 0 ? <span class="tab-dirty">●</span> : undefined}
                onClose={() => {}}
              >
                {f.label}
              </Tab>
            )}
          </For>
        </Tabs.List>
      </Tabs.Root>
    );
  },
};
