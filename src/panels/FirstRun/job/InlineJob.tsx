import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import TerminalView, { type PtyExit } from "../../Terminal/TerminalView";
import type { OpenJob } from "../../../utils/events";
import { runExitEffects } from "../../../utils/jobExit";
import InlineJobFrame, { type JobState } from "./InlineJobFrame";
import styles from "./InlineJob.module.css";

/**
 * A job run in place, in a terminal of its own, rather than as a dock tab.
 *
 * Never through `OPEN_JOB`: that opens a dock tab behind the modal, and the
 * Settings panel closes itself on it.
 */
export default function InlineJob(props: {
  job: OpenJob;
  okLine: string;
  onCancel: () => void;
  onState?: (state: JobState) => void;
}) {
  const [attempt, setAttempt] = createSignal(1);
  const [state, setState] = createSignal<JobState>("running");
  const [code, setCode] = createSignal<number | null>(null);
  const [listening, setListening] = createSignal(false);
  // Fresh per attempt: `pty_spawn` re-subscribes to a live id instead of
  // spawning, and the dock's tab for the same job already owns the bare one.
  const ptyId = () => `firstrun:${props.job.id}:${attempt()}`;

  function report(next: JobState) {
    setState(next);
    props.onState?.(next);
  }

  let exited = false;
  let disposed = false;
  const offs: UnlistenFn[] = [];
  const keep = (off: UnlistenFn) => (disposed ? off() : offs.push(off));
  onCleanup(() => {
    disposed = true;
    offs.forEach((off) => off());
  });

  let frameEl: HTMLDivElement | undefined;

  onMount(async () => {
    // It mounts under a list that can already fill the pane.
    frameEl?.scrollIntoView?.({ block: "nearest" });
    report("running");
    keep(
      await listen<PtyExit>("pty://exit", (e) => {
        if (e.payload.id !== ptyId() || exited) return;
        exited = true;
        const id = e.payload.id;
        const code = e.payload.code;
        setCode(code);
        // Settles after the re-probe, so the success line and the rows above
        // it read the same answer, and nothing moves on before they do.
        void runExitEffects(props.job, code).then(() => {
          if (!disposed && id === ptyId()) report(code === 0 ? "ok" : "fail");
        });
      }),
    );
    keep(
      await listen<{ id: string; state: "active" | "quiet" }>("pty://activity", (e) => {
        if (e.payload.id !== ptyId() || exited) return;
        report(e.payload.state === "quiet" ? "waiting" : "running");
      }),
    );
    // Only now: a program that cannot start reports its exit at spawn, before
    // a listener attached after it would hear anything.
    if (!disposed) setListening(true);
  });

  function cancel() {
    invoke("pty_kill", { id: ptyId() }).catch(() => {});
    props.onCancel();
  }

  function retry() {
    exited = false;
    setCode(null);
    setAttempt((n) => n + 1);
    report("running");
  }

  return (
    <InlineJobFrame
      command={[props.job.program, ...props.job.args].join(" ")}
      state={state()}
      code={code()}
      okLine={props.okLine}
      failLine={`${props.job.title} did not finish. The output above says why.`}
      onCancel={cancel}
      onRetry={retry}
      ref={(el) => (frameEl = el)}
    >
      <Show when={listening() && ptyId()} keyed>
        {(id) => (
          <div class={styles.terminal}>
            <TerminalView
              id={id}
              cwd={props.job.cwd}
              kind="command"
              program={props.job.program}
              args={props.job.args}
              env={props.job.env}
              active
              autoFocus={!!props.job.interactive}
              hotkeys={false}
            />
          </div>
        )}
      </Show>
    </InlineJobFrame>
  );
}
