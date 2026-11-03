import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import LeftSidebar, { type Selection } from "./LeftSidebar";
import { noteDots } from "../../utils/sessionActivity";

const BASE = "/Users/me/Projects";
const WORK = `${BASE}/work`;
const CHATS = "/Users/me/.config/tori/chats";
const NOW_S = Math.floor(Date.now() / 1000);
const HOUR_S = 3_600;

const unit = (project: string, branch: string, current = false) => ({
  label: branch,
  folderPath: current ? project : `${project}/.tori/worktrees/${branch}`,
  branch,
  kind: "worktree",
  isCurrent: current,
});

const project = (root: string, name: string, branches: string[] = []) => {
  const path = `${root}/${name}`;
  return {
    name,
    path,
    branchUnits: [unit(path, "main", true), ...branches.map((b) => unit(path, b))],
    availability: "ok",
  };
};

const WORK_PROJECTS = [
  project(WORK, "api", [
    "auth-tokens",
    "rate-limits",
    "billing-v2",
    "fix-cors",
    "pagination",
    "audit-log",
    "webhooks",
    "search",
    "sso",
  ]),
  project(WORK, "web", ["checkout-redesign", "dark-mode", "onboarding"]),
  project(WORK, "mobile", ["push-relay", "offline-sync"]),
  project(WORK, "design-system", ["tokens-v3"]),
  project(WORK, "infra", ["terraform-1.9"]),
  project(WORK, "docs"),
  project(WORK, "analytics", ["funnels"]),
  project(WORK, "admin"),
  project(WORK, "worker", ["queue-retries"]),
  project(WORK, "notifications"),
  project(WORK, "payments", ["refunds", "disputes"]),
  project(WORK, "search-service"),
  project(WORK, "marketing-site"),
  project(WORK, "cli", ["completions"]),
];

const ATTACHED = [
  project("/Users/me/clients", "acme-site", ["launch-page", "seo"]),
  project("/Users/me/clients", "globex-portal", ["sso"]),
  project("/Volumes/Archive", "thesis"),
  project("/Users/me/Documents", "taxes-2026"),
  project("/Users/me/oss", "solid-router", ["fix-preload"]),
  project("/Users/me/oss", "vite-plugin-icons"),
  project("/Users/me/Downloads", "sample-data"),
  project("/Users/me/oss", "tauri", ["mocks-docs"]),
  project("/Users/me/side", "recipe-box"),
  project("/Users/me/side", "garden-planner"),
];

const member = (repoPath: string, order: number) => ({
  repoPath,
  displayName: repoPath.split("/").pop()!,
  worktreePath: null,
  state: { kind: "present" },
  order,
});

const topic = (name: string, repos: string[], space?: string) => {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { id, name, branch: `feat/${id}`, createdAt: 1, space, members: repos.map(member) };
};

const w = (name: string) => `${WORK}/${name}`;
const a = (i: number) => ATTACHED[i].path;

const TOPICS = [
  topic("Checkout v2", [w("api"), w("web"), w("payments")]),
  topic("Client SSO", [w("api"), a(1)]),
  topic("Launch week", [w("web"), w("marketing-site"), a(0)]),
  topic("Docs refresh", [w("docs"), a(4), a(5)]),
  topic("Offline mode", [w("mobile"), w("worker")]),
  topic("Billing audit", [w("payments"), w("analytics")]),
  topic("Design tokens", [w("design-system"), w("web"), w("mobile")]),
  topic("Thesis figures", [a(2), a(6)]),
  topic("Push relay", [w("mobile"), w("notifications"), w("infra")]),
  topic("Search rewrite", [w("search-service"), w("api"), w("web")]),
  topic("Garden app", [a(8), a(9)]),
  topic("Rate limits", [w("api"), w("worker")], "work"),
  topic("Webhooks", [w("api"), w("notifications")], "work"),
  topic("Admin roles", [w("admin"), w("api")], "work"),
  topic("Refunds", [w("payments"), w("admin")], "work"),
  topic("Funnels", [w("analytics"), w("web")], "work"),
  topic("CLI auth", [w("cli"), w("api")], "work"),
  topic("Queue retries", [w("worker"), w("infra")], "work"),
  topic("Dark mode", [w("web"), w("design-system")], "work"),
  topic("Status page", [w("infra"), w("marketing-site")], "work"),
];

const CHAT_TITLES = [
  "Plan the Lisbon trip",
  "Summarise the Q3 board deck",
  "Rewrite my cover letter",
  "Explain Rust lifetimes with examples",
  "Compare three standing desks",
  "Clean up the expenses CSV",
  "Draft the team offsite agenda",
  "Translate the lease into English",
  "Weekly meal plan, vegetarian",
  "Why is my sourdough flat",
  "Outline a talk on local-first apps",
  "Reply to the landlord about the boiler",
  "Pick a name for the side project",
  "Read through the insurance policy",
  "Birthday gift ideas for Dad",
  "Turn these notes into a blog post",
  "Learn the basics of music theory",
  "Budget for the kitchen renovation",
  "Summarise this research paper",
  "Write a haiku about deploy Fridays",
  "Fix my resume formatting",
  "Interview prep: system design",
  "Explain the new tax rules",
  "Shopping list for the camping trip",
  "Brainstorm podcast episode ideas",
];

// `last_active` in epoch seconds, the unit the host sends.
const WORK_CHAT_TITLES = [
  "Why does the api cold start take 4s",
  "Draft the incident write-up",
  "Compare queue libraries for the worker",
  "Summarise last sprint's PR comments",
  "Name the new billing service",
  "Explain the payments retry flow",
  "Review the terraform plan output",
  "Write release notes for 3.2",
];

// Home's chats live under `.home`, a space's under its name.
const chatSession = (dir: string, title: string, i: number, at: number) => ({
  id: `chat-${dir}-${i}`,
  path: `/transcripts/chat-${dir}-${i}.jsonl`,
  cwd: `${CHATS}/${dir}/c-${dir}-${i}`,
  branch: "",
  title,
  name: null,
  last_active: at,
  created_at: at,
  agent: "claude",
});

const CHAT_SESSIONS = [
  ...CHAT_TITLES.map((t, i) => chatSession(".home", t, i, NOW_S - i * 7 * HOUR_S)),
  ...WORK_CHAT_TITLES.map((t, i) => chatSession("work", t, i, NOW_S - i * 5 * HOUR_S)),
];

const CONFIG = {
  path: "/Users/me/.config/tori/tori.toml",
  roots: [BASE],
  spaces: [{ name: "work", path: WORK, projects: WORK_PROJECTS }],
  global: { projects: ATTACHED },
};

// The workshop has no Tauri host, so every command the sidebar sends is
// answered here. Anything not listed gets null, as the sidebar's tests do.
function stubHost() {
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      const q = (args ?? {}) as Record<string, unknown>;
      if (cmd === "get_config") return CONFIG;
      if (cmd === "list_topics") return TOPICS;
      if (cmd === "chats_root") return CHATS;
      if (cmd === "list_sessions") return q.folder === CHATS && q.inclusive ? CHAT_SESSIONS : [];
      if (cmd === "list_project_attempts" || cmd === "sessions_running") return [];
      if (cmd === "folder_historical") return false;
      return null;
    },
    { shouldMockEvents: true },
  );
}

// Two chats past the cap are working, so they stay in the list in their own
// place rather than folding away.
const BUSY = [8, 13];
const LIVE_TABS = BUSY.map((i) => ({
  id: `tab-${i}`,
  workspace: `chat:c-.home-${i}`,
  kind: "agent",
  sessionId: `chat-.home-${i}`,
  agent: "claude",
  state: "live",
}));

function Sidebar(props: { space: string }) {
  localStorage.setItem("tori.active-space.v1", props.space);
  stubHost();
  const [sel, setSel] = createSignal<Selection | null>(null);
  setTimeout(
    () => noteDots(BUSY.map((i) => ({ id: `chat-.home-${i}`, dot: "working", certainty: "inferred", home: null }))),
    800,
  );
  return (
    <div style={{ display: "flex", width: "300px", height: "900px" }}>
      <LeftSidebar selected={sel()} onSelect={setSel} liveTabs={LIVE_TABS as never} />
    </div>
  );
}

const meta = {
  title: "Sidebar/Kitchen sink",
  component: Sidebar,
  args: { space: "/global" },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Home with 25 chats, 11 Topics and 10 attached folders: every group past
 *  its cap, two busy chats kept past it. */
export const Home: Story = {};

/** A named space with 8 chats, 9 Topics and 14 projects, one of them with ten
 *  branches. */
export const Space: Story = { args: { space: "work" } };
