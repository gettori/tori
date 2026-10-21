import type { Meta, StoryObj } from "storybook-solidjs-vite";
import Schedules from "./Schedules";
import type { ScheduleCard } from "./autopilot";

const ref = (n: number) => `#${n}`;

const bump: ScheduleCard = {
  id: "schedule-1",
  name: "Bump dependencies",
  cron: "0 7 * * 1-5",
  what: "Bump the dependencies and open a PR",
  next: "Thu 07:00",
  last: "done 1d ago",
  paused: false,
};

const meta = {
  title: "Autopilot/Schedules",
  component: Schedules,
  decorators: [(Story) => <div style={{ width: "320px", display: "grid", gap: "8px" }}>{Story()}</div>],
  args: { schedules: [bump] },
} satisfies Meta<typeof Schedules>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Normal: Story = {};

export const Paused: Story = {
  args: { schedules: [{ ...bump, paused: true, last: "failed 2h ago" }] },
};

export const Blocked: Story = {
  args: {
    schedules: [
      {
        ...bump,
        id: "schedule-2",
        name: `Triage ${ref(212)}`,
        what: "issue 212",
        waitingOn: { label: `Triage ${ref(212)}`, place: ["personal", "tori", "triage-212"] },
      },
    ],
  },
};

export const All: Story = {
  args: {
    schedules: [
      bump,
      { ...bump, id: "schedule-3", name: "Nightly flaky test sweep", cron: "0 2 * * *", paused: true },
      {
        ...bump,
        id: "schedule-4",
        name: `Triage ${ref(212)}`,
        what: "issue 212",
        waitingOn: { label: `Triage ${ref(212)}`, place: ["personal", "tori", "triage-212"] },
      },
    ],
  },
};
