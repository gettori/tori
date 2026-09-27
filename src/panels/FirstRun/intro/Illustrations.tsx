import { For, Match, Show, Switch, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ArrowUp, ChevronLeft, ChevronRight, Folder, Tag } from "lucide-solid";
import AutopilotSwitch from "../../../components/Autopilot/AutopilotSwitch";
import AutopilotView from "../../../components/Autopilot/AutopilotView";
import { pickScene } from "../../../components/Autopilot/Horizon";
import type { Decision, QueuedItem, ThreadMessage, TicketRef, WorkerCard } from "../../../components/Autopilot/autopilot";
import Icon from "../../../components/Icon/Icon";
import MemberChip from "../../../components/MemberChip/MemberChip";
import AgentGlyph from "../../../components/Icon/AgentGlyph";
import { GitHubLogo, GitLabLogo, WorktreeMark } from "../../../components/Icon/gitMarks";
import { CheckMark, QuestionMark, WorkingMark, type StatusMarkProps } from "../../../components/Icon/statusMarks";
import ProjectIcon from "../../../components/Icon/ProjectIcon";
import MessageList from "../../Chat/MessageList";
import type { ChatItem } from "../../Chat/chatStore";
import BottomBar from "../../../../mobile/src/BottomBar";
import Pending, { type PendingRow } from "../../../../mobile/src/Pending";
import Root, { DOT, PhaseMark } from "../../../../mobile/src/Root";
import type { RemoteClient } from "../../../../mobile/src/remote";
import { PHASE_LABEL, type SessionRow, type Space, type Unit } from "../../../../mobile/src/tree";
import mobile from "../../../../mobile/src/mobile.module.css";
import shell from "../../../../mobile/src/shell.module.css";
import { heroFor } from "../../../utils/autopilotRows";
import { resolveColor } from "../../../utils/spaceTint";
import styles from "./Intro.module.css";

type State = "working" | "needsYou" | "done";

const STATE: Record<State, { mark: Component<StatusMarkProps>; label: string; class: string }> = {
  working: { mark: WorkingMark, label: "Working", class: styles.working },
  needsYou: { mark: QuestionMark, label: "Needs you", class: styles.needsYou },
  done: { mark: CheckMark, label: "Done", class: styles.done },
};

function StateGlyph(props: { state: State; count?: number }) {
  return (
    <span class={`${styles.state} ${STATE[props.state].class}`}>
      <Dynamic component={STATE[props.state].mark} size={14} />
      <Show when={(props.count ?? 0) > 1}>{props.count}</Show>
    </span>
  );
}

type Branch = { label: string; state: State; selected?: boolean };
type Project = { name: string; path: string } & (
  | { branches: Branch[] }
  | { rollup: { state: State; count: number } }
);

export function SessionsIllustration() {
  const projects: Project[] = [
    {
      name: "api",
      path: "~/Projects/work/api",
      branches: [
        { label: "fix/rate-limit", state: "working", selected: true },
        { label: "feat/webhooks", state: "needsYou" },
      ],
    },
    { name: "web", path: "~/Projects/work/web", rollup: { state: "done", count: 2 } },
    {
      name: "blog",
      path: "~/Projects/personal/blog",
      branches: [
        { label: "dark-mode", state: "working" },
        { label: "post/launch", state: "done" },
      ],
    },
  ];
  // Each project's first row in the flattened column, so the stagger runs top
  // to bottom across projects rather than restarting inside each one.
  let row = 0;
  const firstRow = projects.map((p) => {
    const at = row;
    row += 1 + ("branches" in p ? p.branches.length : 0);
    return at;
  });
  const legend: { state: State; count: number }[] = [
    { state: "working", count: 2 },
    { state: "needsYou", count: 1 },
    { state: "done", count: 3 },
  ];
  return (
    <div class={styles.split}>
      <div class={`${styles.card} ${styles.tree}`}>
        <div class={styles.spaceHead}>
          <span class={styles.spaceName}>work</span>
          <span class={styles.spaceKind}>{"\u00b7 Spaces"}</span>
        </div>
        <For each={projects}>
          {(p, k) => (
            <div class={styles.project}>
              <div class={`${styles.treeRow} ${styles.projectRow} ${styles.rise}`} style={{ "--i": firstRow[k()] }}>
                <span class={styles.rowIcon}>
                  <ProjectIcon seed={p.path} />
                </span>
                <span class={styles.treeLabel}>{p.name}</span>
                <Show when={"rollup" in p && p.rollup}>{(r) => <StateGlyph state={r().state} count={r().count} />}</Show>
              </div>
              <For each={"branches" in p ? p.branches : []}>
                {(b, j) => (
                  <div class={`${styles.branchNode} ${styles.rise}`} style={{ "--i": firstRow[k()] + j() + 1 }}>
                    <div class={`${styles.treeRow} ${styles.branchRow}`} classList={{ [styles.selected]: b.selected }}>
                      <span class={styles.rowIcon}>
                        <WorktreeMark />
                      </span>
                      <span class={styles.treeLabel}>{b.label}</span>
                      <StateGlyph state={b.state} />
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class={styles.legend}>
        <For each={legend}>
          {(l, i) => (
            <div class={`${styles.card} ${styles.legendRow} ${styles.rise}`} style={{ "--i": 1 + i() * 2 }}>
              <StateGlyph state={l.state} />
              <span>{STATE[l.state].label}</span>
              <span class={styles.count}>{l.count}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

type Level = "folder" | "project" | "worktree";

// Seeded like slide 1's rows, so a project keeps the same glyph on both.
function LevelGlyph(props: { level: Level; path: string }) {
  return (
    <span class={styles.levelGlyph}>
      <Switch fallback={<Icon icon={Folder} />}>
        <Match when={props.level === "project"}>
          <ProjectIcon seed={props.path} />
        </Match>
        <Match when={props.level === "worktree"}>
          <WorktreeMark />
        </Match>
      </Switch>
    </span>
  );
}

export function LayoutIllustration() {
  const levels: { label: string; level: Level }[] = [
    { label: "Base folder", level: "folder" },
    { label: "Space", level: "folder" },
    { label: "Project", level: "project" },
    { label: "Branch or worktree", level: "worktree" },
  ];
  const tree: { label: string; path: string; depth: number; level: Level }[] = [
    { label: "~/Projects", path: "~/Projects", depth: 0, level: "folder" },
    { label: "work", path: "~/Projects/work", depth: 1, level: "folder" },
    { label: "api", path: "~/Projects/work/api", depth: 2, level: "project" },
    { label: "main", path: "~/Projects/work/api/main", depth: 3, level: "worktree" },
    { label: "feat/webhooks", path: "~/Projects/work/api/feat/webhooks", depth: 3, level: "worktree" },
    { label: "web", path: "~/Projects/work/web", depth: 2, level: "project" },
    { label: "feat/webhooks", path: "~/Projects/work/web/feat/webhooks", depth: 3, level: "worktree" },
    { label: "personal", path: "~/Projects/personal", depth: 1, level: "folder" },
    { label: "blog", path: "~/Projects/personal/blog", depth: 2, level: "project" },
    { label: "main", path: "~/Projects/personal/blog/main", depth: 3, level: "worktree" },
  ];
  return (
    <div class={styles.split}>
      <div class={styles.levels}>
        <For each={levels}>
          {(l, i) => (
            <div
              class={`${styles.level} ${styles.slide}`}
              classList={{ [styles.levelLast]: i() === levels.length - 1 }}
              style={{ "--depth": i(), "--i": i() * 2 }}
            >
              <LevelGlyph level={l.level} path="~/Projects/work/api" />
              {l.label}
            </div>
          )}
        </For>
      </div>
      <div class={`${styles.card} ${styles.pathTree}`}>
        <For each={tree}>
          {(n, i) => (
            <div class={`${styles.pathRow} ${styles.rise}`} data-level={n.level} style={{ "--depth": n.depth, "--i": i() }}>
              <LevelGlyph level={n.level} path={n.path} />
              {n.label}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

type TopicRow = { name: string; members: { path: string; color: string }[]; active?: boolean };

export function TopicsIllustration() {
  const topics: TopicRow[] = [
    {
      name: "Webhooks",
      members: [
        { path: "~/Projects/work/api", color: "Sky" },
        { path: "~/Projects/work/web", color: "Sky" },
      ],
      active: true,
    },
    {
      name: "Dark mode",
      members: [
        { path: "~/Projects/work/web", color: "Sky" },
        { path: "~/Projects/personal/blog", color: "Emerald" },
      ],
    },
  ];
  const tree: { label: string; path: string; depth: number; level: Level; tagged?: boolean }[] = [
    { label: "api", path: "~/Projects/work/api", depth: 0, level: "project" },
    { label: "main", path: "~/Projects/work/api/main", depth: 1, level: "worktree" },
    { label: "fix/rate-limit", path: "~/Projects/work/api/fix/rate-limit", depth: 1, level: "worktree" },
    { label: "webhooks", path: "~/Projects/work/api/.tori/worktrees/webhooks", depth: 1, level: "worktree", tagged: true },
    { label: "web", path: "~/Projects/work/web", depth: 0, level: "project" },
    { label: "main", path: "~/Projects/work/web/main", depth: 1, level: "worktree" },
    { label: "feat/search", path: "~/Projects/work/web/feat/search", depth: 1, level: "worktree" },
    { label: "webhooks", path: "~/Projects/work/web/.tori/worktrees/webhooks", depth: 1, level: "worktree", tagged: true },
    { label: "dark-mode", path: "~/Projects/work/web/.tori/worktrees/dark-mode", depth: 1, level: "worktree", tagged: true },
    { label: "blog", path: "~/Projects/personal/blog", depth: 0, level: "project" },
    { label: "main", path: "~/Projects/personal/blog/main", depth: 1, level: "worktree" },
    { label: "post/launch", path: "~/Projects/personal/blog/post/launch", depth: 1, level: "worktree" },
    { label: "dark-mode", path: "~/Projects/personal/blog/.tori/worktrees/dark-mode", depth: 1, level: "worktree", tagged: true },
  ];
  return (
    <div class={styles.split}>
      <div class={`${styles.card} ${styles.topicList}`}>
        <div class={styles.spaceHead}>
          <span class={styles.spaceName}>Topics</span>
        </div>
        <For each={topics}>
          {(t, k) => (
            <div class={`${styles.topicItem} ${styles.rise}`} classList={{ [styles.topicActive]: t.active }} style={{ "--i": k() * 2 }}>
              <div class={styles.topicHead}>
                <span class={styles.topicCaret}>
                  <Icon icon={ChevronRight} />
                </span>
                <span class={styles.topicName}>{t.name}</span>
              </div>
              <div class={styles.topicChips}>
                <For each={t.members}>
                  {(m, j) => (
                    <span class={styles.pop} style={{ "--j": j() }}>
                      <MemberChip icon={{ seed: m.path }} tint={resolveColor(m.color)} size="md" decorative />
                    </span>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
      <div class={`${styles.card} ${styles.pathTree}`}>
        <For each={tree}>
          {(n, i) => (
            <div class={`${styles.pathRow} ${styles.rise}`} data-level={n.level} style={{ "--depth": n.depth, "--i": i() }}>
              <LevelGlyph level={n.level} path={n.path} />
              {n.label}
              <Show when={n.tagged}>
                <span class={`${styles.topicChip} ${styles.pop}`}>
                  <Icon icon={Tag} />
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export function TerminalIllustration() {
  return (
    <div class={`${styles.card} ${styles.wide}`}>
      <div class={styles.tabs}>
        <span class={`${styles.tab} ${styles.tabOn} ${styles.rise}`}>
          <StateGlyph state="working" />
          api / fix/rate-limit
        </span>
        <span class={`${styles.tab} ${styles.rise}`} style={{ "--i": 1 }}>
          <StateGlyph state="needsYou" />
          web / feat/webhooks
        </span>
      </div>
      <div class={styles.transcript}>
        <div class={`${styles.turn} ${styles.rise}`} style={{ "--i": 2 }}>
          <span class={styles.turnMark}>#12</span>
          <span>cap the limiter at 100 requests a minute per key</span>
        </div>
        <div class={`${styles.turn} ${styles.rise}`} style={{ "--i": 6 }}>
          <span />
          <span class={styles.muted}>edited src/limiter.ts, added 2 tests</span>
        </div>
        <div class={`${styles.turn} ${styles.rise}`} style={{ "--i": 10 }}>
          <span />
          <span class={styles.added}>18 tests passed</span>
        </div>
        <div class={`${styles.turn} ${styles.rise}`} style={{ "--i": 14 }}>
          <span class={styles.turnMark}>#13</span>
          <span>
            now send the Retry-After header
            <span class={styles.caret} />
          </span>
        </div>
      </div>
      <div class={`${styles.strip} ${styles.rise}`} style={{ "--i": 16 }}>
        <span class={styles.chip}>Diff turn #12</span>
        <span class={styles.chip}>Revert turn #12</span>
        <span class={styles.stripEnd}>13 checkpoints</span>
      </div>
    </div>
  );
}

export function ReviewIllustration() {
  const lines: { kind: "hunk" | "ctx" | "add" | "del"; text: string }[] = [
    { kind: "hunk", text: "@@ -18,2 +18,5 @@" },
    { kind: "ctx", text: "  const bucket = buckets.get(key)" },
    { kind: "del", text: "- if (bucket.count > limit) return false" },
    { kind: "add", text: "+ if (bucket.count >= limit) {" },
    { kind: "add", text: "+   res.setHeader('Retry-After', reset)" },
    { kind: "add", text: "+   return false" },
    { kind: "add", text: "+ }" },
  ];
  const lineClass: Record<string, string> = {
    hunk: styles.hunk,
    ctx: styles.ctx,
    add: styles.lineAdd,
    del: styles.lineDel,
  };
  return (
    <div class={`${styles.card} ${styles.wide}`}>
      <div class={styles.cardHead}>
        <span class={styles.mono}>src/limiter.ts</span>
        <span class={styles.added}>+4</span>
        <span class={styles.deleted}>-1</span>
        <span class={styles.stripEnd}>Stage hunk</span>
      </div>
      <div class={styles.hunkBody}>
        <For each={lines}>
          {(l, i) => (
            <div class={`${lineClass[l.kind]} ${styles.slide}`} style={{ "--i": i() }}>
              {l.text}
            </div>
          )}
        </For>
      </div>
      <div class={`${styles.comment} ${styles.rise}`} style={{ "--i": lines.length + 2 }}>
        <span>Use the reset timestamp, not the window length.</span>
        <span class={styles.send}>Send to session</span>
      </div>
      <div class={`${styles.strip} ${styles.rise}`} style={{ "--i": lines.length + 4 }}>
        <span class={styles.chip}>Commit</span>
        <span class={styles.chip}>Push</span>
        <span class={styles.chip}>Open PR</span>
      </div>
    </div>
  );
}

const ref = (n: number) => `#${n}`;
const ticket = (n: number, project: string, branch: string): TicketRef => ({ label: ref(n), place: ["work", project, branch] });

// The real cockpit on made up data, with the ship's log left out so the crew
// and the conversation keep a readable size inside the slide.
export function AutopilotIllustration() {
  const workers: WorkerCard[] = [
    {
      ticket: ticket(212, "api", "fix/rate-limit"),
      title: "Cap the rate limiter",
      diff: "+24 -3",
      status: "needs",
      log: ["$ pnpm test limiter", "  18 passed", "> waiting on your PR approval"],
      doing: "Needs your approval",
    },
    {
      ticket: ticket(214, "web", "feat/webhooks"),
      title: "Retry failed webhooks",
      diff: "+61 -8",
      status: "working",
      log: ["> edit src/webhooks/retry.ts", "$ pnpm test webhooks"],
      doing: "Running tests",
      progress: 0.6,
    },
  ];
  const queue: QueuedItem[] = [{ ticket: { label: ref(215), place: ["work", "web"] }, title: "Document webhook retries", after: workers[1].ticket }];
  const messages: ThreadMessage[] = [
    { from: "me", text: `work on ${ref(212)} and ${ref(214)}, then ${ref(215)}` },
    { from: "autopilot", text: `Started two workers: ${ref(212)} in api and ${ref(214)} in web. ${ref(215)} waits for ${ref(214)}, since it documents that change.` },
    { from: "autopilot", text: `${ref(212)} is done and all 18 limiter tests pass. Opening its PR sends it to GitHub, so I need your approval.` },
  ];
  const decisions: Decision[] = [
    {
      kind: "pr",
      ticket: workers[0].ticket,
      title: "Cap the rate limiter",
      summary: "Open a draft PR from fix/rate-limit into main. 3 files, +24 -3, tests pass.",
      age: "now",
    },
  ];
  return (
    <div class={styles.window} inert>
      <div class={styles.miniCockpit}>
        <div class={styles.titleBar}>
          <span class={styles.lights}>
            <span />
            <span />
            <span />
          </span>
          <AutopilotSwitch view="autopilot" state="needs" count={decisions.length} />
        </div>
        <div class={styles.cockpitBody}>
          <AutopilotView
            state="needs"
            workers={workers}
            emptyWorkers=""
            queue={queue}
            messages={messages}
            decisions={decisions}
            focused={0}
            activity={[]}
            shield=""
            hero={heroFor("needs", decisions.length, workers.length, queue.length, 0)}
            scene={pickScene(new Date().getHours())}
          />
        </div>
      </div>
    </div>
  );
}

const QR_SIZE = 25;

// A made up code with the three finder squares, drawn from a fixed seed so it
// looks the same on every run. Nothing scans it.
function qrModules(): [number, number][] {
  const finder = (x: number, y: number) => {
    const at = (ox: number, oy: number) => x >= ox && x < ox + 7 && y >= oy && y < oy + 7;
    const ring = (ox: number, oy: number) => {
      const dx = x - ox;
      const dy = y - oy;
      return dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
    };
    for (const [ox, oy] of [[0, 0], [QR_SIZE - 7, 0], [0, QR_SIZE - 7]]) if (at(ox, oy)) return ring(ox, oy) ? 1 : 0;
    const near = (ox: number, oy: number) => x >= ox - 1 && x <= ox + 7 && y >= oy - 1 && y <= oy + 7;
    return near(0, 0) || near(QR_SIZE - 7, 0) || near(0, QR_SIZE - 7) ? 0 : -1;
  };
  let seed = 7;
  const out: [number, number][] = [];
  for (let y = 0; y < QR_SIZE; y++) {
    for (let x = 0; x < QR_SIZE; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const f = finder(x, y);
      if (f === 1 || (f === -1 && seed % 100 < 47)) out.push([x, y]);
    }
  }
  return out;
}

function PairingCard() {
  const d = qrModules()
    .map(([x, y]) => `M${x} ${y}h1v1h-1z`)
    .join("");
  return (
    <div class={`${styles.card} ${styles.pairCard} ${styles.rise}`}>
      <div class={styles.cardHead}>
        <span class={styles.crewName}>Pair a device</span>
        <span class={styles.stripEnd}>Settings &gt; Remote access</span>
      </div>
      <div class={styles.pairBody}>
        <svg class={styles.qr} viewBox={`-2 -2 ${QR_SIZE + 4} ${QR_SIZE + 4}`} aria-hidden="true">
          <path d={d} fill="currentColor" />
        </svg>
        <kbd class={styles.pairCode}>K7QF-2MXD</kbd>
        <span class={`${styles.mono} ${styles.muted}`}>ws://100.84.12.7:47821</span>
        <span class={styles.muted}>Expires in 4:52</span>
      </div>
      <div class={styles.strip}>
        <span class={styles.muted}>Tailscale</span>
        <span class={`${styles.stripEnd} ${styles.connected}`}>Connected</span>
      </div>
    </div>
  );
}

const noClient = { status: () => "open", request: () => new Promise(() => {}), subscribe: () => () => {} } as unknown as RemoteClient;

function unit(folder: string, branch: string): Unit {
  return { label: branch, folder, branch, kind: "worktree", isCurrent: false };
}

const PHONE_SPACES: Space[] = [
  {
    name: "work",
    path: "~/Projects/work",
    icon: null,
    color: null,
    projects: [
      { name: "api", path: "~/Projects/work/api", units: [unit("~/Projects/work/api/fix", "fix/rate-limit"), unit("~/Projects/work/api/limits", "docs/limits")] },
      { name: "web", path: "~/Projects/work/web", units: [unit("~/Projects/work/web/webhooks", "feat/webhooks"), unit("~/Projects/work/web/main", "main")] },
      { name: "infra", path: "~/Projects/work/infra", units: [unit("~/Projects/work/infra/main", "main")] },
    ],
  },
  { name: "personal", path: "~/Projects/personal", icon: null, color: null, projects: [] },
];

const home = (project: string, folder: string, branch: string) => ({ project: `~/Projects/work/${project}`, folder: `~/Projects/work/${project}/${folder}`, branch });

const PHONE_LIVE: SessionRow[] = [
  { id: "s1", title: "Cap the rate limiter", live: true, dot: "needs", last_active: 0, home: home("api", "fix", "fix/rate-limit") },
  { id: "s2", title: "Limits docs", live: true, dot: "working", last_active: 0, home: home("api", "limits", "docs/limits") },
  { id: "s3", title: "Retry failed webhooks", live: true, dot: "working", last_active: 0, home: home("web", "webhooks", "feat/webhooks") },
];

const PHONE_CHAT: ChatItem[] = [
  { kind: "user", id: "u1", blocks: [{ type: "text", text: "now send the Retry-After header" }], steer: false },
  { kind: "text", id: "t1", turnId: "t", agentId: null, text: "Added `Retry-After` to the 429 response, set from the bucket's reset time, and a test for it. Running the suite now." },
];

const PHONE_PENDING: PendingRow[] = [{ kind: "permission", id: "p1", tool: "Bash", detail: "pnpm test limiter" }];

function Phone(props: { children: JSX.Element; i: number }) {
  return (
    <div class={`${styles.phone} ${styles.rise}`} style={{ "--i": props.i }}>
      <div class={styles.phoneScreen}>
        <div class={styles.statusBar}>
          <span>9:41</span>
          <span class={styles.island} />
        </div>
        <div class={shell.shell}>{props.children}</div>
      </div>
    </div>
  );
}

// The phone app's own screens on made up data. The client never connects, so
// nothing a screen asks the Mac for ever arrives.
export function PhoneIllustration() {
  return (
    <div class={styles.phones} inert>
      <PairingCard />
      <Phone i={2}>
        <Root
          client={noClient}
          tree={{ spaces: PHONE_SPACES, topics: [] }}
          space={PHONE_SPACES[0]}
          tab="projects"
          live={() => PHONE_LIVE}
          notice={null}
          onProject={() => {}}
          onTopic={() => {}}
          onUnit={() => {}}
          onSession={() => {}}
          onSettings={() => {}}
        />
        <BottomBar
          spaces={PHONE_SPACES}
          space={PHONE_SPACES[0]}
          tab="projects"
          live={() => PHONE_LIVE}
          showWheel
          runner={() => null}
          decisions={() => 0}
          onSpace={() => {}}
          onTopics={() => {}}
          onWheel={() => {}}
        />
      </Phone>
      <Phone i={5}>
        <div class={shell.chat}>
          <header class={shell.chatTop}>
            <span class={shell.circle}>
              <Icon icon={ChevronLeft} size={20} strokeWidth={2} />
            </span>
            <span class={shell.chatTitles}>
              <span class={shell.chatTitle}>Cap the rate limiter</span>
              <span class={shell.stateLine}>
                <PhaseMark phase="needs" />
                {PHASE_LABEL.needs} {DOT} api {"\u203a"} fix/rate-limit
              </span>
            </span>
          </header>
          <div class={mobile.transcript}>
            <MessageList
              items={PHONE_CHAT}
              streaming={false}
              sessionId="intro"
              cwd=""
              modelLabelFor={() => null}
              onSetMode={() => {}}
              onRevertHunk={async () => false}
            />
          </div>
          <Pending client={noClient} session="s1" rows={PHONE_PENDING} onSettled={() => {}} />
          <div class={shell.composer}>
            <span class={shell.composerInput}>Message</span>
            <span class={shell.composerRow}>
              <span class={shell.send}>
                <Icon icon={ArrowUp} size={17} strokeWidth={2.6} />
              </span>
            </span>
          </div>
        </div>
      </Phone>
    </div>
  );
}

export function MachineIllustration() {
  const agents = [
    { id: "claude", label: "Claude" },
    { id: "codex", label: "Codex" },
    { id: "gemini", label: "Gemini" },
    { id: "opencode", label: "OpenCode" },
  ];
  const host = (i: number, logo: JSX.Element, name: string, state: string) => (
    <div class={`${styles.listRow} ${styles.rise}`} style={{ "--i": i }}>
      <span class={styles.logo}>{logo}</span>
      <span>{name}</span>
      <span class={styles.stripEnd}>{state}</span>
    </div>
  );
  return (
    <div class={styles.pair}>
      <div class={`${styles.card} ${styles.list}`}>
        <div class={styles.eyebrow}>Agents</div>
        <For each={agents}>
          {(a, i) => (
            <div class={`${styles.listRow} ${styles.rise}`} style={{ "--i": i() }}>
              <span class={styles.logo}>
                <AgentGlyph id={a.id} label={a.label} size={18} />
              </span>
              <span>{a.label}</span>
            </div>
          )}
        </For>
        <div class={`${styles.listRow} ${styles.muted} ${styles.rise}`} style={{ "--i": agents.length }}>
          Any other CLI, through a TOML file
        </div>
      </div>
      <div class={`${styles.card} ${styles.list}`}>
        <div class={styles.eyebrow}>Hosts</div>
        {host(0, <GitHubLogo size={16} />, "GitHub", "Signed in")}
        {host(1, <GitLabLogo size={16} />, "GitLab", "Not connected")}
        <div class={`${styles.listRow} ${styles.rise}`} style={{ "--i": 2 }}>
          <kbd class={`${styles.kbd} ${styles.press}`}>{"\u2318K"}</kbd>
          <span class={styles.muted}>opens everything</span>
        </div>
      </div>
    </div>
  );
}
