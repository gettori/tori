import { createSignal, For, Show } from "solid-js";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import { DEFAULT_ATTACH_PORT, isPort, type DebugTarget, type TargetKind } from "../../utils/debugTargets";

// The visible line above each field is also its accessible name, rather than an
// `aria-label` repeating that line, so the two cannot drift apart (the
// convention `NewProjectDialog` set in #99). Static ids: only one of these can
// be open at a time.
const SCRIPT_LABEL = "debug-target-script-label";
const PORT_LABEL = "debug-target-port-label";

// Which of the three things "debug" means, in one dialog with a mode picker
// rather than three palette rows each firing its own prompt chain
// (lesson_menu_items_into_mode_picker_dialog). They act on the same workspace
// and differ by a parameter, which is exactly that shape: the modes are visible
// side by side, only the field the mode needs is shown, and Start is gated on
// per-mode validity.
//
// The shell is `Dialog`. Enter stays here, through its `onKeyDown`, and this is
// the dialog that motivated that seam: in file mode there is no field to focus,
// so focus sits on the panel itself, where no control would answer the key. The
// Start button cannot answer it either while a mode is blocked, since it is
// `disabled` and a disabled button is never clicked. Escape does not stay here:
// Kobalte reports it as `onClose`.
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
    if (e.key !== "Enter") return;
    e.preventDefault();
    confirm();
  }

  const segs: { value: TargetKind; label: string }[] = [
    { value: "file", label: "This file" },
    { value: "script", label: "Package script" },
    { value: "attach", label: "Attach" },
  ];

  return (
    <Dialog
      open
      title="Start debugging"
      onClose={() => props.onCancel()}
      onKeyDown={onKeyDown}
      initialFocus={() => first}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!!blocker()} onClick={() => confirm()}>
            Start
          </Button>
        </>
      }
    >
      <SegmentedControl
        aria-label="What to debug"
        options={segs}
        value={kind()}
        onChange={setKind}
      />

      <Show when={kind() === "file"}>
        <div class={styles.msg}>
          {props.filePath
            ? `Runs ${props.filePath} under node, stopping on your breakpoints.`
            : "No file is open."}
        </div>
      </Show>

      <Show when={kind() === "script"}>
        <div id={SCRIPT_LABEL} class={styles.label}>Script</div>
        <Show
          when={props.scripts.length}
          fallback={<div class={styles.msg}>No scripts in this project's package.json.</div>}
        >
          <select
            ref={(el) => (first = el)}
            class={styles.input}
            aria-labelledby={SCRIPT_LABEL}
            value={script()}
            onChange={(e) => setScript(e.currentTarget.value)}
          >
            <For each={props.scripts}>{(name) => <option value={name}>{name}</option>}</For>
          </select>
        </Show>
      </Show>

      <Show when={kind() === "attach"}>
        <div id={PORT_LABEL} class={styles.label}>Inspector port</div>
        <input
          ref={(el) => (first = el)}
          class={styles.input}
          aria-labelledby={PORT_LABEL}
          value={port()}
          inputmode="numeric"
          placeholder={String(DEFAULT_ATTACH_PORT)}
          onInput={(e) => setPort(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
        <div class={styles.msg}>
          The target must already be running with <code>--inspect</code>. Sway attaches to it and
          leaves it running when you stop.
        </div>
      </Show>

      <Show when={blocker()}>{(why) => <div class={styles.hint}>{why()}</div>}</Show>
    </Dialog>
  );
}
