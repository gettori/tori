import { createSignal, createEffect, on, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Search, TriangleAlert } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import RepoChecklist, { type RepoSpace } from "./RepoChecklist";
import { topicSlug, type MemberMode, type Topic } from "../../utils/topics";

const NAME_LABEL = "topic-name-label";
const BRANCH_LABEL = "topic-branch-label";
const PICKED_LABEL = "topic-picked-label";
const PROBE_DEBOUNCE_MS = 250;

export type BranchProbe = { valid: boolean; local: boolean; remote: boolean; hasWorktree: boolean };

type Probe = { branch: string; result: BranchProbe | null };
const CLEAR: BranchProbe = { valid: true, local: false, remote: false, hasWorktree: false };
const MODES = [
  { value: "reference" as const, label: "Reference" },
  { value: "worktree" as const, label: "Worktree" },
];

/** Create a Topic, or add repositories to one (`topic` set): the same
 *  checklist, the same probe per repo that gets a worktree, the same collision
 *  row. Only the name and branch fields and the command differ.
 *
 *  A probe answer is keyed on `(repoPath, branch)` and dropped when either
 *  has moved on, so a slow answer for a previous branch can never mark the
 *  current one. A hit (the branch exists locally, remotely, or has a
 *  worktree) holds Done until the row is answered: Adopt keeps the repo (the
 *  backend reuses the branch, and a secondary worktree, on its own), the other
 *  button unchecks it. This tightens the #151 design, where Done needed only a
 *  name and a repo, so a collision is never discovered by a failed member. */
export default function NewTopicDialog(props: {
  spaces: RepoSpace[];
  topics: Topic[];
  /** When set, the dialog adds repositories to this Topic instead. */
  topic?: Topic;
  onDone: (topic: Topic) => void;
  onCancel: () => void;
}) {
  const [name, setName] = createSignal("");
  const [typedBranch, setTypedBranch] = createSignal<string | null>(null);
  const [checked, setChecked] = createSignal<string[]>([]);
  // Repos that get a worktree now. Everything else is attached as a reference,
  // which touches nothing in git, so only these rows have a branch to probe.
  const [worktrees, setWorktrees] = createSignal<ReadonlySet<string>>(new Set());
  const [probes, setProbes] = createSignal<Map<string, Probe>>(new Map());
  const [adopting, setAdopting] = createSignal<Map<string, string>>(new Map());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal("");
  let nameInput: HTMLInputElement | undefined;

  const adding = () => props.topic !== undefined;
  const branchText = () => typedBranch() ?? topicSlug(name());
  const branch = () => (props.topic ? props.topic.branch : branchText().trim());
  const takenBy = () => (adding() ? undefined : props.topics.find((f) => f.branch === branch()));
  const exclude = () => props.topic?.members.map((m) => m.repoPath) ?? [];

  const repoName = (path: string) =>
    props.spaces.flatMap((g) => g.projects).find((p) => p.path === path)?.name ?? path.split("/").pop() ?? path;

  const spaceOf = (path: string) => props.spaces.find((g) => g.projects.some((p) => p.path === path))?.name;
  const spanned = () => [...new Set([...exclude(), ...checked()].map(spaceOf).filter((n): n is string => !!n))];

  // One probe per (repo, branch). Typing is debounced; a check is not,
  // since the repo is the whole question there.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastBranch = branch();
  function probe(repoPath: string, forBranch: string) {
    setProbes((prev) => new Map(prev).set(repoPath, { branch: forBranch, result: null }));
    invoke<BranchProbe | null>("probe_topic_branch", { repoPath, branch: forBranch })
      .then((answer) => {
        if (branch() !== forBranch || !checked().includes(repoPath)) return;
        const result = answer ?? CLEAR;
        setProbes((prev) => new Map(prev).set(repoPath, { branch: forBranch, result }));
      })
      // A probe that cannot answer (the repo is gone, say) must not hold Done
      // hostage: the member will carry the real failure after creation.
      .catch(() => {
        if (branch() !== forBranch || !checked().includes(repoPath)) return;
        setProbes((prev) => new Map(prev).set(repoPath, { branch: forBranch, result: CLEAR }));
      });
  }
  const withWorktree = () => checked().filter((r) => worktrees().has(r));
  const modeOf = (repoPath: string): MemberMode => (worktrees().has(repoPath) ? "worktree" : "reference");
  function setWorktree(repoPath: string, on: boolean) {
    setWorktrees((prev) => {
      const next = new Set(prev);
      if (on) next.add(repoPath);
      else next.delete(repoPath);
      return next;
    });
  }
  function probeStale() {
    const b = branch();
    if (!b) return;
    for (const repoPath of withWorktree()) {
      const have = probes().get(repoPath);
      if (have?.branch !== b) probe(repoPath, b);
    }
  }
  createEffect(
    on([branch, withWorktree], () => {
      clearTimeout(timer);
      const branchChanged = branch() !== lastBranch;
      lastBranch = branch();
      if (branchChanged) timer = setTimeout(probeStale, PROBE_DEBOUNCE_MS);
      else probeStale();
    }),
  );
  onCleanup(() => clearTimeout(timer));

  type Row = "clear" | "pending" | "collided" | "adopting";
  const row = (repoPath: string): Row => {
    if (!worktrees().has(repoPath)) return "clear";
    if (!branch()) return "pending";
    const p = probes().get(repoPath);
    if (!p || p.branch !== branch() || !p.result) return "pending";
    if (!p.result.local && !p.result.remote && !p.result.hasWorktree) return "clear";
    return adopting().get(repoPath) === branch() ? "adopting" : "collided";
  };
  const unresolved = () => withWorktree().some((r) => row(r) === "pending" || row(r) === "collided");
  const invalid = () =>
    withWorktree().some((r) => {
      const p = probes().get(r);
      return p?.branch === branch() && p.result?.valid === false;
    });
  const named = () => adding() || name().trim() !== "";
  const canConfirm = () =>
    !busy() && named() && branch() !== "" && checked().length > 0 && !takenBy() && !invalid() && !unresolved();

  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const status = () => {
    const conflicts = withWorktree().filter((r) => row(r) === "collided").length;
    if (conflicts > 0) return `${count(conflicts, "branch conflict")} to resolve`;
    if (branch() && withWorktree().some((r) => row(r) === "pending")) return "Checking branches...";
    const worktree = withWorktree().length;
    const reference = checked().length - worktree;
    return [reference && count(reference, "reference"), worktree && count(worktree, "worktree")]
      .filter(Boolean)
      .join(", ");
  };

  function adopt(repoPath: string) {
    setAdopting((prev) => new Map(prev).set(repoPath, branch()));
  }
  // Focus moves before the row goes: the button being pressed unmounts with
  // the collision line, and a focus scope asked about a detached node throws.
  function leaveOut(repoPath: string) {
    if (!adding()) nameInput?.focus();
    setChecked((prev) => prev.filter((r) => r !== repoPath));
  }

  async function confirm() {
    if (!canConfirm()) return;
    setBusy(true);
    setError(null);
    try {
      let topic: Topic;
      if (props.topic) {
        topic = props.topic;
        for (const repoPath of checked()) {
          topic = await invoke<Topic>("add_member", { topicId: props.topic.id, repoPath, mode: modeOf(repoPath) });
        }
      } else {
        const members = checked().map((repoPath) => ({ repoPath, mode: modeOf(repoPath) }));
        topic = await invoke<Topic>("create_topic", { name: name().trim(), branch: branch(), members });
      }
      props.onDone(topic);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  function onEnter(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void confirm();
  }

  const collision = (repoPath: string) => {
    const state = row(repoPath);
    if (state === "clear" || state === "pending") return undefined;
    return (
      <div class={styles.collision} data-adopting={state === "adopting" ? "" : undefined}>
        <Show
          when={state === "adopting"}
          fallback={
            <>
              <Icon icon={TriangleAlert} class={styles.collisionIcon} />
              <span class={styles.collisionText}>
                <code>{branch()}</code> already exists
              </span>
              <Button size="xs" aria-label={`Adopt in ${repoName(repoPath)}`} onClick={() => adopt(repoPath)}>
                Adopt
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${adding() ? "Leave out" : "Rename Topic"}, ${repoName(repoPath)}`}
                onClick={() => leaveOut(repoPath)}
              >
                {adding() ? "Leave out" : "Rename Topic"}
              </Button>
            </>
          }
        >
          <span class={styles.collisionText}>
            Adopting <code>{branch()}</code>
          </span>
        </Show>
      </div>
    );
  };

  return (
    <Dialog
      open
      title={props.topic ? `Add repository to ${props.topic.name}` : "New Topic"}
      size="wide"
      onClose={() => props.onCancel()}
      initialFocus={() => nameInput}
      actions={
        <>
          <span class={styles.topicStatus} role="status">
            {status()}
          </span>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!canConfirm()} onClick={() => void confirm()}>
            {busy() ? "Working\u2026" : adding() ? "Add to Topic" : "Create Topic"}
          </Button>
        </>
      }
    >
      <Show when={error()}>
        {(msg) => (
          <div class={styles.warning} role="alert">
            {msg()}
          </div>
        )}
      </Show>
      <div class={styles.topicForm}>
        <div class={styles.topicFields}>
          <Show
            when={!adding()}
            fallback={
              <div>
                <div class={styles.label}>Branch</div>
                <div class={styles.slug}>
                  <strong>{branch()}</strong>
                </div>
              </div>
            }
          >
            <div>
              <div id={NAME_LABEL} class={styles.label}>
                Name
              </div>
              <input
                ref={nameInput}
                class={styles.input}
                aria-labelledby={NAME_LABEL}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                onKeyDown={onEnter}
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
              />
            </div>
            <div>
              <div id={BRANCH_LABEL} class={styles.label}>
                Branch
              </div>
              <input
                class={`${styles.input} ${styles.mono}`}
                aria-labelledby={BRANCH_LABEL}
                value={branchText()}
                onInput={(e) => setTypedBranch(e.currentTarget.value)}
                onKeyDown={onEnter}
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
              />
              <Show when={invalid()}>
                <div class={styles.hint}>not a valid branch name</div>
              </Show>
              <Show when={takenBy()}>{(f) => <div class={styles.hint}>already used by {f().name}</div>}</Show>
            </div>
          </Show>
        </div>
        <div class={styles.topicPanes}>
          <div class={styles.topicPicker}>
            <div class={styles.topicFilter}>
              <Icon icon={Search} class={styles.topicFilterIcon} />
              <input
                type="search"
                aria-label="Filter repositories"
                placeholder="Filter repositories"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
              />
            </div>
            <RepoChecklist
              spaces={props.spaces}
              value={checked()}
              onChange={setChecked}
              exclude={exclude()}
              filter={filter()}
            />
          </div>
          <section class={styles.topicPicked} aria-labelledby={PICKED_LABEL}>
            <div class={styles.pickedHead}>
              <span id={PICKED_LABEL}>
                {adding() ? "Adding" : "In this Topic"} {"\u00b7"} {checked().length}
              </span>
              <span>Reference is read only</span>
            </div>
            <Show when={spanned().length > 1}>
              <div class={styles.spaceWarning} role="note">
                <Icon icon={TriangleAlert} class={styles.collisionIcon} />
                <span>
                  Repositories from {spanned().length} Spaces: {spanned().join(", ")}
                </span>
              </div>
            </Show>
            <Show
              when={checked().length > 0}
              fallback={<div class={styles.pickedEmpty}>Pick repositories on the left.</div>}
            >
              <ul class={styles.pickedList}>
                <For each={checked()}>
                  {(repoPath) => (
                    <li class={styles.pickedCard} data-picked={repoPath}>
                      <div class={styles.pickedRow}>
                        <span class={styles.pickedName}>{repoName(repoPath)}</span>
                        <SegmentedControl
                          size="sm"
                          aria-label={`Mode for ${repoName(repoPath)}`}
                          options={MODES}
                          value={modeOf(repoPath)}
                          onChange={(mode) => setWorktree(repoPath, mode === "worktree")}
                        />
                      </div>
                      {collision(repoPath)}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </div>
      </div>
    </Dialog>
  );
}
