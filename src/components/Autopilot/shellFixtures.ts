// Fake data for the shell stories, one set per state, from the #201 design.
// Refs are built with `ref()` because the token guard reads "#123" as a hex
// colour.
import type { AutopilotPopupProps } from "./AutopilotPopup";
import type { AutopilotViewProps } from "./AutopilotView";
import { heroFor } from "../../utils/autopilotRows";
import type { ActivityItem, AutopilotState, CockpitHero, Decision, ThreadMessage, WorkerCard } from "./autopilot";
import { ref } from "./ShellParts";

const me = (text: string): ThreadMessage => ({ from: "me", text });
const ap = (text: string): ThreadMessage => ({ from: "autopilot", text });
const sys = (text: string): ThreadMessage => ({ from: "system", text });
const act = (time: string, text: string, needsYou = false): ActivityItem => ({ time, text, needsYou });

const hero = (state: AutopilotState, calls: number, crew: number): CockpitHero => heroFor(state, calls, crew, crew ? 1 : 0, 4);

const LOGIN = "tori/123-login-redirect";
const AVATAR = "tori/131-avatar-cache";

const base = [
  me(`work on ${ref(123)} and ${ref(131)}, then ${ref(140)}`),
  ap(
    `Started two workers: ${ref(123)} in ${LOGIN} and ${ref(131)} in ${AVATAR}. ${ref(140)} is queued behind ${ref(123)} because both touch the launch path.`,
  ),
];

const baseActivity = [
  act("10:42", `Created worktree ${LOGIN}`),
  act("10:42", `Started worker on ${ref(123)}`),
  act("10:43", `Created worktree ${AVATAR}`),
  act("10:43", `Started worker on ${ref(131)}`),
];

const decisions: Decision[] = [
  {
    kind: "pr",
    refNumber: 123,
    title: "Fix login redirect loop",
    summary: `Open a draft PR from ${LOGIN} into main. 4 files, +73 -11, tests pass.`,
    age: "now",
  },
  {
    kind: "question",
    refNumber: 131,
    title: "Cache avatar fetch",
    worker: AVATAR,
    summary: "Should cached avatars expire after 1 hour, or live for the whole session?",
    suggestion: "1 hour, to match the profile cache.",
    age: "3m",
  },
];

const login = (w: Partial<WorkerCard>): WorkerCard => ({
  refNumber: 123,
  title: "Fix login redirect loop",
  branch: LOGIN,
  diff: "+73 -11",
  status: "working",
  log: [],
  doing: "",
  ...w,
});
const avatar = (w: Partial<WorkerCard>): WorkerCard => ({
  refNumber: 131,
  title: "Cache avatar fetch",
  branch: AVATAR,
  diff: "+12 -3",
  status: "running",
  log: [],
  doing: "",
  ...w,
});

const queue = [{ refNumber: 140, title: "Theme flicker on launch", after: 123 }];

const error = { title: "Autopilot session exited (signal 9)", detail: "Restarting, attempt 2 of 3. Both workers keep running and stay locked. Nothing was sent." };

export const VIEW: Record<AutopilotState, AutopilotViewProps> = {
  off: {
    state: "off",
    hero: hero("off", 0, 0),
    scene: "night",
    workers: [],
    emptyWorkers: "Nothing in flight. Workers from earlier are normal sessions now.",
    queue: [],
    messages: [],
    decisions: [],
    activity: [act("09:10", `Merged PR ${ref(45)} Add retry to sync`), act("11:20", "Stopped by you")],
    shield: "Nothing will leave this machine.",
  },
  idle: {
    state: "idle",
    hero: hero("idle", 0, 0),
    scene: "morning",
    workers: [],
    emptyWorkers: "Nothing in flight. Give the autopilot a ticket or a PR.",
    queue: [],
    messages: [
      me("review PR 45"),
      ap(`Posted the review you approved on ${ref(45)} Add retry to sync. Both comments are on the backoff code.`),
      sys(`Worker for ${ref(45)} finished, 1h ago`),
      ap("Nothing queued. Give me a ticket or a PR."),
    ],
    decisions: [],
    activity: [
      act("09:02", `Started worker on PR ${ref(45)}`),
      act("09:06", "Asked you to approve a review"),
      act("09:07", `Posted review on PR ${ref(45)}`),
      act("09:10", `Merged PR ${ref(45)} after your approval`),
    ],
    shield: "2 approved actions left this machine today.",
  },
  working: {
    state: "working",
    hero: hero("working", 0, 2),
    scene: "midday",
    workers: [
      login({
        log: ["> edit src/auth/session.ts", "> write tests/auth/redirect.test.ts", "$ pnpm test auth"],
        doing: "Running tests",
        progress: 0.72,
      }),
      avatar({ log: ["> read src/avatar/fetch.ts", "> read src/cache/lru.ts"], doing: "Reading code", progress: 0.3 }),
    ],
    emptyWorkers: "",
    queue,
    messages: [...base, ap("Both workers are running. I will ask before anything leaves this machine.")],
    decisions: [],
    activity: [...baseActivity, act("10:47", `${ref(123)} edited 3 files`)],
    shield: "Nothing has left this machine yet.",
  },
  needs: {
    state: "needs",
    hero: hero("needs", 2, 2),
    scene: "dusk",
    workers: [
      login({
        status: "idle",
        log: ["$ pnpm test auth", "  42 passed", "> waiting on your PR approval"],
        doing: "Needs your approval",
      }),
      avatar({ status: "needs", log: ["> read src/cache/lru.ts", "? expiry policy for cached avatars"], doing: "Asked you a question" }),
    ],
    emptyWorkers: "",
    queue,
    messages: [
      ...base,
      ap(
        `${ref(131)} wants to know how long cached avatars should live. ${ref(123)} is done and all 42 auth tests pass. Opening its PR sends it to GitHub, so I need your approval.`,
      ),
    ],
    decisions,
    focused: 0,
    activity: [
      ...baseActivity,
      act("10:51", `${ref(131)} asked about expiry`, true),
      act("10:58", `${ref(123)} tests passed, 42 of 42`),
      act("10:58", `Asked you to approve a PR for ${ref(123)}`, true),
    ],
    shield: "Nothing has left this machine yet.",
  },
  error: {
    state: "error",
    hero: hero("error", 0, 2),
    scene: "golden",
    workers: [
      login({ log: ["> edit src/auth/session.ts", "$ pnpm test auth"], doing: "Running tests", progress: 0.64 }),
      avatar({ log: ["$ pnpm install", "  resolving 412 packages..."], doing: "Installing dependencies", progress: 0.2 }),
    ],
    emptyWorkers: "",
    queue,
    messages: [...base, sys("Autopilot session exited, 40s ago")],
    decisions: [],
    activity: [...baseActivity, act("10:49", "Autopilot session exited", true), act("10:49", "Restarting, attempt 2 of 3")],
    shield: "Nothing has left this machine yet.",
    error,
  },
};

const popupBase = [
  me(`work on ${ref(123)} and ${ref(131)}`),
  ap(`Started two workers. ${ref(123)} runs in ${LOGIN}, ${ref(131)} in ${AVATAR}.`),
];

export const POPUP: Record<AutopilotState, AutopilotPopupProps> = {
  off: { state: "off", stateLine: "Off. Workers keep running as normal sessions.", decisions: [], inFlight: [], messages: [] },
  idle: {
    state: "idle",
    stateLine: "On, nothing queued",
    decisions: [],
    inFlight: [],
    messages: VIEW.idle.messages,
  },
  working: {
    state: "working",
    stateLine: "Working on 2",
    decisions: [],
    inFlight: [
      { refNumber: 123, branch: LOGIN, status: "working", doing: "Running pnpm test auth" },
      { refNumber: 131, branch: AVATAR, status: "running", doing: "Reading src/avatar/fetch.ts" },
    ],
    messages: [...popupBase, ap("Both workers are running. I will ask before anything leaves this machine.")],
  },
  needs: {
    state: "needs",
    stateLine: "Working on 2, 2 decisions",
    decisions,
    focused: 0,
    inFlight: [
      { refNumber: 123, branch: LOGIN, status: "idle", doing: "Waiting on your PR approval" },
      { refNumber: 131, branch: AVATAR, status: "needs", doing: "Asked you about cache expiry" },
    ],
    messages: [...popupBase, ap(`${ref(123)} is ready for a PR. The ${ref(131)} worker has a question about cache expiry.`)],
  },
  error: {
    state: "error",
    stateLine: "Session exited, restarting",
    decisions: [],
    inFlight: [
      { refNumber: 123, branch: LOGIN, status: "working", doing: "Editing src/auth/session.ts" },
      { refNumber: 131, branch: AVATAR, status: "running", doing: "Installing dependencies" },
    ],
    messages: [...popupBase, sys("Autopilot session exited, 40s ago")],
    error: { title: error.title, detail: "Restarting, attempt 2 of 3. Your two workers keep running and nothing was sent." },
  },
};
