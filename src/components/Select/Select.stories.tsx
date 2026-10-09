import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import type { ControlSize } from "../controls";
import Select, { type SelectGroup, type SelectOption } from "./Select";

const SIZES: ControlSize[] = ["md", "sm", "xs"];

const DENSITY: SelectOption[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const METHODS: SelectOption[] = [
  { value: "merge", label: "Create a merge commit" },
  { value: "squash", label: "Squash and merge" },
  { value: "rebase", label: "Rebase and merge", disabled: true },
];

const THEMES: SelectGroup[] = [
  {
    label: "Bundled",
    options: [
      { value: "dark-plus", label: "Dark+" },
      { value: "light-plus", label: "Light+" },
    ],
  },
  {
    label: "From ~/.config/tori/packs/themes",
    options: [
      { value: "nord", label: "Nord" },
      { value: "gruvbox", label: "Gruvbox" },
    ],
  },
];

const meta = {
  title: "Components/Select",
  component: Select,
  argTypes: {
    size: { control: "inline-radio", options: SIZES },
    disabled: { control: "boolean" },
  },
  args: {
    size: "md",
    disabled: false,
    options: DENSITY,
    value: "comfortable",
    onChange: () => {},
    "aria-label": "Transcript density",
  },
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default control: one value out of a short flat list, the shape the
 *  settings rows use. The trigger reads as a field you set rather than an
 *  action you take, and the listbox is the same surface family as a menu. */
export const Default: Story = {
  render: (args) => {
    const [value, setValue] = createSignal("comfortable");
    return (
      <Select
        options={DENSITY}
        value={value()}
        onChange={setValue}
        size={args.size}
        disabled={args.disabled}
        aria-label="Transcript density"
      />
    );
  },
};

/** The three sizes, each a fixed outer height off the `--control-height*`
 *  tokens, so a select lines up with the Button and IconButton beside it. */
export const Sizes: Story = {
  render: () => {
    const [value, setValue] = createSignal("comfortable");
    return (
      <div style={{ display: "flex", "align-items": "center", gap: "var(--tori-space-4)" }}>
        {SIZES.map((size) => (
          <Select
            options={DENSITY}
            value={value()}
            onChange={setValue}
            size={size}
            aria-label={`Transcript density (${size})`}
          />
        ))}
      </div>
    );
  },
};

/** A whole control that cannot be used (MergeBar disables its picker while a
 *  merge is in flight), and a single row that cannot be picked. Both are muted
 *  through role tokens rather than opacity, so they stay theme-correct. */
export const Disabled: Story = {
  render: () => {
    const [value, setValue] = createSignal("squash");
    return (
      <div style={{ display: "flex", "align-items": "center", gap: "var(--tori-space-4)" }}>
        <Select options={METHODS} value={value()} onChange={setValue} disabled aria-label="How to merge (disabled)" />
        <Select options={METHODS} value={value()} onChange={setValue} aria-label="How to merge" />
      </div>
    );
  },
};

/** Grouped rows, AppearancePane's shape: a heading names where each theme came
 *  from, so a user theme is visibly not one of Tori's. Headings are not
 *  focusable and the arrows step straight past them. */
export const Groups: Story = {
  render: () => {
    const [value, setValue] = createSignal("dark-plus");
    return <Select options={THEMES} value={value()} onChange={setValue} aria-label="Theme" />;
  },
};
