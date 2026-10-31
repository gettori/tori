import { Show, createSignal } from "solid-js";
import styles from "./shell.module.css";

export type Ask = {
  title: string;
  message?: string;
  input?: { label: string; value: string };
  confirm: string;
  danger?: boolean;
  run: (value: string) => Promise<unknown>;
  onClose?: () => void;
};

export default function AskSheet(props: { ask: Ask; onDone: () => void }) {
  const [value, setValue] = createSignal(props.ask.input?.value ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const done = () => {
    props.ask.onClose?.();
    props.onDone();
  };
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.ask.run(value().trim());
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div class={styles.dim} onClick={done} />
      <section class={styles.sheet} role="dialog" aria-label={props.ask.title}>
        <span class={styles.grabber} />
        <header class={styles.sheetHead}>
          <span class={styles.sheetTitle}>{props.ask.title}</span>
          <button class={styles.done} onClick={done}>
            Cancel
          </button>
        </header>
        <div class={styles.sheetBody}>
          <Show when={error()}>
            <p class={styles.banner}>{error()}</p>
          </Show>
          <Show when={props.ask.message}>
            <p class={styles.footnote}>{props.ask.message}</p>
          </Show>
          <Show when={props.ask.input}>
            {(input) => (
              <div class={styles.typedBody}>
                <label class={styles.field}>
                  {input().label}
                  <input
                    value={value()}
                    onInput={(e) => setValue(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy()) void go();
                    }}
                  />
                </label>
              </div>
            )}
          </Show>
          <ul class={styles.group}>
            <li>
              <button
                class={`${styles.item} ${styles.setting} ${props.ask.danger ? styles.disconnect : ""}`}
                disabled={busy()}
                onClick={() => void go()}
              >
                {busy() ? "Working" : props.ask.confirm}
              </button>
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}
