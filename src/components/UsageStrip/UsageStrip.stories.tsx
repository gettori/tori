import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { onMount } from "solid-js";
import UsageStrip from "./UsageStrip";
import { resetUsageStoreForTests, seedUsageStoreForTests } from "../../utils/usageStore";
import type { QuotaReading } from "../../utils/chatRateLimit";
import type { WindowReading } from "../../utils/usageStore";

// The store is module-level and fed by live chat events, so a story seeds it the
// same way the tests do rather than taking readings as props. That keeps the
// component's real input (the account store) as the thing on screen: a
// prop-driven copy would render a shape the app never produces.

const HOUR = 60 * 60 * 1000;
const soon = (hours: number) => Math.floor((Date.now() + hours * HOUR) / 1000);

type Seed = QuotaReading & Partial<Pick<WindowReading, "sampledAt" | "source">>;

const win = (kind: string, utilization: number | null, resetsAt: number | null, over: Partial<Seed> = {}): Seed => ({
  kind,
  utilization,
  resetsAt,
  status: null,
  reachedType: null,
  ...over,
});

/** One account's readings, replacing whatever the last story left. */
function seed(rows: { agentId: string; profile: string | null; windows: Seed[] }[]) {
  resetUsageStoreForTests();
  for (const r of rows) seedUsageStoreForTests(r.agentId, r.profile, r.windows);
}

const meta = {
  title: "Components/UsageStrip",
  component: UsageStrip,
  parameters: { layout: "centered" },
} satisfies Meta<typeof UsageStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The account you are signed into: every generic window, with its own bar. */
export const FullRow: Story = {
  render: () => {
    onMount(() =>
      seed([
        {
          agentId: "claude",
          profile: null,
          windows: [win("five_hour", 0.42, soon(3)), win("seven_day", 0.11, soon(96))],
        },
      ]),
    );
    return <UsageStrip />;
  },
};

/** A second login on the same agent is compact: its own name and the one window
 *  it is nearest to. The default row keeps both, which is the contrast. */
export const CompactRow: Story = {
  render: () => {
    onMount(() =>
      seed([
        {
          agentId: "claude",
          profile: null,
          windows: [win("five_hour", 0.12, soon(4)), win("seven_day", 0.2, soon(120))],
        },
        {
          agentId: "claude",
          profile: "work",
          windows: [win("five_hour", 0.3, soon(2)), win("seven_day", 0.91, soon(48))],
        },
      ]),
    );
    return <UsageStrip />;
  },
};

/** The three tones side by side: ok stays quiet, approaching takes the attention
 *  role, reached takes danger. Never the blocking tier, which means "this
 *  stopped the turn" and belongs to the permission prompt and the question
 *  card. */
export const EveryState: Story = {
  render: () => {
    onMount(() =>
      seed([
        { agentId: "claude", profile: null, windows: [win("five_hour", 0.85, soon(1)), win("seven_day", 1, soon(72))] },
        { agentId: "codex", profile: null, windows: [win("five_hour", 0.2, soon(4))] },
      ]),
    );
    return <UsageStrip />;
  },
};

/** Old and wrong are drawn differently on purpose. A stale reading keeps its
 *  number and goes dim; one past its reset loses both the number and the colour,
 *  because drawing 98% on a quota that has since emptied is a lie. */
export const StaleAndReset: Story = {
  render: () => {
    onMount(() =>
      seed([
        {
          agentId: "claude",
          profile: null,
          windows: [
            win("five_hour", 0.42, soon(2), { sampledAt: Date.now() - 40 * 60 * 1000 }),
            win("seven_day", 0.98, Math.floor((Date.now() - HOUR) / 1000)),
          ],
        },
      ]),
    );
    return <UsageStrip />;
  },
};
