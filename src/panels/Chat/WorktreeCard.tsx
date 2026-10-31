import { Show, createEffect, createMemo, onCleanup } from "solid-js";
import Button from "../../components/Button/Button";
import { WorktreeMark } from "../../components/Icon/gitMarks";
import { projectPathFor, unitAt, unitGone } from "../../utils/sessionActivity";
import { watchFromCard } from "../../utils/forgeStatus";
import type { ToolItem } from "./chatStore";
import { toriCall, toriReply } from "./toriTool";
import styles from "./Chat.module.css";

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;
const text = (v: unknown) => (typeof v === "string" && v ? v : null);

// An agent makes a worktree with worktree_new, or with session_spawn's
// new_worktree when it wants a chat there in the same call.
function makesWorktree(card: ToolItem): boolean {
  const call = toriCall(card);
  return call?.tool === "worktree_new" || (call?.tool === "session_spawn" && !!text(call.args.new_worktree));
}

// worktree_new answers with `path`, session_spawn with `folder`.
const madeAt = (reply: Record<string, unknown> | null) => text(reply?.path) ?? text(reply?.folder);

// A call waiting on approval, refused or failed keeps the generic card, which
// is where the prompt and the error live.
export function isWorktreeCard(card: ToolItem): boolean {
  if (!makesWorktree(card)) return false;
  return card.state === "running" || (card.state === "ok" && !!madeAt(toriReply(card.output)));
}

export default function WorktreeCard(props: {
  card: ToolItem;
  cwd: string;
  onOpenWorktree?: (folder: string, session: string | null) => void;
}) {
  const args = () => toriCall(props.card)?.args ?? {};
  const reply = createMemo(() => toriReply(props.card.output));
  const running = () => props.card.state === "running";
  const path = () => madeAt(reply());
  const branch = () =>
    text(reply()?.branch) ??
    text(args().branch) ??
    text(args().new_worktree) ??
    (args().pr === undefined ? null : `pr-${String(args().pr)}`);
  const chat = () => (toriCall(props.card)?.tool === "session_spawn" ? text(reply()?.id) : null);
  const unit = () => {
    const p = path();
    return p ? unitAt(p) : null;
  };
  const removed = () => {
    const p = path();
    return !running() && !!p && unitGone(p);
  };
  const project = () => {
    const mine = projectPathFor(props.cwd);
    const theirs = unit()?.projectPath ?? text(args().project);
    return mine && theirs && mine !== theirs ? lastSegment(theirs) : null;
  };
  const live = () => {
    if (removed()) return "Removed";
    const pr = unit()?.pullRequest;
    if (pr) return `PR #${pr.number} ${pr.state}`;
    return reply()?.setup === "failed" ? "Setup failed" : null;
  };

  createEffect(() => {
    const u = unit();
    if (!u?.branch) return;
    onCleanup(watchFromCard(u.projectPath, u.branch));
  });

  return (
    <div class={styles.tool} data-tool-use-id={props.card.toolUseId} data-worktree-card="">
      <div class={styles.worktreeRow}>
        <WorktreeMark size={14} active={running()} />
        <span class={styles.toolName}>{running() ? "Making worktree" : "Worktree"}</span>
        <span class={styles.toolArg}>{branch()}</span>
        <Show when={project()}>{(name) => <span class={styles.toolSummary}>{name()}</span>}</Show>
        <Show when={chat()}>
          <span class={styles.toolSummary}>with a chat</span>
        </Show>
        <Show when={live()}>{(said) => <span class={styles.toolState}>{said()}</span>}</Show>
        <Show when={props.onOpenWorktree && !removed() && path()}>
          {(folder) => (
            <Button size="sm" onClick={() => props.onOpenWorktree?.(folder(), chat())}>
              Open
            </Button>
          )}
        </Show>
      </div>
    </div>
  );
}
