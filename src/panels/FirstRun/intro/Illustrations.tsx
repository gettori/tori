import { For, Match, Show, Switch, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ChevronRight, Folder, GitPullRequest, Tag } from "lucide-solid";
import Wheel from "../../../components/Autopilot/Wheel";
import Icon from "../../../components/Icon/Icon";
import MemberChip from "../../../components/MemberChip/MemberChip";
import AgentGlyph from "../../../components/Icon/AgentGlyph";
import { GitHubLogo, GitLabLogo, WorktreeMark } from "../../../components/Icon/gitMarks";
import { CheckMark, QuestionMark, WorkingMark, type StatusMarkProps } from "../../../components/Icon/statusMarks";
import ProjectIcon from "../../../components/Icon/ProjectIcon";
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

type Worker = { ref: number; title: string; branch: string; doing: string; state: "working" | "needs"; progress: number };

export function AutopilotIllustration() {
  const crew: Worker[] = [
    { ref: 212, title: "Cap the rate limiter", branch: "api / fix/rate-limit", doing: "Waiting on you", state: "needs", progress: 1 },
    { ref: 214, title: "Retry failed webhooks", branch: "web / feat/webhooks", doing: "Running tests", state: "working", progress: 0.6 },
  ];
  const queue: { ref: number; title: string; after?: number }[] = [
    { ref: 215, title: "Dark mode for the blog", after: 214 },
    { ref: 218, title: "Document the limits" },
  ];
  return (
    <div class={styles.split}>
      <div class={`${styles.card} ${styles.crew}`}>
        <div class={styles.cardHead}>
          <Wheel state="needs" count={1} />
          <span class={styles.crewName}>Autopilot</span>
          <span class={styles.stripEnd}>2 out, 2 queued</span>
        </div>
        <div class={styles.list}>
          <div class={styles.eyebrow}>In flight</div>
          <For each={crew}>
            {(w, i) => (
              <div class={`${styles.worker} ${styles.rise}`} style={{ "--i": i() * 2 }}>
                <span class={styles.porthole} data-state={w.state} style={{ "--p": `${w.progress * 100}%` }} />
                <span class={styles.workerName}>
                  <span>
                    <span class={styles.ref}>{`#${w.ref}`}</span> {w.title}
                  </span>
                  <span class={styles.workerBranch}>{w.branch}</span>
                </span>
                <span class={w.state === "needs" ? styles.needsYou : styles.muted}>{w.doing}</span>
              </div>
            )}
          </For>
          <div class={styles.eyebrow}>Queued</div>
          <For each={queue}>
            {(q, i) => (
              <div class={`${styles.listRow} ${styles.rise}`} style={{ "--i": 4 + i() }}>
                <span class={styles.ref}>{`#${q.ref}`}</span>
                <span>{q.title}</span>
                <Show when={q.after}>{(after) => <span class={styles.stripEnd}>{`after #${after()}`}</span>}</Show>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class={`${styles.card} ${styles.decision} ${styles.rise}`} style={{ "--i": 8 }}>
        <div class={styles.cardHead}>
          <Icon icon={GitPullRequest} />
          <span>PR</span>
          <span class={styles.ref}>{`#${crew[0].ref}`}</span>
          <span class={styles.stripEnd}>2m</span>
        </div>
        <div class={styles.decisionBody}>
          <strong>{crew[0].title}</strong>
          <span class={styles.muted}>Open a PR from fix/rate-limit into main: 3 commits, 18 tests passing.</span>
        </div>
        <div class={styles.strip}>
          <span class={styles.chip}>Dismiss</span>
          <span class={styles.chip}>Edit</span>
          <span class={`${styles.send} ${styles.press}`} style={{ "--i": 8 }}>
            Approve
          </span>
        </div>
      </div>
    </div>
  );
}

export function PhoneIllustration() {
  const setting = (i: number, name: string, value: JSX.Element) => (
    <div class={`${styles.listRow} ${styles.rise}`} style={{ "--i": i }}>
      <span>{name}</span>
      <span class={styles.stripEnd}>{value}</span>
    </div>
  );
  return (
    <div class={styles.split}>
      <div class={styles.phone}>
        <div class={styles.phoneTop}>
          <StateGlyph state="needsYou" />
          <span class={styles.mono}>api / fix/rate-limit</span>
        </div>
        <div class={styles.phoneBody}>
          <div class={`${styles.bubble} ${styles.bubbleMe} ${styles.rise}`}>now send the Retry-After header</div>
          <div class={`${styles.bubble} ${styles.rise}`} style={{ "--i": 3 }}>
            Added the header and a test. Running the suite next.
          </div>
          <div class={`${styles.phoneCard} ${styles.rise}`} style={{ "--i": 6 }}>
            <strong>Allow Bash?</strong>
            <span class={`${styles.mono} ${styles.muted}`}>npm test</span>
            <div class={styles.phoneActions}>
              <span class={styles.chip}>Deny</span>
              <span class={`${styles.send} ${styles.press}`} style={{ "--i": 6 }}>
                Allow once
              </span>
            </div>
          </div>
        </div>
        <div class={styles.phoneComposer}>Message</div>
      </div>
      <div class={`${styles.card} ${styles.list} ${styles.remote}`}>
        <div class={styles.eyebrow}>Remote access</div>
        {setting(0, "Tailscale", "Connected")}
        {setting(1, "Listening on", <span class={styles.mono}>100.84.12.7:47821</span>)}
        {setting(2, "Pairing code", <kbd class={styles.kbd}>K7QF-2MXD</kbd>)}
        {setting(3, "Paired devices", "iPhone")}
      </div>
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
