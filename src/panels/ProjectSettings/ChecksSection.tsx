import { createEffect, createMemo, createResource, createSignal, on, Show } from "solid-js";

import Button from "../../components/Button/Button";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { builtInChecks, projectChecks, setProjectChecks } from "../../utils/verification";
import { settings } from "../Settings/settingsStore";
import { Section } from "./Section";
import styles from "./ProjectSettingsDialog.module.css";

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
 * to it, which is why the field opens on the list in force. Reset to defaults
 * only refills the field; like any edit it waits for Save, and saving the
 * built-in list as it is removes the project's own instead of copying it.
 */
export default function ChecksSection(props: { projectPath: string; onDirty?: (dirty: boolean) => void }) {
  const [inForce, setInForce] = createSignal<string[]>([]);
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [builtIn] = createResource(() => builtInChecks().catch(() => [] as string[]));

  // Reread when this project's stored list changes by content, so a save
  // lands back in the field, but an unrelated save (which hands back a fresh
  // array) does not overwrite what is being typed.
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
  const draft = () => lines(text());
  const dirty = () => draft().join("\n") !== inForce().join("\n");
  const isBuiltIn = () => draft().join("\n") === (builtIn() ?? []).join("\n");
  createEffect(() => props.onDirty?.(dirty()));

  const status = () => {
    if (!dirty()) return own() ? "This project uses its own list." : "This project uses the built-in list.";
    return isBuiltIn()
      ? "Unsaved. Saving goes back to the built-in list."
      : "Unsaved. Saving makes this the project's own list.";
  };

  async function save() {
    setBusy(true);
    try {
      await setProjectChecks(props.projectPath, isBuiltIn() ? [] : draft());
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      heading="Verification commands"
      meta={<span class={own() ? styles.badgeOn : styles.badge}>{own() ? "Project's own list" : "Built-in list"}</span>}
    >
      <div class={styles.wide}>
        <p class={styles.lede}>
          One command per line. A turn that changed code is verified when the last of these it ran after its last edit
          passed. A command matches with any arguments after it, and through wrappers like npx or uv run.
        </p>
        <textarea
          class={styles.textarea}
          classList={{ [styles.textareaDirty]: dirty() }}
          aria-label="Verification commands"
          rows={10}
          spellcheck={false}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <div class={styles.actions}>
          <span class={styles.actionHint} classList={{ [styles.unsaved]: dirty() }}>
            {status()}
          </span>
          <Button disabled={busy() || isBuiltIn()} onClick={() => setText((builtIn() ?? []).join("\n"))}>
            Reset to defaults
          </Button>
          <Show when={dirty()}>
            <Button disabled={busy()} onClick={() => setText(inForce().join("\n"))}>
              Discard
            </Button>
          </Show>
          <Button variant="primary" disabled={!dirty() || !draft().length || busy()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Section>
  );
}
