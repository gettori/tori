import { createSignal, onMount, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import { DEFAULT_ATTACH_PORT, isPort, type DebugTarget, type TargetKind } from "../../utils/debugTargets";

// Which of the three things "debug" means, in one dialog with a mode picker
// rather than three palette rows each firing its own prompt chain
// (lesson_menu_items_into_mode_picker_dialog). They act on the same workspace
// and differ by a parameter, which is exactly that shape: the modes are visible
// side by side, only the field the mode needs is shown, and Start is gated on
// per-mode validity.
//
// Enter starts, Escape or a backdrop click cancels.
export default function DebugTargetDialog(props: {
  /** Which tab to open on. The palette's three rows each name one. */
  kind: TargetKind;
  /** The active editor file, or null when nothing is open. */
  filePath: string | null;
  /** Script names from the resolved root's `package.json`, in declaration
   *  order. Empty when the root declares none, or has no `package.json`. */
  scripts: string[];
  /** The port this workspace last attached to, or node's own default. */
  port: number;
  onConfirm: (target: DebugTarget) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = createSignal<TargetKind>(props.kind);
  const [script, setScript] = createSignal(props.scripts[0] ?? "");
  const [port, setPort] = createSignal(String(props.port || DEFAULT_ATTACH_PORT));
  let first: HTMLElement | undefined;

  onMount(() => requestAnimationFrame(() => first?.focus()));

  const portNumber = () => Number(port().trim());

  /** Why Start is unavailable, or null. Shown rather than merely disabling, so
   *  an empty picker says what is missing instead of looking broken. */
  function blocker(): string | null {
    switch (kind()) {
      case "file":
        return props.filePath ? null : "Open a file to debug it.";
      case "script":
        if (!props.scripts.length) return "This project declares no package scripts.";
        return script() ? null : "Pick a script.";
      case "attach":
        return isPort(portNumber())
          ? null
          : "Enter a port between 1024 and 65535 (node's default is 9229).";
    }
  }

  function target(): DebugTarget | null {
    switch (kind()) {
      case "file":
        return props.filePath ? { kind: "file", path: props.filePath } : null;
      case "script":
        return script() ? { kind: "script", script: script() } : null;
      case "attach":
        return isPort(portNumber()) ? { kind: "attach", port: portNumber() } : null;
    }
  }

  function confirm() {
    const t = target();
    if (t) props.onConfirm(t);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  }

  const segs: { value: TargetKind; label: string }[] = [
    { value: "file", label: "This file" },
    { value: "script", label: "Package script" },
    { value: "attach", label: "Attach" },
  ];

  return (
    <Portal>
      <div class={styles.modalBackdrop} onMouseDown={() => props.onCancel()}>
        <div class={styles.modal} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class={styles.modalTitle}>Start debugging</div>

          <SegmentedControl
            aria-label="What to debug"
            options={segs}
            value={kind()}
            onChange={setKind}
          />

          <Show when={kind() === "file"}>
            <div class={styles.modalMsg}>
              {props.filePath
                ? `Runs ${props.filePath} under node, stopping on your breakpoints.`
                : "No file is open."}
            </div>
          </Show>

          <Show when={kind() === "script"}>
            <div class={styles.modalLabel}>Script</div>
            <Show
              when={props.scripts.length}
              fallback={<div class={styles.modalMsg}>No scripts in this project's package.json.</div>}
            >
              <select
                ref={(el) => (first = el)}
                class={styles.modalInput}
                value={script()}
                onChange={(e) => setScript(e.currentTarget.value)}
              >
                <For each={props.scripts}>{(name) => <option value={name}>{name}</option>}</For>
              </select>
            </Show>
          </Show>

          <Show when={kind() === "attach"}>
            <div class={styles.modalLabel}>Inspector port</div>
            <input
              ref={(el) => (first = el)}
              class={styles.modalInput}
              value={port()}
              inputmode="numeric"
              placeholder={String(DEFAULT_ATTACH_PORT)}
              onInput={(e) => setPort(e.currentTarget.value)}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
            />
            <div class={styles.modalMsg}>
              The target must already be running with <code>--inspect</code>. Sway attaches to it and
              leaves it running when you stop.
            </div>
          </Show>

          <Show when={blocker()}>{(why) => <div class={styles.modalHint}>{why()}</div>}</Show>

          <div class={styles.modalActions}>
            <Button onClick={() => props.onCancel()}>Cancel</Button>
            <Button variant="primary" disabled={!!blocker()} onClick={() => confirm()}>
              Start
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
