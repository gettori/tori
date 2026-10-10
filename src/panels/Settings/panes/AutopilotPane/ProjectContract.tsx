import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js";
import { type SelectOption } from "../../../../components/Select/Select";
import SegmentedControl from "../../../../components/SegmentedControl/SegmentedControl";
import Button from "../../../../components/Button/Button";
import styles from "../../Settings.module.css";
import own from "./ProjectContract.module.css";
import { emptyQuery, type Contract, type ContractPatch, type IssueQuery } from "../../../../utils/autopilotContracts";

const SHIPS: SelectOption[] = [
  { value: "pr", label: "Pull request" },
  { value: "local", label: "Local branch only" },
];
const AUTONOMY: SelectOption[] = [
  { value: "ask_everything", label: "Ask before everything" },
  { value: "auto_until_outward", label: "Alone until it leaves the machine" },
];
const PICKUP: SelectOption[] = [
  { value: "ask", label: "Propose and wait" },
  { value: "auto", label: "Start on its own" },
];

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const optional = (text: string) => (text.trim() ? text.trim() : null);

/**
 * One project's autopilot contract, every field of it.
 *
 * The four choices save on change, like every other settings row. Issue
 * sources are edited as a draft and saved together, since a source is only
 * valid once its repo is filled in and a half-typed one must not reach the
 * pickup. A save Rust refuses (a repo that is not `owner/name`) leaves the
 * draft as typed and shows the reason.
 */
export default function ProjectContract(props: {
  project: string;
  contract: Contract;
  /** The agent, account and model picker, which the pane wires to the agent
   *  catalogue; it saves through `set` so a refusal shows here like any other. */
  workersOn: (set: (patch: ContractPatch) => void) => JSX.Element;
  onSet: (patch: ContractPatch) => Promise<unknown>;
  /** Whether the issue sources hold unsaved edits. */
  onDirty?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = createSignal<IssueQuery[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [choosing, setChoosing] = createSignal(false);

  // Keyed on the saved list, so saving a choice above leaves a half-typed draft alone.
  const discard = () => {
    setDraft(props.contract.issues.map((q) => ({ ...q })));
    setError(null);
  };
  createEffect(
    on(
      () => [props.project, JSON.stringify(props.contract.issues)],
      () => {
        discard();
        setChoosing(false);
      },
    ),
  );

  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(props.contract.issues);
  createEffect(() => props.onDirty?.(dirty()));
  const edit = (at: number, change: Partial<IssueQuery>) =>
    setDraft((prev) => prev.map((q, i) => (i === at ? { ...q, ...change } : q)));

  const set = (patch: ContractPatch) => {
    setError(null);
    props.onSet(patch).catch((e) => setError(String(e)));
  };

  const saveSources = () => {
    setSaving(true);
    setError(null);
    props
      .onSet({ issues: draft() })
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  };

  // A label over a full-width control: the choices are sentences, and a
  // segmented strip shows both at once where a menu would hide one.
  const stacked = (label: string, control: JSX.Element) => (
    <div class={own.stacked}>
      <span class={styles.label}>{label}</span>
      {control}
    </div>
  );
  const choice = <T extends string>(label: string, options: SelectOption[], value: T, pick: (v: T) => void) =>
    stacked(
      label,
      <SegmentedControl
        class={own.strip}
        aria-label={label}
        options={options}
        value={value}
        onChange={(v) => pick(v as T)}
      />,
    );

  return (
    <div>
      {choice("How work ships", SHIPS, props.contract.ships, (ships) => set({ ships }))}
      {choice("How far it goes", AUTONOMY, props.contract.autonomy, (autonomy) => set({ autonomy }))}
      {choice("Picking up work", PICKUP, props.contract.pickup, (pickup) => set({ pickup }))}
      {stacked(
        "Workers run on",
        <Show
          when={props.contract.agent || choosing()}
          fallback={
            <div class={own.unsetRow}>
              <span class={own.unset}>Not set</span>
              <Button size="sm" onClick={() => setChoosing(true)}>
                Choose
              </Button>
            </div>
          }
        >
          {props.workersOn(set)}
        </Show>,
      )}

      <div class={own.sources}>
        <div class={own.sourcesHead}>
          <span class={styles.label}>Issue sources</span>
          <span class={own.sourcesNote}>Where autopilot looks for work. Empty fields match anything.</span>
        </div>
        <Show
          when={draft().length}
          fallback={<p class={styles.note}>None: the issues assigned to you in this project's repo.</p>}
        >
          <For each={draft()}>
            {(query, at) => {
              const field = (label: string, value: () => string, change: (v: string) => Partial<IssueQuery>) => (
                <label class={own.field}>
                  <span>{label}</span>
                  <input
                    class={`${styles.input} ${own.fieldInput}`}
                    value={value()}
                    placeholder="Any"
                    onChange={(e) => edit(at(), change(e.currentTarget.value))}
                    aria-label={`Source ${at() + 1} ${label.toLowerCase()}`}
                    spellcheck={false}
                  />
                </label>
              );
              return (
                <fieldset class={own.source} aria-label={`Source ${at() + 1}`}>
                  <div class={own.sourceHead}>
                    <span class={own.sourceTitle}>{query.repo || "New source"}</span>
                    <Button size="sm" onClick={() => setDraft((prev) => prev.filter((_, i) => i !== at()))}>
                      Remove source
                    </Button>
                  </div>
                  <div class={own.fields}>
                    {field(
                      "Repo",
                      () => query.repo,
                      (v) => ({ repo: v.trim() }),
                    )}
                    {field(
                      "Labels",
                      () => query.labels.join(", "),
                      (v) => ({ labels: list(v) }),
                    )}
                    {field(
                      "Exclude labels",
                      () => query.exclude_labels.join(", "),
                      (v) => ({ exclude_labels: list(v) }),
                    )}
                    {field(
                      "Milestone",
                      () => query.milestone ?? "",
                      (v) => ({ milestone: optional(v) }),
                    )}
                    {field(
                      "Assignee",
                      () => query.assignee ?? "",
                      (v) => ({ assignee: optional(v) }),
                    )}
                    {field(
                      "Extra",
                      () => query.extra ?? "",
                      (v) => ({ extra: optional(v) }),
                    )}
                  </div>
                </fieldset>
              );
            }}
          </For>
        </Show>
        <p class={styles.note}>
          Labels are comma separated and all must match. Assignee left empty is you, <code>any</code> is anyone. Extra
          is raw GitHub search qualifiers. Once set, sources replace the project's own repo.
        </p>
        <Show when={error()}>
          {(message) => (
            <p class={own.error} role="alert">
              {message()}
            </p>
          )}
        </Show>
        <div class={own.sourceActions}>
          <Button size="sm" onClick={() => setDraft((prev) => [...prev, emptyQuery()])}>
            Add source
          </Button>
          <span class={own.sourceCount}>
            {draft().length} {draft().length === 1 ? "source" : "sources"}
            <Show when={dirty()}>
              <span class={own.unsaved}>Unsaved changes</span>
            </Show>
          </span>
          <Show when={dirty()}>
            <Button size="sm" disabled={saving()} onClick={discard}>
              Discard
            </Button>
          </Show>
          <Button size="sm" variant="primary" disabled={!dirty() || saving()} onClick={saveSources}>
            {saving() ? "Saving" : "Save sources"}
          </Button>
        </div>
      </div>
    </div>
  );
}
