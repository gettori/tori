import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import SegmentedControl from "../SegmentedControl/SegmentedControl";
import Select from "../Select/Select";
import {
  DEFAULT_ATTACH_PORT,
  defaultKind,
  GO_ADAPTER,
  isModuleName,
  isPort,
  JS_ADAPTER,
  kindsFor,
  LLDB_ADAPTER,
  PYTHON_ADAPTER,
  type DebugTarget,
  type LldbPick,
  type TargetKind,
} from "../../utils/debugTargets";

// The visible line above each field is also its accessible name, rather than an
// `aria-label` repeating that line, so the two cannot drift apart (the
// convention `NewProjectDialog` set in #99). Static ids: only one of these can
// be open at a time.
const ADAPTER_LABEL = "debug-target-adapter-label";
const SCRIPT_LABEL = "debug-target-script-label";
const PORT_LABEL = "debug-target-port-label";
const MODULE_LABEL = "debug-target-module-label";
const BIN_LABEL = "debug-target-bin-label";
const PROGRAM_LABEL = "debug-target-program-label";

const KIND_LABELS: Record<TargetKind, string> = {
  file: "This file",
  script: "Package script",
  attach: "Attach",
  module: "Module",
  pytest: "pytest",
  package: "This package",
  test: "Package tests",
  cargo: "Cargo binary",
  program: "Program",
};

// Which of an adapter's kinds "debug" means, in one dialog with a mode picker
// rather than a palette row per kind each firing its own prompt chain
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
  /** The debuggers to choose among. One when the active file or the palette
   *  row already decided it, and then there is nothing to choose. */
  adapters: readonly { id: string; label: string }[];
  /** Which tab to open on, or null for the adapter's own default. A palette
   *  row names one. */
  kind: TargetKind | null;
  /** The active editor file, or null when nothing is open. */
  filePath: string | null;
  /** The adapter that runs `filePath`, or null when none does. */
  fileAdapter: string | null;
  /** Script names from the resolved root's `package.json`, in declaration
   *  order. Empty when the root declares none, or has no `package.json`. */
  scripts: string[];
  /** The port this workspace last attached to, or node's own default. */
  port: number;
  /** Where an lldb-dap target would run, and the Cargo binaries there. */
  lldb: LldbPick;
  onConfirm: (target: DebugTarget) => void;
  onCancel: () => void;
}) {
  const [adapterId, setAdapterId] = createSignal(props.adapters[0]?.id ?? "");
  const adapterLabel = () => props.adapters.find((a) => a.id === adapterId())?.label ?? adapterId();
  const runner = () => (adapterId() === JS_ADAPTER ? "node" : adapterLabel());
  const runnableFile = () => (props.fileAdapter === adapterId() ? props.filePath : null);
  const has = () => ({ file: !!runnableFile(), bins: props.lldb.bins.length > 0 });
  const fileMessage = (runs: (file: string) => string) => {
    const f = runnableFile();
    if (f) return runs(f);
    return props.filePath ? `${props.filePath} is not a file ${adapterLabel()} runs.` : "No file is open.";
  };
  const [kind, setKind] = createSignal<TargetKind | null>(
    props.kind && kindsFor(adapterId()).includes(props.kind)
      ? props.kind
      : defaultKind(adapterId(), has()),
  );
  const [script, setScript] = createSignal(props.scripts[0] ?? "");
  const [port, setPort] = createSignal(String(props.port || DEFAULT_ATTACH_PORT));
  const [module, setModule] = createSignal("");
  const [bin, setBin] = createSignal(props.lldb.bins[0] ?? "");
  const [program, setProgram] = createSignal("");
  let first: HTMLElement | undefined;

  const portNumber = () => Number(port().trim());

  /** Why Start is unavailable, or null. Shown rather than merely disabling, so
   *  an empty picker says what is missing instead of looking broken. */
  function blocker(): string | null {
    switch (kind()) {
      case null:
        return `Tori cannot start ${adapterLabel()} programs from here yet.`;
      case "file":
      case "pytest":
      case "package":
      case "test":
        if (runnableFile()) return null;
        return props.filePath ? "Open a file this debugger runs." : "Open a file to debug it.";
      case "script":
        if (!props.scripts.length) return "This project declares no package scripts.";
        return script() ? null : "Pick a script.";
      case "attach":
        return isPort(portNumber())
          ? null
          : "Enter a port between 1024 and 65535 (node's default is 9229).";
      case "module":
        return isModuleName(module().trim()) ? null : "Enter a module name, like app.main.";
      case "cargo":
        return bin() ? null : (props.lldb.error ?? "No Cargo package with a binary here.");
      case "program":
        return program().trim() ? null : "Enter the path of a program built with debug info.";
    }
  }

  function target(): DebugTarget | null {
    const f = runnableFile();
    const id = adapterId();
    switch (kind()) {
      case null:
        return null;
      case "file":
        if (!f) return null;
        return id === PYTHON_ADAPTER
          ? { adapterId: id, kind: "file", path: f }
          : { adapterId: JS_ADAPTER, kind: "file", path: f };
      case "script":
        return script() ? { adapterId: JS_ADAPTER, kind: "script", script: script() } : null;
      case "attach":
        return isPort(portNumber()) ? { adapterId: JS_ADAPTER, kind: "attach", port: portNumber() } : null;
      case "module":
        return isModuleName(module().trim())
          ? { adapterId: PYTHON_ADAPTER, kind: "module", module: module().trim() }
          : null;
      case "pytest":
        return f ? { adapterId: PYTHON_ADAPTER, kind: "pytest", path: f } : null;
      case "package":
        return f ? { adapterId: GO_ADAPTER, kind: "package", path: f } : null;
      case "test":
        return f ? { adapterId: GO_ADAPTER, kind: "test", path: f } : null;
      case "cargo":
        return bin() ? { adapterId: LLDB_ADAPTER, kind: "cargo", dir: props.lldb.root, bin: bin() } : null;
      case "program": {
        const p = program().trim();
        if (!p) return null;
        return { adapterId: LLDB_ADAPTER, kind: "program", program: p.startsWith("/") ? p : `${props.lldb.root}/${p}` };
      }
    }
  }

  async function pickProgram() {
    const picked = await invoke<string | null>("dap_pick_program", { root: props.lldb.root }).catch(() => null);
    if (picked) setProgram(picked);
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

  const segs = () => kindsFor(adapterId()).map((value) => ({ value, label: KIND_LABELS[value] }));

  function chooseAdapter(id: string) {
    setAdapterId(id);
    setKind(defaultKind(id, has()));
  }

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
      <Show when={props.adapters.length > 1}>
        <div id={ADAPTER_LABEL} class={styles.label}>Debugger</div>
        <Select
          class={styles.fill}
          aria-labelledby={ADAPTER_LABEL}
          options={props.adapters.map((a) => ({ value: a.id, label: a.label }))}
          value={adapterId()}
          onChange={chooseAdapter}
        />
      </Show>

      <Show when={kind()}>
        {(k) => (
          <SegmentedControl aria-label="What to debug" options={segs()} value={k()} onChange={setKind} />
        )}
      </Show>

      <Show when={kind() === "file"}>
        <div class={styles.msg}>
          {fileMessage((f) => `Runs ${f} under ${runner()}, stopping on your breakpoints.`)}
        </div>
      </Show>

      <Show when={kind() === "pytest"}>
        <div class={styles.msg}>{fileMessage((f) => `Runs pytest on ${f}, stopping on your breakpoints.`)}</div>
      </Show>

      <Show when={kind() === "package"}>
        <div class={styles.msg}>
          {fileMessage(() => "Builds the package this file is in and runs it, stopping on your breakpoints.")}
        </div>
      </Show>

      <Show when={kind() === "test"}>
        <div class={styles.msg}>
          {fileMessage(() => "Runs the tests of the package this file is in, stopping on your breakpoints.")}
        </div>
      </Show>

      <Show when={kind() === "cargo" && props.lldb.bins.length > 0}>
        <Show
          when={props.lldb.bins.length > 1}
          fallback={<div class={styles.msg}>Builds {bin()} with cargo, then debugs it.</div>}
        >
          <div id={BIN_LABEL} class={styles.label}>Binary</div>
          <Select
            ref={(el) => (first = el)}
            class={styles.fill}
            aria-labelledby={BIN_LABEL}
            options={props.lldb.bins.map((name) => ({ value: name, label: name }))}
            value={bin()}
            onChange={setBin}
          />
          <div class={styles.msg}>Builds it with cargo, then debugs it.</div>
        </Show>
      </Show>

      <Show when={kind() === "program"}>
        <div id={PROGRAM_LABEL} class={styles.label}>Program</div>
        <div class={styles.fieldRow}>
          <input
            ref={(el) => (first = el)}
            class={styles.fieldInput}
            aria-labelledby={PROGRAM_LABEL}
            value={program()}
            placeholder="build/app"
            onInput={(e) => setProgram(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
          <Button onClick={() => void pickProgram()}>Choose</Button>
        </div>
        <div class={styles.msg}>
          A program built with debug info (<code>-g</code>). A relative path starts from{" "}
          <code>{props.lldb.root}</code>.
        </div>
      </Show>

      <Show when={kind() === "module"}>
        <div id={MODULE_LABEL} class={styles.label}>Module</div>
        <input
          ref={(el) => (first = el)}
          class={styles.input}
          aria-labelledby={MODULE_LABEL}
          value={module()}
          placeholder="app.main"
          onInput={(e) => setModule(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
        <div class={styles.msg}>Runs it the way <code>python -m</code> does, stopping on your breakpoints.</div>
      </Show>

      <Show when={kind() === "script"}>
        <div id={SCRIPT_LABEL} class={styles.label}>Script</div>
        <Show
          when={props.scripts.length}
          fallback={<div class={styles.msg}>No scripts in this project's package.json.</div>}
        >
          <Select
            ref={(el) => (first = el)}
            class={styles.fill}
            aria-labelledby={SCRIPT_LABEL}
            options={props.scripts.map((name) => ({ value: name, label: name }))}
            value={script()}
            onChange={setScript}
          />
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
          The target must already be running with <code>--inspect</code>. Tori attaches to it and
          leaves it running when you stop.
        </div>
      </Show>

      <Show when={blocker()}>{(why) => <div class={styles.hint}>{why()}</div>}</Show>
    </Dialog>
  );
}
