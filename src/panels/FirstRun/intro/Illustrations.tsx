import { For, Match, Show, Switch, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ChevronRight, Folder, Tag } from "lucide-solid";
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
          {(p) => (
            <div class={styles.project}>
              <div class={`${styles.treeRow} ${styles.projectRow}`}>
                <span class={styles.rowIcon}>
                  <ProjectIcon seed={p.path} />
                </span>
                <span class={styles.treeLabel}>{p.name}</span>
                <Show when={"rollup" in p && p.rollup}>{(r) => <StateGlyph state={r().state} count={r().count} />}</Show>
              </div>
              <For each={"branches" in p ? p.branches : []}>
                {(b) => (
                  <div class={styles.branchNode}>
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
          {(l) => (
            <div class={`${styles.card} ${styles.legendRow}`}>
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
            <div class={styles.level} classList={{ [styles.levelLast]: i() === levels.length - 1 }} style={{ "--depth": i() }}>
              <LevelGlyph level={l.level} path="~/Projects/work/api" />
              {l.label}
            </div>
          )}
        </For>
      </div>
      <div class={`${styles.card} ${styles.pathTree}`}>
        <For each={tree}>
          {(n) => (
            <div class={styles.pathRow} data-level={n.level} style={{ "--depth": n.depth }}>
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
          {(t) => (
            <div class={styles.topicItem} classList={{ [styles.topicActive]: t.active }}>
              <div class={styles.topicHead}>
                <span class={styles.topicCaret}>
                  <Icon icon={ChevronRight} />
                </span>
                <span class={styles.topicName}>{t.name}</span>
              </div>
              <div class={styles.topicChips}>
                <For each={t.members}>
                  {(m) => <MemberChip icon={{ seed: m.path }} tint={resolveColor(m.color)} size="md" decorative />}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
      <div class={`${styles.card} ${styles.pathTree}`}>
        <For each={tree}>
          {(n) => (
            <div class={styles.pathRow} data-level={n.level} style={{ "--depth": n.depth }}>
              <LevelGlyph level={n.level} path={n.path} />
              {n.label}
              <Show when={n.tagged}>
                <span class={styles.topicChip}>
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
        <span class={`${styles.tab} ${styles.tabOn}`}>
          <StateGlyph state="working" />
          api / fix/rate-limit
        </span>
        <span class={styles.tab}>
          <StateGlyph state="needsYou" />
          web / feat/webhooks
        </span>
      </div>
      <div class={styles.transcript}>
        <div class={styles.turn}>
          <span class={styles.turnMark}>#12</span>
          <span>cap the limiter at 100 requests a minute per key</span>
        </div>
        <div class={styles.turn}>
          <span />
          <span class={styles.muted}>edited src/limiter.ts, added 2 tests</span>
        </div>
        <div class={styles.turn}>
          <span />
          <span class={styles.added}>18 tests passed</span>
        </div>
        <div class={styles.turn}>
          <span class={styles.turnMark}>#13</span>
          <span>now send the Retry-After header</span>
        </div>
      </div>
      <div class={styles.strip}>
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
        <For each={lines}>{(l) => <div class={lineClass[l.kind]}>{l.text}</div>}</For>
      </div>
      <div class={styles.comment}>
        <span>Use the reset timestamp, not the window length.</span>
        <span class={styles.send}>Send to session</span>
      </div>
      <div class={styles.strip}>
        <span class={styles.chip}>Commit</span>
        <span class={styles.chip}>Push</span>
        <span class={styles.chip}>Open PR</span>
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
  const host = (logo: JSX.Element, name: string, state: string) => (
    <div class={styles.listRow}>
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
          {(a) => (
            <div class={styles.listRow}>
              <span class={styles.logo}>
                <AgentGlyph id={a.id} label={a.label} size={18} />
              </span>
              <span>{a.label}</span>
            </div>
          )}
        </For>
        <div class={`${styles.listRow} ${styles.muted}`}>Any other CLI, through a TOML file</div>
      </div>
      <div class={`${styles.card} ${styles.list}`}>
        <div class={styles.eyebrow}>Hosts</div>
        {host(<GitHubLogo size={16} />, "GitHub", "Signed in")}
        {host(<GitLabLogo size={16} />, "GitLab", "Not connected")}
        <div class={styles.listRow}>
          <kbd class={styles.kbd}>{"\u2318K"}</kbd>
          <span class={styles.muted}>opens everything</span>
        </div>
      </div>
    </div>
  );
}
