import { onMount, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockIPC } from "@tauri-apps/api/mocks";
import { noteForgeUnits, type ForgeUnit } from "../../utils/sessionActivity";
import { trackFolders, type SessionMeta } from "../../utils/sessionStore";
import type { PlanItem } from "../../utils/chatTypes";
import type { Lane, ToolItem } from "./chatStore";
import type { ChatRequest } from "./PendingRequests";
import WorktreeCard from "./WorktreeCard";
import PendingRequests from "./PendingRequests";
import PlanCard from "./PlanCard";
import LaneStrip from "./LaneStrip";
import SessionChips, { type RelatedSession } from "./SessionChips";
import PromptFrom from "./PromptFrom";
import SentPrompt from "./SentPrompt";
import styles from "./Chat.module.css";

const API = "/w/api";
const WEB = "/w/web";

function session(id: string, cwd: string, name: string, branch: string): SessionMeta {
  return { id, path: `${cwd}/${id}.jsonl`, cwd, branch, title: name, last_active: 0, created_at: 0, name };
}

const SESSIONS: Record<string, SessionMeta[]> = {
  [`${API}/main`]: [session("parent-1", `${API}/main`, "Fix the login flow", "main")],
  [`${API}/fix-login`]: [session("child-1", `${API}/fix-login`, "Login: say hi", "fix-login")],
  [`${WEB}/main`]: [session("web-1", `${WEB}/main`, "Docs refresh", "main")],
};

const REQUESTS: Record<string, ChatRequest[]> = {
  "child-1": [
    { id: "r1", from: "web-1", text: "Can you rebase onto main before I review?", attach: [], at: 1 },
    {
      id: "r2",
      from: "parent-1",
      text: "Here are the failing logs from CI, the login test times out after the redirect.",
      attach: ["/tmp/ci.log", "/tmp/shot.png"],
      at: 2,
    },
  ],
};

function unit(over: Partial<ForgeUnit>): ForgeUnit {
  return {
    kind: "worktree",
    branch: "main",
    isCurrent: false,
    folderPath: `${API}/main`,
    projectPath: API,
    attention: false,
    ...over,
  };
}

// The workshop has no Tauri host: the session names, the waiting messages and
// the links are answered here, and the sidebar's unit list is fed by hand.
function stubHost() {
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, string>;
      if (cmd === "list_sessions") return SESSIONS[a.folder] ?? [];
      if (cmd === "folder_historical") return false;
      if (cmd === "chat_requests_list") return REQUESTS[a.session] ?? [];
      return true;
    },
    { shouldMockEvents: true },
  );
  noteForgeUnits([
    unit({}),
    unit({ branch: "fix-login", folderPath: `${API}/fix-login` }),
    unit({
      branch: "fix-merged",
      folderPath: `${API}/fix-merged`,
      prKnown: true,
      pullRequest: { number: 42, state: "merged", title: "Fix" },
    }),
    unit({
      branch: "fix-open",
      folderPath: `${API}/fix-open`,
      prKnown: true,
      pullRequest: { number: 51, state: "open", title: "Open" },
    }),
    unit({ branch: "main", folderPath: `${WEB}/main`, projectPath: WEB }),
    unit({ branch: "fix-a", folderPath: `${WEB}/fix-a`, projectPath: WEB }),
  ]);
  void trackFolders(Object.keys(SESSIONS));
}

function tool(over: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    id: "t",
    turnId: "t1",
    toolUseId: "toolu",
    agentId: null,
    name: "mcp__tori__worktree_new",
    title: null,
    toolKind: "other",
    locations: [],
    input: { branch: "fix-login" },
    output: JSON.stringify({ path: `${API}/fix-login`, setup: "none" }),
    outputTruncated: false,
    summary: null,
    patch: [],
    state: "ok",
    durationMs: 900,
    approval: null,
    edits: [],
    secret: null,
    blindEdits: [],
    files: [],
    ...over,
  };
}

const made = (path: string, extra: Record<string, unknown> = {}) => JSON.stringify({ path, setup: "none", ...extra });

const CARDS: [string, ToolItem][] = [
  ["Running", tool({ state: "running", output: null })],
  ["Done, same project", tool({})],
  [
    "Done, with a chat (session_spawn + new_worktree)",
    tool({
      name: "mcp__tori__session_spawn",
      input: { new_worktree: "fix-login", prompt: "hi" },
      output: JSON.stringify({ id: "child-1", folder: `${API}/fix-login` }),
    }),
  ],
  ["Another project", tool({ input: { branch: "fix-a", project: WEB }, output: made(`${WEB}/fix-a`) })],
  ["PR open", tool({ input: { branch: "fix-open" }, output: made(`${API}/fix-open`) })],
  ["PR merged", tool({ input: { branch: "fix-merged" }, output: made(`${API}/fix-merged`) })],
  ["Setup failed", tool({ input: { branch: "fix-login" }, output: made(`${API}/fix-login`, { setup: "failed" }) })],
  ["Removed", tool({ input: { branch: "gone" }, output: made(`${API}/gone`) })],
  [
    "ACP agent (codex)",
    tool({
      name: "execute",
      title: "mcp.tori.worktree_new",
      input: { server: "tori", tool: "worktree_new", arguments: { branch: "fix-login" } },
      output: JSON.stringify({ result: { content: [{ type: "text", text: made(`${API}/fix-login`) }] } }),
    }),
  ],
];

const plan = (...items: [string, PlanItem["status"]][]): PlanItem[] =>
  items.map(([text, status]) => ({ text, status }));
const PLAN = plan(["Read the store", "completed"], ["Gate session_steer", "inProgress"], ["Write the card", "pending"]);

function Section(props: { title: string; detail: string; children: JSX.Element }) {
  return (
    <section style={{ display: "flex", "flex-direction": "column", gap: "8px", "margin-bottom": "32px" }}>
      <h3 style={{ margin: 0, "font-size": "14px" }}>{props.title}</h3>
      <p style={{ margin: 0, color: "var(--fg-muted)", "font-size": "12px" }}>{props.detail}</p>
      {props.children}
    </section>
  );
}

function State(props: { label: string; children: JSX.Element }) {
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
      <span style={{ color: "var(--fg-subtle)", "font-size": "11px", "font-family": "var(--tori-font-mono)" }}>
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

const rel = (id: string, over: Partial<RelatedSession>): RelatedSession => ({
  id,
  name: id,
  side: "to",
  relation: "spawned",
  state: "idle",
  project: null,
  branch: null,
  lastAt: 0,
  ...over,
});

const PARENT_CHIP = rel("parent-1", {
  name: "Fix the login flow",
  side: "from",
  relation: "madeWorktree",
  project: "api",
  branch: "main",
});

const MANY: RelatedSession[] = [
  PARENT_CHIP,
  rel("web-1", {
    name: "Docs refresh",
    side: "from",
    relation: "prompted",
    state: "working",
    project: "web",
    branch: "main",
    lastAt: 5,
  }),
  rel("ops-1", {
    name: "Release checklist",
    side: "from",
    relation: "prompted",
    project: "ops",
    branch: "main",
    lastAt: 1,
  }),
  rel("c1", {
    name: "Login: say hi",
    relation: "madeWorktree",
    state: "needsYou",
    project: "api",
    branch: "fix-login",
    lastAt: 9,
  }),
  rel("c2", {
    name: "Login: tests",
    relation: "spawned",
    state: "working",
    project: "api",
    branch: "fix-login",
    lastAt: 8,
  }),
  rel("c3", { name: "Login: docs", relation: "spawned", state: "done", project: "api", branch: "fix-docs", lastAt: 4 }),
  rel("c4", { name: "Billing check", relation: "prompted", project: "billing", branch: "main", lastAt: 3 }),
  rel("l1", { name: "Design review", relation: "linked", project: "web", branch: "design", lastAt: 2 }),
];

function lane(agentId: string, description: string, status: string | null): Lane {
  return {
    agentId,
    taskType: "local_agent",
    toolUseId: null,
    agentType: "Explore",
    description,
    prompt: description,
    status,
    activity: null,
    lastToolName: null,
    usage: null,
    summary: null,
    parentId: null,
    startedAt: Date.now() - 95_000,
  };
}

function Strip(props: { sessions: RelatedSession[]; withLanes?: boolean; openList?: boolean }) {
  let row: HTMLDivElement | undefined;
  onMount(() => {
    if (props.openList) row?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  });
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
      {props.withLanes ? (
        <LaneStrip
          lanes={[lane("a1", "Find the login tests", null)]}
          selected={null}
          blocked={new Set()}
          onSelect={() => {}}
          tasks={[]}
          busy
          mark={null}
          active={false}
        />
      ) : null}
      <div ref={row} class={styles.lanes}>
        <SessionChips sessions={props.sessions} onOpen={() => {}} onUnlink={() => {}} />
      </div>
    </div>
  );
}

function Prompt(props: { text: string; from?: string; steer?: boolean }) {
  return (
    <div class={styles.userRow} classList={{ [styles.steerRow]: !!props.steer }}>
      <div class={styles.userBubble}>
        {props.from ? <PromptFrom name={props.from} onOpen={() => {}} /> : null}
        {props.steer ? <span class={styles.steerLabel}>Steer</span> : null}
        <SentPrompt blocks={[{ type: "text", text: props.text }]} cwd={`${API}/fix-login`} skills={[]} />
      </div>
    </div>
  );
}

function KitchenSink() {
  stubHost();
  const open = () => {};
  return (
    <div style={{ width: "760px", padding: "24px", background: "var(--canvas-default)" }}>
      <Section
        title="Session chips, above the input"
        detail="Their own group in the strip beside main, subagents and background tasks. From: sessions that reached this chat. To: sessions this chat reached. Two a side, live and waiting first, the rest behind +N."
      >
        <State label="Beside main and a subagent: a chat an agent started in a worktree it made">
          <Strip sessions={[PARENT_CHIP]} withLanes />
        </State>
        <State label="Parent: two chats it started">
          <Strip sessions={MANY.filter((m) => m.id === "c1" || m.id === "c2")} />
        </State>
        <State label="Busy chat: both sides, folded">
          <Strip sessions={MANY} />
        </State>
        <State label="+N list open">
          <div style={{ "min-height": "340px" }}>
            <Strip sessions={MANY} openList />
          </div>
        </State>
        <State label="On the phone (not clickable)">
          <div class={styles.lanes}>
            <SessionChips sessions={MANY.slice(0, 3)} />
          </div>
        </State>
      </Section>

      <Section
        title="Prompts from another session"
        detail="On the right like your own, marked with who sent it; the name opens that chat."
      >
        <Prompt text="Can you add a test for the redirect?" />
        <Prompt from="Fix the login flow" text="hi" />
        <Prompt from="Docs refresh" text="Can you rebase onto main before I review?" />
        <Prompt from="Docs refresh" text="Also bump the version while you are there." steer />
        <Prompt from="Design review" text="Linked: the header spacing is off on mobile, can you check?" />
      </Section>

      <Section
        title="Parent: the worktree card"
        detail="In the transcript of the chat that made the worktree, in place of the generic tool card."
      >
        {CARDS.map(([label, card]) => (
          <State label={label}>
            <WorktreeCard card={card} cwd={`${API}/main`} onOpenWorktree={open} />
          </State>
        ))}
        <State label="On the phone (no units, no Open)">
          <WorktreeCard card={tool({})} cwd={`${API}/main`} />
        </State>
      </Section>

      <Section
        title="Waiting messages"
        detail="A steer from a chat this one is not related to, or past the loop cap, above the composer."
      >
        <PendingRequests sessionId="child-1" />
      </Section>

      <Section title="Plan card" detail="Live while the agent's turn keeps it; dimmed with a reason when it does not.">
        <State label="Live">
          <PlanCard items={PLAN} />
        </State>
        <State label="Agent stopped here (no turn running)">
          <PlanCard items={PLAN} stale="stopped" />
        </State>
        <State label="Not updated this turn">
          <PlanCard items={PLAN} stale="notUpdated" />
        </State>
      </Section>
    </div>
  );
}

const meta = {
  title: "Design/Linked worktrees",
  component: KitchenSink,
} satisfies Meta<typeof KitchenSink>;

export default meta;

export const KitchenSinkStory: StoryObj<typeof meta> = { name: "Kitchen sink" };
