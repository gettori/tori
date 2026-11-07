import { createMemo, createSignal, For, Show } from "solid-js";
import Button from "../Button/Button";
import Checkbox from "../Checkbox/Checkbox";
import Select from "../Select/Select";
import {
  hiddenAfter,
  rowProblems,
  spaceChoices,
  spaceProblem,
  type Plan,
  type RootScan,
  type Row,
} from "../../utils/grouping";
import styles from "./GroupProjects.module.css";

const HOME = "";
const KIND: Record<Row["kind"], string> = { plain: "folder", clone: "git clone", bare: "bare repo" };

export const HOME_NOTE = "Projects you don't group are attached to Home, where you can move them into a space later.";

export default function GroupProjects(props: { scan: RootScan; plan: Plan; onPlan: (plan: Plan) => void }) {
  const [newSpace, setNewSpace] = createSignal("");
  const choices = createMemo(() => spaceChoices(props.scan, props.plan));
  const problems = createMemo(() => rowProblems(props.scan, props.plan));
  const hidden = createMemo(() => hiddenAfter(props.scan, props.plan));
  const emptyFolders = createMemo(() => [...new Set([...hidden(), ...props.plan.keepEmpty])].sort());
  const newProblem = () => (newSpace().trim() ? spaceProblem(props.scan, newSpace()) : null);
  const skipped = () => [
    ...props.scan.tooBig.map((p) => `${p} (too big to scan)`),
    ...props.scan.tooDeep.map((p) => `${p} (too deep)`),
    ...props.scan.unreadable.map((p) => `${p} (can't be read)`),
  ];

  const setRow = (path: string, patch: Partial<Row>) =>
    props.onPlan({ ...props.plan, rows: props.plan.rows.map((r) => (r.path === path ? { ...r, ...patch } : r)) });

  function addSpace() {
    const name = newSpace().trim();
    if (!name || newProblem()) return;
    props.onPlan({ ...props.plan, extraSpaces: [...props.plan.extraSpaces, name] });
    setNewSpace("");
  }

  function keepEmpty(name: string, keep: boolean) {
    const rest = props.plan.keepEmpty.filter((n) => n !== name);
    props.onPlan({ ...props.plan, keepEmpty: keep ? [...rest, name] : rest });
  }

  const options = () => [
    { value: HOME, label: "Home (stays where it is)" },
    ...choices().map((name) => ({ value: name, label: name })),
  ];

  return (
    <div class={styles.group}>
      <p class={styles.lead}>{HOME_NOTE}</p>

      <div class={styles.rows}>
        <span class={styles.head}>Project</span>
        <span class={styles.head}>Name in the space</span>
        <span class={styles.head}>Space</span>
        <For each={props.plan.rows}>
          {(row) => (
            <>
              <div class={styles.where}>
                <span>{row.relative.split("/").pop()}</span>
                <span class={styles.path} title={row.path}>
                  {row.relative}, {KIND[row.kind]}
                </span>
              </div>
              <input
                class={styles.input}
                aria-label={`Name for ${row.relative}`}
                value={row.name}
                disabled={!row.space}
                spellcheck={false}
                onInput={(e) => setRow(row.path, { name: e.currentTarget.value })}
              />
              <Select
                aria-label={`Space for ${row.relative}`}
                options={options()}
                value={row.space ?? HOME}
                onChange={(v) => setRow(row.path, { space: v === HOME ? null : v })}
              />
              <Show when={problems().get(row.path)}>{(why) => <span class={styles.problem}>{why()}</span>}</Show>
            </>
          )}
        </For>
      </div>

      <div class={styles.section}>
        <h3 class={styles.sectionTitle}>New space</h3>
        <div class={styles.addRow}>
          <input
            class={styles.input}
            aria-label="New space name"
            placeholder="work"
            value={newSpace()}
            spellcheck={false}
            onInput={(e) => setNewSpace(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              addSpace();
            }}
          />
          <Button disabled={!newSpace().trim() || !!newProblem()} onClick={addSpace}>
            Add space
          </Button>
        </div>
        <Show when={newProblem()}>{(why) => <span class={styles.problem}>{why()}</span>}</Show>
      </div>

      <Show when={emptyFolders().length > 0}>
        <div class={styles.section}>
          <h3 class={styles.sectionTitle}>Folders with no projects</h3>
          <For each={emptyFolders()}>
            {(name) => (
              <Checkbox
                checked={!props.plan.keepEmpty.includes(name)}
                onChange={(hide) => keepEmpty(name, !hide)}
                label={`Hide ${name}: it isn't a space`}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={skipped().length > 0}>
        <div class={styles.section}>
          <h3 class={styles.sectionTitle}>Skipped</h3>
          <ul class={styles.list}>
            <For each={skipped()}>{(line) => <li>{line}</li>}</For>
          </ul>
        </div>
      </Show>

      <div class={styles.section}>
        <h3 class={styles.sectionTitle}>What moves</h3>
        <Show
          when={props.plan.rows.some((r) => r.space)}
          fallback={<p class={styles.lead}>Nothing moves. Every project stays where it is.</p>}
        >
          <ul class={styles.list}>
            <For each={props.plan.rows.filter((r) => r.space)}>
              {(r) => (
                <li>
                  {r.relative} -&gt; {r.space}/{r.name.trim()}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
