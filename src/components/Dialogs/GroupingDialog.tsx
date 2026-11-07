import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import GroupProjects from "../GroupProjects/GroupProjects";
import { applyPlan, initialPlan, rowProblems, scanFits, type Plan, type RootScan } from "../../utils/grouping";
import styles from "./Dialogs.module.css";

export default function GroupingDialog(props: {
  base: string;
  onDone: (warnings: string[]) => void;
  onCancel: () => void;
}) {
  const [scan, setScan] = createSignal<RootScan | null>(null);
  const [plan, setPlan] = createSignal<Plan | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    invoke<RootScan>("scan_root", { path: props.base })
      .then((s) => {
        setScan(s);
        if (!s.refused) setPlan(initialPlan(s));
      })
      .catch((e) => setError(String(e)));
  });

  const canApply = () => {
    const s = scan();
    const p = plan();
    return !busy() && !!s && !!p && p.rows.length > 0 && rowProblems(s, p).size === 0;
  };

  async function apply() {
    const s = scan();
    const p = plan();
    if (!s || !p || !canApply()) return;
    setBusy(true);
    setError(null);
    try {
      const done = await applyPlan(s, p, { setRoot: false });
      props.onDone(done.warnings);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="sheet"
      title="Sort projects into spaces"
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!canApply()} onClick={() => void apply()}>
            Apply
          </Button>
        </>
      }
    >
      <Show when={error()}>{(e) => <div class={styles.error}>{e()}</div>}</Show>
      <Show when={scan()} fallback={<Show when={!error()}>Reading the base folder...</Show>}>
        {(s) => (
          <Show
            when={!scanFits(s()) && plan()}
            fallback={<p>{s().refused ?? "Every project here is already in a space."}</p>}
          >
            {(p) => <GroupProjects scan={s()} plan={p()} onPlan={setPlan} />}
          </Show>
        )}
      </Show>
    </Dialog>
  );
}
