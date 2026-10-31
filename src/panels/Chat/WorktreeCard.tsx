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

// A call waiting on approval, refused or failed keeps the generic card, which
// is where the prompt and the error live.
export function isWorktreeCard(card: ToolItem): boolean {
  if (toriCall(card)?.tool !== "worktree_new") return false;
  return card.state === "running" || (card.state === "ok" && !!text(toriReply(card.output)?.path));
}

export default function WorktreeCard(props: {
  card: ToolItem;
  cwd: string;
  onOpenWorktree?: (folder: string) => void;
}) {
  const args = () => toriCall(props.card)?.args ?? {};
  const reply = createMemo(() => toriReply(props.card.output));
  const running = () => props.card.state === "running";
  const path = () => text(reply()?.path);
  const branch = () =>
    text(reply()?.branch) ?? text(args().branch) ?? (args().pr === undefined ? null : `pr-${String(args().pr)}`);
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
        <Show when={live()}>{(said) => <span class={styles.toolState}>{said()}</span>}</Show>
        <Show when={props.onOpenWorktree && !removed() && path()}>
          {(folder) => (
            <Button size="sm" onClick={() => props.onOpenWorktree?.(folder())}>
              Open
            </Button>
          )}
        </Show>
      </div>
    </div>
  );
}
