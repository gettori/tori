import { createMemo, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { ArrowDown, ArrowUp } from "lucide-solid";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import Select from "../Select/Select";
import type { RebaseAction, RebaseCommit, RebasePlan, RebaseStep } from "../../utils/gitActions";
import styles from "./RebaseDialog.module.css";

const ACTIONS: { value: RebaseAction; label: string }[] = [
  { value: "pick", label: "Pick" },
  { value: "reword", label: "Reword" },
  { value: "squash", label: "Squash" },
  { value: "fixup", label: "Fixup" },
  { value: "drop", label: "Drop" },
];

type Row = { commit: RebaseCommit; action: RebaseAction; message: string };

/**
 * An interactive rebase as a list: the branch's own commits, oldest first as
 * git's todo has them, each with its action. The backend writes the todo, so
 * nothing here reaches for an editor.
 *
 * The checks mirror `rebase_todo` in git.rs. Doing them here too is what keeps
 * the button honest, since a refusal after the click reads as a failure.
 */
export default function RebaseDialog(props: {
  plan: RebasePlan;
  busy: boolean;
  onRun: (steps: RebaseStep[]) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = createStore<Row[]>(
    props.plan.commits.map((commit) => ({ commit, action: "pick", message: commit.message })),
  );

  const move = (from: number, to: number) =>
    setRows(
      produce((list) => {
        const [row] = list.splice(from, 1);
        list.splice(to, 0, row);
      }),
    );

  const changed = createMemo(() =>
    rows.some((r, i) => r.commit.sha !== props.plan.commits[i].sha || r.action !== "pick"),
  );

  const problem = createMemo(() => {
    const kept = rows.filter((r) => r.action !== "drop");
    if (!kept.length) return "Every commit is dropped.";
    if (kept[0].action === "squash" || kept[0].action === "fixup") {
      return "The first commit kept has nothing above it to fold into.";
    }
    if (rows.some((r) => r.action === "reword" && !r.message.trim())) {
      return "A reworded commit needs a message.";
    }
    return null;
  });

  const pushedTouched = createMemo(() => changed() && rows.some((r) => r.commit.pushed));

  const run = () => {
    if (props.busy || !changed() || problem()) return;
    props.onRun(
      rows.map((r) => ({
        sha: r.commit.sha,
        action: r.action,
        message: r.action === "reword" ? r.message : undefined,
      })),
    );
  };

  return (
    <Dialog
      open
      size="wide"
      title={`Rebase ${props.plan.commits.length} commit${props.plan.commits.length === 1 ? "" : "s"}`}
      description={`Since ${props.plan.base}, oldest first. Squash and Fixup fold a commit into the one above it: Squash keeps both messages, Fixup keeps only the one above.`}
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            variant="primary"
            disabled={props.busy || !changed() || !!problem()}
            onClick={run}
          >
            {props.busy ? "Rebasing..." : "Rebase"}
          </Button>
        </>
      }
    >
      <div class={styles.list}>
        <For each={rows}>
          {(row, i) => (
            <div
              class={styles.item}
              classList={{
                [styles.folded]: row.action === "squash" || row.action === "fixup",
                [styles.dropped]: row.action === "drop",
              }}
            >
              <div class={styles.line}>
                <span class={styles.sha}>{row.commit.short}</span>
                <span class={styles.subject} title={row.commit.subject}>
                  {row.commit.subject}
                </span>
                <Show when={row.commit.pushed}>
                  <span class={styles.tag}>pushed</span>
                </Show>
                <Select
                  size="sm"
                  class={styles.action}
                  options={ACTIONS}
                  value={row.action}
                  onChange={(v) => setRows(i(), "action", v as RebaseAction)}
                  aria-label={`Action for ${row.commit.short}`}
                />
                <IconButton
                  size="sm"
                  icon={<Icon icon={ArrowUp} />}
                  tooltip="Move up"
                  disabled={i() === 0}
                  onClick={() => move(i(), i() - 1)}
                />
                <IconButton
                  size="sm"
                  icon={<Icon icon={ArrowDown} />}
                  tooltip="Move down"
                  disabled={i() === rows.length - 1}
                  onClick={() => move(i(), i() + 1)}
                />
              </div>
              <Show when={row.action === "reword"}>
                <textarea
                  class={styles.message}
                  rows={3}
                  value={row.message}
                  aria-label={`New message for ${row.commit.short}`}
                  onInput={(e) => setRows(i(), "message", e.currentTarget.value)}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={problem()}>
        {(p) => <div class={styles.problem}>{p()}</div>}
      </Show>
      <Show when={!problem() && pushedTouched()}>
        <div class={styles.note}>
          Some of these commits are already on the upstream, so this rewrites
          pushed history and the branch will need a force push.
        </div>
      </Show>
    </Dialog>
  );
}
