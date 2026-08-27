import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For } from "solid-js";
import MemberChip from "./MemberChip";

const meta = {
  title: "Components/MemberChip",
  component: MemberChip,
  args: { member: { displayName: "frontend", repoPath: "/repos/frontend" } },
} satisfies Meta<typeof MemberChip>;

export default meta;
type Story = StoryObj<typeof meta>;

const MEMBERS = [
  { displayName: "frontend", repoPath: "/repos/frontend", tint: "oklch(0.72 0.13 250)" },
  { displayName: "backend", repoPath: "/repos/backend", tint: "oklch(0.74 0.15 145)" },
  { displayName: "notification service", repoPath: "/repos/notification-service", tint: "oklch(0.7 0.16 30)" },
  { displayName: "docs", repoPath: "/repos/docs", tint: undefined },
];

const Row = (props: { children: import("solid-js").JSX.Element }) => (
  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>{props.children}</div>
);

/** One chip per member, each on its own Space tint. The last has no Space, so it
 *  falls back to neutral rather than to a grey mix of itself. */
export const Tints: Story = {
  render: () => (
    <Row>
      <For each={MEMBERS}>{(m) => <MemberChip member={m} tint={m.tint} />}</For>
    </Row>
  ),
};

/** The two sizes: `sm` for a tree, search or changes section header, `md` for
 *  the sidebar's Feature rows, which sit on a taller line. */
export const Sizes: Story = {
  render: () => (
    <Row>
      <MemberChip member={MEMBERS[0]} tint={MEMBERS[0].tint} size="sm" />
      <MemberChip member={MEMBERS[0]} tint={MEMBERS[0].tint} size="md" />
    </Row>
  ),
};

/** A chip carrying an announced state badge. The chip stays undecorated here on
 *  purpose: `aria-hidden` would cover the badge, which is the only spoken
 *  account of a member whose worktree is gone. */
export const WithStateBadge: Story = {
  render: () => (
    <Row>
      <MemberChip member={MEMBERS[1]} tint={MEMBERS[1].tint} size="md">
        <span
          role="img"
          aria-label="Worktree missing"
          style={{
            position: "absolute",
            top: "-2px",
            right: "-2px",
            width: "7px",
            height: "7px",
            "border-radius": "50%",
            background: "var(--fg-muted)",
          }}
        />
      </MemberChip>
    </Row>
  ),
};

/** Decorative: hidden from assistive tech, for a surface whose adjacent text
 *  already names the repo (a tab's hidden name, a section header's own label). */
export const Decorative: Story = {
  render: () => (
    <Row>
      <MemberChip member={MEMBERS[2]} tint={MEMBERS[2].tint} decorative />
      <span>notification service</span>
    </Row>
  ),
};
