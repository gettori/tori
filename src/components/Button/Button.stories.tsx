import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For } from "solid-js";
import { Settings } from "lucide-solid";
import Icon from "../Icon/Icon";
import Button, { type ButtonVariant, type ButtonSize } from "./Button";

const VARIANTS: ButtonVariant[] = ["default", "primary", "success", "warn", "danger", "ghost"];
const SIZES: ButtonSize[] = ["md", "sm", "xs"];

const meta = {
  title: "Components/Button",
  component: Button,
  argTypes: {
    variant: { control: "select", options: VARIANTS },
    size: { control: "select", options: SIZES },
    disabled: { control: "boolean" },
  },
  args: { variant: "default", size: "md", children: "Button" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The single knob-driven instance: every prop is live in the controls panel. */
export const Playground: Story = {};

/** Every variant at one size, so a theme switch can be judged across the family
 *  in a single glance rather than one story at a time. */
export const Variants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--tori-space-4)", "flex-wrap": "wrap" }}>
      <For each={VARIANTS}>{(variant) => <Button variant={variant}>{variant}</Button>}</For>
    </div>
  ),
};

/** Every size in every variant. The grid is the fastest way to spot a size step
 *  that stopped folding --ui-scale, which reads as one row sitting wrong. */
export const Sizes: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--tori-space-4)" }}>
      <For each={SIZES}>
        {(size) => (
          <div style={{ display: "flex", gap: "var(--tori-space-4)", "align-items": "center" }}>
            <For each={VARIANTS}>
              {(variant) => (
                <Button variant={variant} size={size}>
                  {size}
                </Button>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  ),
};

/** Leading icon, trailing icon, and icon-only. The icon-only button carries an
 *  `aria-label`: without one Button warns in dev and axe flags it, which is the
 *  contract this story exists to hold. */
export const WithIcons: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--tori-space-4)", "align-items": "center" }}>
      <Button icon={<Icon icon={Settings} />}>Settings</Button>
      <Button iconRight={<Icon icon={Settings} />}>Settings</Button>
      <Button icon={<Icon icon={Settings} />} aria-label="Settings" />
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true, children: "Disabled" },
};
