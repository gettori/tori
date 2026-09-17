import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockIPC } from "@tauri-apps/api/mocks";
import TodoPanel from "./TodoPanel";
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

/** What each member's grep answers with. Deliberately overlapping filenames:
 *  a hit's path is relative to the repo it was found in, so two members with a
 *  `src/index.ts` are two files on screen. */
const HITS: Record<string, ReturnType<typeof hit>[]> = {
  [API]: [
    hit("src/index.ts", 14, "// TODO retry the webhook before giving up", [3, 7]),
    hit("src/routes/notifications.rs", 88, "    // FIXME this borrows state twice", [7, 12]),
    hit("src/routes/notifications.rs", 140, "// HACK the adapter wants a trailing slash", [3, 7]),
  ],
  [WEB]: [
    hit("src/index.ts", 3, "// TODO drop the polyfill once Safari 18 is the floor", [3, 7]),
    hit("src/components/Notification.tsx", 51, "  // XXX this re-renders on every keystroke", [5, 8]),
  ],
};

/** The workshop runs in a plain browser, so the grep has to be answered here or
 *  every section paints empty. One member is capped and one fails, which is the
 *  whole point of reporting both per member rather than once for the Topic. */
function stubHost() {
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd !== "grep_project") return null;
    const root = a.root as string;
    if (root === DOCS) throw new Error("grep: /feat/docs: Permission denied");
    return { matches: HITS[root] ?? [], truncated: root === API };
  });
}

// The tints come from the same helper the sidebar's chips use, so a chip here is
// the chip a member's Space would actually paint.
const MEMBERS: MemberRoot[] = [
  {
    path: API,
    repoPath: "/repos/api",
    label: "Payments API",
    tint: spaceHue("backend", "Indigo"),
    state: memberState({ kind: "present" }),
  },
  {
    path: WEB,
    repoPath: "/repos/web",
    label: "Web App",
    tint: spaceHue("frontend", "Emerald"),
    state: memberState({ kind: "present" }),
  },
  {
    path: DOCS,
    repoPath: "/repos/docs",
    label: "Docs Site",
    tint: spaceHue("docs", "Amber"),
    state: memberState({ kind: "present" }),
  },
];

const meta = {
  title: "Editor/TodoPanel",
  component: TodoPanel,
  args: { root: API, selected: null },
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
} satisfies Meta<typeof TodoPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One repo, no headers: a branch unit's TODO list is what it always was, and
 *  the cap notice is the panel's own summary line. */
export const BranchUnit: Story = {};

/** Three members at once, each grepped separately and reported separately. The
 *  API member hit the cap and says so in its own section; the Docs member's
 *  grep failed and says that in its own section, without blanking the two that
 *  answered. The summary above counts the whole Topic and claims no cap,
 *  because a cap belongs to the repo that hit it. */
export const TopicMembers: Story = {
  args: { roots: MEMBERS },
};

/** A member whose worktree is gone is never grepped, and keeps its header. The
 *  badge is the only place that says why there is nothing under it. */
export const BrokenMember: Story = {
  args: {
    roots: [
      MEMBERS[0],
      {
        ...MEMBERS[1],
        path: "/repos/web",
        state: memberState({ kind: "worktree-missing" }),
      },
    ],
  },
};
