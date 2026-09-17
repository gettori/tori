import { For, type JSX } from "solid-js";
import { Check, ChevronsLeftRightEllipsis, Folder, MessageCircleQuestion, type LucideIcon } from "lucide-solid";
import Icon from "../../../components/Icon/Icon";
import AgentGlyph from "../../../components/Icon/AgentGlyph";
import { GitHubLogo, GitLabLogo } from "../../../components/Icon/gitMarks";
import styles from "./Intro.module.css";

type State = "working" | "needsYou" | "done";

const STATE: Record<State, { icon: LucideIcon; label: string; class: string }> = {
  working: { icon: ChevronsLeftRightEllipsis, label: "Working", class: styles.working },
  needsYou: { icon: MessageCircleQuestion, label: "Needs you", class: styles.needsYou },
  done: { icon: Check, label: "Done", class: styles.done },
};

function StateGlyph(props: { state: State }) {
  return (
    <span class={`${styles.state} ${STATE[props.state].class}`}>
      <Icon icon={STATE[props.state].icon} size={14} />
    </span>
  );
}

export function SessionsIllustration() {
  const rows: { label: string; depth: 0 | 1; state: State; selected?: boolean; dim?: boolean }[] = [
    { label: "api", depth: 0, state: "working" },
    { label: "fix/rate-limit", depth: 1, state: "working", selected: true },
    { label: "feat/webhooks", depth: 1, state: "needsYou", dim: true },
    { label: "web", depth: 0, state: "done" },
    { label: "main", depth: 1, state: "done", dim: true },
  ];
  const legend: { state: State; count: number }[] = [
    { state: "working", count: 2 },
    { state: "needsYou", count: 1 },
    { state: "done", count: 4 },
  ];
  return (
    <div class={styles.split}>
      <div class={`${styles.card} ${styles.tree}`}>
        <div class={styles.cardHead}>work</div>
        <div class={styles.treeBody}>
          <For each={rows}>
            {(r) => (
              <div
                class={styles.treeRow}
                classList={{ [styles.child]: r.depth === 1, [styles.selected]: r.selected, [styles.muted]: r.dim }}
              >
                <span class={styles.treeLabel}>{r.label}</span>
                <StateGlyph state={r.state} />
              </div>
            )}
          </For>
        </div>
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

export function LayoutIllustration() {
  const levels = ["Base folder", "Space", "Project", "Branch or worktree"];
  const tree: { label: string; depth: number; feature?: boolean; dim?: boolean }[] = [
    { label: "~/Projects", depth: 0, dim: true },
    { label: "work", depth: 1, dim: true },
    { label: "api", depth: 2 },
    { label: "feat/webhooks", depth: 3, feature: true },
    { label: "web", depth: 2 },
    { label: "feat/webhooks", depth: 3, feature: true },
  ];
  return (
    <div class={styles.split}>
      <div class={styles.levels}>
        <For each={levels}>
          {(label, i) => (
            <div class={styles.level} classList={{ [styles.levelLast]: i() === levels.length - 1 }} style={{ "--depth": i() }}>
              {label}
            </div>
          )}
        </For>
      </div>
      <div class={`${styles.card} ${styles.pathTree}`}>
        <For each={tree}>
          {(n) => (
            <div class={styles.pathRow} classList={{ [styles.feature]: n.feature, [styles.muted]: n.dim }} style={{ "--depth": n.depth }}>
              <Icon icon={Folder} size={13} />
              {n.label}
            </div>
          )}
        </For>
        <div class={styles.note}>One Feature, two repos, one branch</div>
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
      <span class={styles.hostLogo}>{logo}</span>
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
              <AgentGlyph id={a.id} label={a.label} size={18} />
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
