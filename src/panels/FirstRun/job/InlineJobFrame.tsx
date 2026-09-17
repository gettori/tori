import { Match, Show, Switch, createSignal, type JSX } from "solid-js";
import { Check, X } from "lucide-solid";
import Icon from "../../../components/Icon/Icon";
import styles from "./InlineJob.module.css";

/** `waiting` is a running process that has gone quiet, which for a sign-in or
 *  an installer means it is sitting at a prompt. */
export type JobState = "running" | "waiting" | "ok" | "fail";

export default function InlineJobFrame(props: {
  command: string;
  state: JobState;
  /** The exit code on failure. Null is an exit the backend could not confirm. */
  code?: number | null;
  okLine: string;
  failLine: string;
  onCancel: () => void;
  onRetry: () => void;
  ref?: (el: HTMLDivElement) => void;
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const collapsed = () => props.state === "ok" && !open();

  return (
    <div ref={props.ref} class={styles.frame} data-state={props.state}>
      <Show when={collapsed()}>
        <div class={styles.row}>
          <Icon icon={Check} size={14} strokeWidth={2.5} />
          <span>{props.okLine}</span>
          <button type="button" class={styles.action} onClick={() => setOpen(true)}>
            Show output
          </button>
        </div>
      </Show>
      <Show when={!collapsed()}>
        <div class={styles.head}>
          <span class={styles.dot} aria-hidden="true" />
          <span class={styles.command}>{props.command}</span>
          <span class={styles.extras}>
            <Switch>
              <Match when={props.state === "fail"}>
                <span class={styles.exit}>{props.code == null ? "no exit code" : `exit ${props.code}`}</span>
                <button type="button" class={`${styles.action} ${styles.retry}`} onClick={() => props.onRetry()}>
                  Retry
                </button>
              </Match>
              <Match when={props.state === "ok"}>
                <button type="button" class={styles.action} onClick={() => setOpen(false)}>
                  Hide output
                </button>
              </Match>
              <Match when={props.state === "waiting" || props.state === "running"}>
                <Show when={props.state === "waiting"}>
                  <span class={styles.badge}>Needs input</span>
                </Show>
                <button type="button" class={styles.action} onClick={() => props.onCancel()}>
                  Cancel
                </button>
              </Match>
            </Switch>
          </span>
        </div>
      </Show>
      {/* Hidden rather than unmounted: the body can be a live terminal, and
          collapsing a success must keep its output for Show output. */}
      <div class={styles.output} hidden={collapsed()}>
        {props.children}
      </div>
      <Switch>
        <Match when={props.state === "waiting"}>
          <div class={styles.strip}>This panel has keyboard focus. Type here, then press return.</div>
        </Match>
        <Match when={props.state === "ok" && open()}>
          <div class={`${styles.row} ${styles.rowFoot}`}>
            <Icon icon={Check} size={14} strokeWidth={2.5} />
            <span>{props.okLine}</span>
            <button type="button" class={styles.action} onClick={() => setOpen(false)}>
              Hide output
            </button>
          </div>
        </Match>
        <Match when={props.state === "fail"}>
          <div class={`${styles.row} ${styles.rowFoot} ${styles.rowFail}`}>
            <Icon icon={X} size={14} strokeWidth={2.5} />
            <span>{props.failLine}</span>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

/** A plain-text body, so every state of the frame has a story without a PTY. */
export function StaticOutput(props: { lines: string[] }) {
  return <div class={styles.static}>{props.lines.join("\n")}</div>;
}
