import { onMount } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockIPC } from "@tauri-apps/api/mocks";
import SearchPanel from "./SearchPanel";
import { memberState } from "../../utils/topics";
import { spaceHue } from "../../utils/spaceTint";
import type { MemberRoot } from "../../utils/topicMembers";

const API = "/feat/api";
const WEB = "/feat/web";
const DOCS = "/feat/docs";

const hit = (path: string, line: number, text: string, at: [number, number]) => ({
  path,
  line,
  text,
  submatches: [at],
});

/** What each member answers with. The docs member is deliberately absent here:
 *  it is the one that fails, so the stub throws for it instead. */
const HITS: Record<string, ReturnType<typeof hit>[]> = {
  [API]: [
    hit("src/routes/notifications.rs", 42, "pub async fn notification_list(", [13, 25]),
    hit("src/services/notification.rs", 8, "use crate::notification::Notification;", [10, 22]),
    hit("src/services/notification.rs", 91, "    notification.send().await?;", [4, 16]),
  ],
  [WEB]: [
    hit("src/components/Notification.tsx", 12, "export function Notification(props: Props) {", [16, 28]),
    hit("src/hooks/useNotifications.ts", 3, "export function useNotifications() {", [19, 31]),
  ],
};

/** The workshop runs in a plain browser, so every command the panel sends has to
 *  be answered here or it paints empty. One member is capped, one fails, and one
 *  answers normally, which is the whole point of per-section notices. */
function stubHost() {
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd !== "grep_project") return null;
    const root = a.root as string;
    if (root === DOCS) throw new Error("grep: /feat/docs: Permission denied");
    return {
      matches: a.query ? (HITS[root] ?? []) : [],
      truncated: root === API && !!a.query,
      backend: root === WEB ? "git" : "rg",
      unsupported: root === WEB ? ["noIgnore"] : [],
      files: (HITS[root] ?? []).map((m) => ({ path: m.path, digest: "d1" })),
    };
  });
}

// The tints come from the same helper the sidebar's chips use, so a swatch here
// is the swatch a member's Space would actually paint.
const MEMBERS: MemberRoot[] = [
  { path: API, repoPath: "/repos/api", label: "Payments API", tint: spaceHue("backend", "Indigo") },
  { path: WEB, repoPath: "/repos/web", label: "Web App", tint: spaceHue("frontend", "Emerald") },
  { path: DOCS, repoPath: "/repos/docs", label: "Docs Site", tint: spaceHue("docs", "Amber") },
];

const meta = {
  title: "Editor/SearchPanel",
  component: SearchPanel,
  args: {
    root: API,
    focusNonce: 0,
    workspace: "topic:notifications",
  },
  decorators: [
    (Story) => {
      stubHost();
      return (
        <div style={{ display: "flex", width: "360px", height: "520px" }}>
          <Story />
        </div>
      );
    },
  ],
} satisfies Meta<typeof SearchPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three members at once: one capped at the cap, one that could not be read, one
 *  ordinary. Type in the box to see them fill; each section reports its own
 *  truncation and its own failure, and `noIgnore` is disabled because one
 *  member's backend cannot honour it.
 *
 *  The chip row above the box is unrestricted here, which is the default: All
 *  is pressed and every member is searched. */
export const TopicMembers: Story = {
  args: { roots: MEMBERS },
};

/** The same panel narrowed to one member. The excluded members lose their
 *  sections entirely rather than sitting there empty, because a bare header
 *  over no hits reads as "searched, nothing here".
 *
 *  Clicked rather than passed in: the restriction is a live control with no
 *  prop behind it, and inventing one only the workshop would use would be a
 *  second way to set it that the panel has to keep in step. */
export const RestrictedToOneMember: Story = {
  args: { roots: MEMBERS },
  render: (args) => {
    let host: HTMLDivElement | undefined;
    onMount(() =>
      requestAnimationFrame(() =>
        (host?.querySelector('[aria-label="Web App"]') as HTMLButtonElement | null)?.click(),
      ),
    );
    return (
      <div ref={host} style={{ display: "flex", flex: 1, "min-width": 0 }}>
        <SearchPanel {...args} />
      </div>
    );
  },
};

/** Every member usable and answering, which is the ordinary case. */
export const AllPresent: Story = {
  args: { roots: MEMBERS.slice(0, 2) },
};

/** A member with no worktree keeps its header and says it was not searched,
 *  rather than looking like a repo with no hits. */
export const MemberMissing: Story = {
  args: {
    roots: [
      MEMBERS[0],
      MEMBERS[1],
      { ...MEMBERS[2], state: memberState({ kind: "worktree-missing" }) },
    ],
  },
};

/** One root renders headerless, exactly as a branch unit always has: no chip,
 *  no section, the results straight under the toggles. */
export const SingleRoot: Story = {
  args: { root: API, workspace: API },
};
