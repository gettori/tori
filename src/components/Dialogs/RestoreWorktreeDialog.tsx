import { createMemo, createSignal, For, Show } from "solid-js";
import { Check, History } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Combobox from "../Combobox/Combobox";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import { ago } from "../../utils/relativeTime";

export type Rescued = {
  id: string;
  branch: string | null;
  worktree: string;
  deletedAt: number;
  operation: string | null;
  files: string[];
  commits: string[];
  skipped: string[];
};

const SHOWN = 5;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

export const rescueLabel = (r: Rescued) => r.branch ?? folderName(r.worktree);

function some(names: string[]) {
  const rest = names.length - SHOWN;
  return names.slice(0, SHOWN).join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

function midway(operation: string) {
  const [kind, step] = operation.split(" ");
  return `Deleted in the middle of a ${kind}${step ? `, at ${step}` : ""}. Its commits and files come back, the ${kind} itself does not.`;
}

export default function RestoreWorktreeDialog(props: {
  projectName: string;
  rescues: Rescued[] | null;
  busy: boolean;
  onRestore: (id: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [parked, setParked] = createSignal<string | null>(null);
  let input: HTMLInputElement | undefined;

  const all = () => props.rescues ?? [];
  const options = createMemo(() => {
    const q = query().trim().toLowerCase();
    return all()
      .filter((r) => !q || rescueLabel(r).toLowerCase().includes(q))
      .map((r) => ({ value: r.id, label: rescueLabel(r) }));
  });
  const newest = () => all().reduce<Rescued | null>((a, r) => (a && a.deletedAt >= r.deletedAt ? a : r), null);
  const picked = () => all().find((r) => r.id === parked()) ?? newest();
  const byId = (id: string) => all().find((r) => r.id === id);

  return (
    <Dialog
      open
      size="sheet"
      title={`Restore a deleted worktree in ${props.projectName}`}
      onClose={() => props.onCancel()}
      initialFocus={() => input}
      actions={
        <>
          <Show when={picked()}>{(r) => <span class={styles.pathHint}>Was at {r().worktree}</span>}</Show>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button
            variant="primary"
            disabled={props.busy || !picked()}
            onClick={() => {
              const r = picked();
              if (r) props.onRestore(r.id);
            }}
          >
            {props.busy ? "Restoring..." : "Restore"}
          </Button>
        </>
      }
    >
      <Combobox
        class={styles.pickerField}
        listClass={styles.branchList}
        options={options()}
        query={query()}
        onQueryChange={(q) => {
          if (q !== query()) setQuery(q);
        }}
        onSelect={setParked}
        picked={picked()?.id ?? null}
        inputRef={(el) => (input = el)}
        placeholder="Filter by branch"
        aria-label="Filter deleted worktrees by branch"
        listLabel="Deleted worktrees"
        emptyLabel={props.rescues === null ? "Loading..." : "No deleted worktree matches"}
        itemComponent={(option) => {
          const r = () => byId(option.value);
          const isPicked = () => picked()?.id === option.value;
          return (
            <>
              <Icon
                icon={isPicked() ? Check : History}
                class={styles.branchGlyph}
                classList={{ [styles.branchGlyphPicked]: isPicked() }}
                aria-hidden="true"
              />
              <span class={styles.branchName}>{option.label}</span>
              <Show when={r()?.operation}>{(op) => <span class={styles.branchTag}>{op()}</span>}</Show>
              <span class={styles.branchTag} data-restore-age>
                {ago(Math.floor((r()?.deletedAt ?? 0) / 1000))} ago
              </span>
            </>
          );
        }}
        aboveList={
          <div class={styles.listHead}>
            <span>Kept for 30 days after the delete</span>
          </div>
        }
      />
      <Show when={picked()}>
        {(r) => (
          <div class={styles.restoreDetail} data-restore-detail>
            <Show when={r().operation}>{(op) => <div class={styles.restoreLine}>{midway(op())}</div>}</Show>
            <div class={styles.restoreLine}>
              {r().files.length
                ? `${plural(r().files.length, "changed file")}: ${some(r().files)}`
                : "No changed files"}
            </div>
            <Show when={r().commits.length}>
              <div class={styles.restoreLine}>
                {plural(r().commits.length, "commit")} no branch holds:
                <ul class={styles.restoreCommits}>
                  <For each={r().commits.slice(0, SHOWN)}>{(subject) => <li>{subject}</li>}</For>
                </ul>
                <Show when={r().commits.length > SHOWN}>and {r().commits.length - SHOWN} more</Show>
              </div>
            </Show>
            <Show when={r().skipped.length}>
              <div class={styles.restoreLine}>Left out of the copy, too large: {some(r().skipped)}</div>
            </Show>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
