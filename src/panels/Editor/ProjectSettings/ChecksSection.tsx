import { createEffect, createMemo, createSignal, createUniqueId, on } from "solid-js";

import Button from "../../../components/Button/Button";
import { emitWith, TOAST, type ToastEvent } from "../../../utils/events";
import { projectChecks, setProjectChecks } from "../../../utils/verification";
import { settings } from "../../Settings/settingsStore";
import styles from "./ProjectSettingsView.module.css";

const toast = (message: string) => emitWith<ToastEvent>(TOAST, { message, kind: "error" });

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The commands that count as a check in one project, one per line.
 *
 * A saved list replaces the built-in one for this project rather than adding
 * to it, which is why the field opens on the list in force: editing it loses
 * nothing, and Reset to defaults is the way back.
 */
export default function ChecksSection(props: { projectPath: string }) {
  const listLabel = createUniqueId();
  const [inForce, setInForce] = createSignal<string[]>([]);
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // Reread when this project's stored list changes by content, so a save or
  // reset lands back in the field, but an unrelated save (which hands back a
  // fresh array) does not overwrite what is being typed.
  const storedKey = createMemo(() => JSON.stringify(settings.verification.commands[props.projectPath] ?? null));
  createEffect(
    on(
      () => [props.projectPath, storedKey()] as const,
      ([path]) =>
        void projectChecks(path)
          .then((commands) => {
            setInForce(commands);
            setText(commands.join("\n"));
          })
          .catch((e) => toast(String(e))),
    ),
  );

  const own = () => !!settings.verification.commands[props.projectPath]?.length;
  const dirty = () => lines(text()).join("\n") !== inForce().join("\n");

  async function write(commands: string[]) {
    setBusy(true);
    try {
      await setProjectChecks(props.projectPath, commands);
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class={styles.form}>
      <section class={styles.block}>
        <h3 id={listLabel} class={styles.blockHead}>
          Verification commands
        </h3>
        <p class={styles.note}>
          One command per line. A turn that changed code is verified when the last of these it ran after its last edit
          passed. A command matches with any arguments after it, and through wrappers like npx or uv run.
        </p>
        <textarea
          class={styles.textarea}
          aria-labelledby={listLabel}
          rows={12}
          spellcheck={false}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <div class={styles.actions}>
          <span class={styles.actionHint}>{own() ? "This project's own list" : "The built-in list"}</span>
          <Button disabled={!own() || busy()} onClick={() => void write([])}>
            Reset to defaults
          </Button>
          <Button
            variant="primary"
            disabled={!dirty() || !lines(text()).length || busy()}
            onClick={() => void write(lines(text()))}
          >
            Save
          </Button>
        </div>
      </section>
    </div>
  );
}
