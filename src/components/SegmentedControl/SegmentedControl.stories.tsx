import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { List, LayoutGrid, Rows3 } from "lucide-solid";
import Icon from "../Icon/Icon";
import SegmentedControl from "./SegmentedControl";
import type { ControlSize } from "../controls";

const SIZES: ControlSize[] = ["md", "sm", "xs"];

const meta = {
  title: "Components/SegmentedControl",
  component: SegmentedControl,
  argTypes: {
    size: { control: "inline-radio", options: SIZES },
  },
  args: {
    size: "md",
    options: [],
    value: "",
    onChange: () => {},
  },
} satisfies Meta<typeof SegmentedControl<string>>;

export default meta;
type Story = StoryObj<typeof meta>;

const PANES = [
  { value: "files", label: "Files" },
  { value: "changes", label: "Changes" },
  { value: "search", label: "Search" },
];

/** The default strip: one bordered group, the selected segment filled with the
 *  quiet tab-active token rather than a brand fill, so a dialog holding one
 *  stays calm. Keyboard is the toggle-button pattern Kobalte gives: Tab enters
 *  on the selected segment, arrows and Home/End move focus without selecting,
 *  and Space or Enter commits. Those activation keys stop at the strip, so a
 *  dialog's own Enter-to-confirm cannot fire from inside it. */
export const Default: Story = {
  render: (args) => {
    const [pane, setPane] = createSignal("files");
    return (
      <SegmentedControl
        size={args.size}
        options={PANES}
        value={pane()}
        onChange={setPane}
        aria-label="Right panel"
      />
    );
  },
};

/** Every size, which is the whole of the variant surface. Each maps to a fixed
 *  control-height token, so a strip lines up with the buttons and inputs beside
 *  it rather than being sized by its own text. */
export const Sizes: Story = {
  render: () => {
    const [pane, setPane] = createSignal("files");
    return (
      <div style={{ display: "flex", "align-items": "center", gap: "var(--sway-space-4)" }}>
        {SIZES.map((size) => (
          <SegmentedControl
            size={size}
            options={PANES}
            value={pane()}
            onChange={setPane}
            aria-label={`Right panel (${size})`}
          />
        ))}
      </div>
    );
  },
};

/** Icons, with and without text. An icon-only segment has no visible label, so
 *  it carries its own `aria-label`; without one the segment ships nameless and
 *  the axe gate in `SegmentedControl.test.tsx` fails it. */
export const WithIcons: Story = {
  render: () => {
    const [view, setView] = createSignal("list");
    const [density, setDensity] = createSignal("comfortable");
    return (
      <div style={{ display: "flex", "align-items": "center", gap: "var(--sway-space-4)" }}>
        <SegmentedControl
          options={[
            { value: "list", label: "List", icon: <Icon icon={List} /> },
            { value: "grid", label: "Grid", icon: <Icon icon={LayoutGrid} /> },
          ]}
          value={view()}
          onChange={setView}
          aria-label="View mode"
        />
        <SegmentedControl
          options={[
            { value: "comfortable", icon: <Icon icon={Rows3} />, "aria-label": "Comfortable" },
            { value: "compact", icon: <Icon icon={List} />, "aria-label": "Compact" },
          ]}
          value={density()}
          onChange={setDensity}
          aria-label="Density"
        />
      </div>
    );
  },
};
