import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, onMount } from "solid-js";
import UsageCard from "./UsageCard";
import Button from "../Button/Button";
import { resetUsageStoreForTests, seedUsageStoreForTests } from "../../utils/usageStore";
import type { QuotaReading } from "../../utils/chatRateLimit";
import type { WindowReading } from "../../utils/usageStore";

// Anchored the way the strip anchors it, on a button standing in for a cluster.
// Read-only and pinned are two stories rather than one with a control, because
// the difference is what the card *is* rather than a property it has.

const HOUR = 60 * 60 * 1000;
const soon = (hours: number) => Math.floor((Date.now() + hours * HOUR) / 1000);

type Seed = QuotaReading & Partial<Pick<WindowReading, "sampledAt" | "source">>;

const win = (kind: string, utilization: number, resetsAt: number, over: Partial<Seed> = {}): Seed => ({
  kind,
  utilization,
  resetsAt,
  status: null,
  reachedType: null,
  ...over,
});

function anchored(pinned: boolean, windows: Seed[]) {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  onMount(() => {
    resetUsageStoreForTests();
    seedUsageStoreForTests("claude", null, windows);
  });
  return (
    <div style={{ padding: "80px", display: "flex", "justify-content": "center" }}>
      <Button ref={(el: HTMLButtonElement) => setAnchor(el)}>Claude 42%</Button>
      {anchor() ? (
        <UsageCard
          agentId="claude"
          profile="default"
          anchorEl={anchor()!}
          pinned={pinned}
          now={Date.now()}
          onClose={() => {}}
        />
      ) : null}
    </div>
  );
}

// `args` is required by the type even though every story builds its own anchor
// in `render`: the card is anchored to a real element, and there is no element
// to name before the story has mounted one.
const meta = {
  title: "Components/UsageCard",
  component: UsageCard,
  args: {
    agentId: "claude",
    profile: "default",
    anchorEl: undefined as unknown as HTMLElement,
    pinned: false,
    now: 0,
    onClose: () => {},
  },
} satisfies Meta<typeof UsageCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What a hover gets: every window, where each number came from and how old it
 *  is, and controls that are visible and refusing. */
export const ReadOnly: Story = {
  render: () => anchored(false, [win("five_hour", 0.42, soon(3)), win("seven_day", 0.11, soon(96))]),
};

/** What a click gets: the same card with the controls live. */
export const Pinned: Story = {
  render: () => anchored(true, [win("five_hour", 0.42, soon(3)), win("seven_day", 0.11, soon(96))]),
};

/** The pace line, which only appears when carrying on as you are runs the window
 *  out before its reset. Any projection landing after the reset says nothing the
 *  bar has not already said, so the line stays away. */
export const OnPaceToRunOut: Story = {
  render: () => anchored(true, [win("five_hour", 0.7, soon(1)), win("seven_day", 0.2, soon(120))]),
};
