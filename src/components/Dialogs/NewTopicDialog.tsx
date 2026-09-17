import { createSignal, createEffect, on, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import RepoChecklist, { type RepoSpace } from "./RepoChecklist";
import { topicSlug, type Topic } from "../../utils/topics";

const NAME_LABEL = "topic-name-label";
const PROBE_DEBOUNCE_MS = 250;

export type BranchProbe = { local: boolean; remote: boolean; hasWorktree: boolean };

type Probe = { slug: string; result: BranchProbe | null };
const CLEAR: BranchProbe = { local: false, remote: false, hasWorktree: false };

/** Create a Topic, or add repositories to one (`topic` set): the same
 *  checklist, the same probe per checked repo, the same collision row. Only
 *  the name field and the command differ.
 *
 *  A probe answer is keyed on `(repoPath, slug)` and dropped when either has
 *  moved on, so a slow answer for a previous name can never mark the current
 *  one. A hit (the branch exists locally, remotely, or has a worktree) holds
 *  Done until the row is answered: Adopt keeps the repo (the backend reuses
 *  the branch, and a secondary worktree, on its own), the other button
 *  unchecks it. This tightens the #151 design, where Done needed only a name
 *  and a repo, so a collision is never discovered by a failed member. */
export default function NewTopicDialog(props: {
  spaces: RepoSpace[];
  topics: Topic[];
  /** When set, the dialog adds repositories to this Topic instead. */
  topic?: Topic;
  onDone: (topic: Topic) => void;
  onCancel: () => void;
}) {
  const [name, setName] = createSignal("");
  const [checked, setChecked] = createSignal<string[]>([]);
  const [probes, setProbes] = createSignal<Map<string, Probe>>(new Map());
  const [adopting, setAdopting] = createSignal<Map<string, string>>(new Map());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let nameInput: HTMLInputElement | undefined;

  const adding = () => props.topic !== undefined;
  const slug = () => (props.topic ? props.topic.branch.replace(/^feat\//, "") : topicSlug(name()));
  const branch = () => `feat/${slug()}`;
  const takenBy = () => (adding() ? undefined : props.topics.find((f) => f.branch === branch()));
  const exclude = () => props.topic?.members.map((m) => m.repoPath) ?? [];

  const repoName = (path: string) =>
    props.spaces.flatMap((g) => g.projects).find((p) => p.path === path)?.name ?? path.split("/").pop() ?? path;

  // One probe per (repo, slug). Name edits are debounced; a check is not,
  // since the repo is the whole question there.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSlug = slug();
  function probe(repoPath: string, forSlug: string) {
    setProbes((prev) => new Map(prev).set(repoPath, { slug: forSlug, result: null }));
    invoke<BranchProbe | null>("probe_topic_branch", { repoPath, slug: forSlug })
      .then((answer) => {
        if (slug() !== forSlug || !checked().includes(repoPath)) return;
        const result = answer ?? CLEAR;
        setProbes((prev) => new Map(prev).set(repoPath, { slug: forSlug, result }));
      })
      // A probe that cannot answer (the repo is gone, say) must not hold Done
      // hostage: the member will carry the real failure after creation.
      .catch(() => {
        if (slug() !== forSlug || !checked().includes(repoPath)) return;
        setProbes((prev) => new Map(prev).set(repoPath, { slug: forSlug, result: CLEAR }));
      });
  }
  function probeStale() {
    const s = slug();
    if (!s) return;
    for (const repoPath of checked()) {
      const have = probes().get(repoPath);
      if (have?.slug !== s) probe(repoPath, s);
    }
  }
  createEffect(
    on([slug, checked], () => {
      clearTimeout(timer);
      const slugChanged = slug() !== lastSlug;
      lastSlug = slug();
      if (slugChanged) timer = setTimeout(probeStale, PROBE_DEBOUNCE_MS);
      else probeStale();
    }),
  );
  onCleanup(() => clearTimeout(timer));

  type Row = "clear" | "pending" | "collided" | "adopting";
  const row = (repoPath: string): Row => {
    if (!slug()) return "pending";
    const p = probes().get(repoPath);
    if (!p || p.slug !== slug() || !p.result) return "pending";
    if (!p.result.local && !p.result.remote && !p.result.hasWorktree) return "clear";
    return adopting().get(repoPath) === slug() ? "adopting" : "collided";
  };
  const unresolved = () => checked().some((r) => row(r) === "pending" || row(r) === "collided");
  const canConfirm = () => !busy() && slug() !== "" && checked().length > 0 && !takenBy() && !unresolved();

  function adopt(repoPath: string) {
    setAdopting((prev) => new Map(prev).set(repoPath, slug()));
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
          topic = await invoke<Topic>("add_member", { topicId: props.topic.id, repoPath });
        }
      } else {
        topic = await invoke<Topic>("create_topic", { name: name().trim(), members: checked() });
      }
      props.onDone(topic);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  function onNameKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void confirm();
  }

  const collision = (repoPath: string) => {
    const state = row(repoPath);
    if (state === "clear" || state === "pending" || !checked().includes(repoPath)) return undefined;
    return (
      <div class={styles.collision} data-adopting={state === "adopting" ? "" : undefined}>
        <Show
          when={state === "adopting"}
          fallback={
            <>
              <span>{branch()} already exists</span>
              <Button size="xs" aria-label={`Adopt in ${repoName(repoPath)}`} onClick={() => adopt(repoPath)}>
                Adopt
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${adding() ? "Leave out" : "Rename this Feature"}, ${repoName(repoPath)}`}
                onClick={() => leaveOut(repoPath)}
              >
                {adding() ? "Leave out" : "Rename this Feature"}
              </Button>
            </>
          }
        >
          <span>Adopting {branch()}</span>
        </Show>
      </div>
    );
  };

  return (
    <Dialog
      open
      title={props.topic ? `Add repository to ${props.topic.name}` : "New Feature"}
      size="sheet"
      onClose={() => props.onCancel()}
      initialFocus={() => nameInput}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!canConfirm()} onClick={() => void confirm()}>
            {busy() ? "Working…" : "Done"}
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
      <Show
        when={!adding()}
        fallback={
          <div class={styles.slug}>
            <strong>{branch()}</strong>
          </div>
        }
      >
        <div id={NAME_LABEL} class={styles.label}>
          Name
        </div>
        <input
          ref={nameInput}
          class={styles.input}
          aria-labelledby={NAME_LABEL}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={onNameKeyDown}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
        <div class={styles.slug} data-slug-preview>
          <Show when={slug()} fallback={<span>feat/</span>}>
            <strong>{branch()}</strong>
          </Show>
        </div>
        <Show when={takenBy()}>{(f) => <div class={styles.hint}>already used by {f().name}</div>}</Show>
      </Show>
      <div class={styles.label}>Repositories</div>
      <RepoChecklist
        spaces={props.spaces}
        value={checked()}
        onChange={setChecked}
        exclude={exclude()}
        collision={collision}
      />
    </Dialog>
  );
}
