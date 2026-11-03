import { createSignal, For, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Ban, Globe } from "lucide-solid";
import styles from "./Dialogs.module.css";
import Button from "../Button/Button";
import Dialog from "../Dialog/Dialog";
import Icon from "../Icon/Icon";
import SpaceMark from "../SpaceMark/SpaceMark";
import { spaceOfMember, type SpaceTint } from "../../utils/topicMembers";
import { refusedReason, type Topic } from "../../utils/topics";
import { GLOBAL_NAME } from "../../utils/globalSpace";

type MoveSpace = SpaceTint & { icon?: string | null };

function Row(r: {
  name: string;
  glyph: JSX.Element;
  note?: string;
  refused?: string | null;
  picked: boolean;
  current: boolean;
  tabbable: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      class={styles.moveRow}
      classList={{ [styles.moveRefused]: !!r.refused }}
      aria-checked={r.picked}
      tabIndex={r.tabbable ? 0 : -1}
      aria-disabled={r.refused ? "true" : undefined}
      data-picked={r.picked ? "" : undefined}
      onClick={() => !r.refused && r.onPick()}
    >
      <span class={styles.moveGlyph}>{r.glyph}</span>
      <span class={styles.moveText}>
        <span class={styles.moveName}>{r.name}</span>
        <Show when={r.refused ?? r.note}>
          {(note) => (
            <span class={styles.moveNote}>
              <Show when={r.refused}>
                <Icon icon={Ban} />
              </Show>
              {note()}
            </span>
          )}
        </Show>
      </span>
      <Show when={r.current}>
        <span class={styles.moveCurrent}>Current</span>
      </Show>
    </button>
  );
}

/** A refused space stays in the list with its reason, so the user learns why
 *  a space is not on offer instead of wondering where it went. */
export default function MoveTopicDialog(props: {
  topic: Topic;
  spaces: MoveSpace[];
  onDone: (topic: Topic) => void;
  onCancel: () => void;
}) {
  const current = () => props.topic.space ?? "";
  const [target, setTarget] = createSignal(current());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const reason = (space: string) =>
    refusedReason(props.topic, space, (m) => spaceOfMember(m, props.spaces)?.name ?? null);
  const canMove = () => !busy() && target() !== current() && (!target() || !reason(target()));

  const values = () => ["", ...props.spaces.map((g) => g.name)];
  // A Topic whose space is gone has no row picked, so the first row takes Tab.
  const tabbable = (value: string) => (values().includes(target()) ? target() === value : value === "");

  // Arrows move focus over every row, refused ones too, so their reasons are
  // read out; only a row that can hold the Topic is picked on the way.
  function onArrow(e: KeyboardEvent & { currentTarget: HTMLElement }) {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[(at + step + rows.length) % rows.length];
    next.focus();
    if (next.getAttribute("aria-disabled") !== "true") next.click();
  }

  async function move() {
    if (!canMove()) return;
    setBusy(true);
    setError(null);
    try {
      props.onDone(await invoke<Topic>("set_topic_space", { topicId: props.topic.id, space: target() || null }));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="sheet"
      title={`Move ${props.topic.name}`}
      description={`Now in ${current() || GLOBAL_NAME}`}
      onClose={() => props.onCancel()}
      actions={
        <>
          <Button onClick={() => props.onCancel()}>Cancel</Button>
          <Button variant="primary" disabled={!canMove()} onClick={() => void move()}>
            {busy() ? "Working…" : target() === current() ? "Move" : `Move to ${target() || GLOBAL_NAME}`}
          </Button>
        </>
      }
    >
      <Show when={error()}>
        {(msg) => (
          <div class={styles.warning} role="alert">
            {msg()}
          </div>
        )}
      </Show>
      <div role="radiogroup" aria-label="Move to" class={styles.moveGroup} onKeyDown={onArrow}>
        <Row
          name={GLOBAL_NAME}
          glyph={<Icon icon={Globe} />}
          note="Any space's projects"
          picked={target() === ""}
          current={current() === ""}
          tabbable={tabbable("")}
          onPick={() => setTarget("")}
        />
        <div class={styles.repoGroupLabel} aria-hidden="true">
          Spaces <span class={styles.repoGroupCount}>{props.spaces.length}</span>
        </div>
        <For each={props.spaces}>
          {(g) => (
            <Row
              name={g.name}
              glyph={<SpaceMark name={g.name} icon={g.icon} color={g.color} />}
              refused={reason(g.name)}
              picked={target() === g.name}
              current={current() === g.name}
              tabbable={tabbable(g.name)}
              onPick={() => setTarget(g.name)}
            />
          )}
        </For>
      </div>
    </Dialog>
  );
}
