import type { Meta, StoryObj } from "storybook-solidjs-vite";
import DecisionCard from "./DecisionCard";
import { ticket } from "./shellFixtures";

const meta = {
  title: "Autopilot/DecisionCard",
  component: DecisionCard,
  argTypes: {
    kind: { control: "select", options: ["pr", "review", "merge", "question"] },
    refKind: { control: "inline-radio", options: ["issue", "pr"] },
    focused: { control: "boolean" },
  },
  args: {
    kind: "pr",
    ticket: ticket(123, "tori/123-login-redirect"),
    title: "Fix login redirect loop",
    summary: "Open a draft PR from tori/123-login-redirect into main. 4 files, +73 -11, tests pass.",
    age: "1m",
    focused: false,
  },
  decorators: [
    (Story) => (
      <div style={{ width: "calc(436px * var(--ui-scale))" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DecisionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PullRequest: Story = {};

export const Review: Story = {
  args: {
    kind: "review",
    ticket: ticket(45),
    refKind: "pr",
    title: "Add retry to sync",
    summary: "Post a review with 2 comments: a missing backoff cap and an unhandled 409.",
    age: "4m",
  },
};

export const Merge: Story = {
  args: {
    kind: "merge",
    ticket: ticket(45),
    refKind: "pr",
    title: "Add retry to sync",
    summary: "Squash and merge into main. All checks pass, 1 approval.",
    age: "12m",
  },
};

export const QuestionFromWorker: Story = {
  args: {
    kind: "question",
    ticket: ticket(131, "tori/131-avatar-cache"),
    title: "Cache avatar fetch",
    worker: "tori/131-avatar-cache",
    summary: "Should the cache survive a sign out, or be cleared with the rest of the account data?",
    suggestion: "Clear it on sign out, it holds URLs tied to the account.",
    age: "now",
  },
};

/** Selected by J/K: the brand frame, and the A and R hints inside their buttons. */
export const Focused: Story = {
  args: { focused: true },
};

/** A long title and summary truncate on one line each rather than growing the card. */
export const LongText: Story = {
  args: {
    title: "Fix login redirect loop when the session cookie expires during an OAuth round trip",
    summary:
      "Open a draft PR from tori/123-login-redirect-on-expired-session into main. 14 files, +473 -211, tests pass.",
  },
};
