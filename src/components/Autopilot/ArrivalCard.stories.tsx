import type { Meta, StoryObj } from "storybook-solidjs-vite";
import ArrivalCard from "./ArrivalCard";

const ref = (n: number) => `#${n}`;

const meta = {
  title: "Autopilot/ArrivalCard",
  component: ArrivalCard,
  argTypes: {
    durationMs: { control: "number" },
  },
  args: {
    title: `Open PR for ${ref(123)}?`,
    meta: "tori/123-login-redirect, 4 files",
    durationMs: 6000,
  },
} satisfies Meta<typeof ArrivalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The countdown runs once; reload the story to watch it again. */
export const Default: Story = {};

/** A long title and branch truncate rather than widening the card. */
export const LongText: Story = {
  args: {
    title: `Merge PR ${ref(45)} Add retry to sync with a capped backoff?`,
    meta: "tori/45-add-retry-to-sync-with-capped-backoff, 11 files",
  },
};
