import { For, Show } from "solid-js";
import type { FirstRunSpace } from "../../../utils/firstRun";
import { badName, shortHome } from "../../../utils/names";
import styles from "../FirstRun.module.css";

export const SPACE_LEAD =
  "A space is a folder inside the base folder that groups related projects: work, personal, a client. The sidebar shows one space at a time, so each context stays uncluttered and you switch between them.";

/** Either pick one of the spaces discovery found, or name a new one. With no
 *  spaces under the root there is nothing to pick, so the field is the only
 *  mode; with some, the field is one link away. */
export type SpaceMode = "pick" | "create";

export default function SpaceStep(props: {
  root: string;
  spaces: FirstRunSpace[];
  home: string;
  mode: SpaceMode;
  onMode: (mode: SpaceMode) => void;
  selected: string | null;
  onSelect: (name: string) => void;
  name: string;
  onName: (name: string) => void;
  busy?: boolean;
  /** Enter in the name field. The primary lives in the footer, out of the
   *  field's reach, so the step forwards the key. */
  onSubmit: () => void;
}) {
  const plural = (n: number) => `${n} project${n === 1 ? "" : "s"}`;
  const error = () => (props.name.trim() === "" ? null : badName(props.name));
  const preview = () => shortHome(`${props.root}/${props.name.trim() || "..."}`, props.home);
  let field: HTMLInputElement | undefined;

  return (
    <Show
      when={props.mode === "pick" && props.spaces.length > 0}
      fallback={
        <>
          <div class={styles.field}>
            <label class={styles.fieldLabel} for="first-run-space-name">
              Space name
            </label>
            <input
              id="first-run-space-name"
              ref={(el) => {
                field = el;
                queueMicrotask(() => field?.focus());
              }}
              class={styles.input}
              type="text"
              value={props.name}
              placeholder="work"
              autocomplete="off"
              spellcheck={false}
              disabled={props.busy}
              onInput={(e) => props.onName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                props.onSubmit();
              }}
            />
            <Show when={error()} fallback={<div class={styles.preview}>Creates {preview()}</div>}>
              {(err) => <div class={styles.error}>{err()}</div>}
            </Show>
          </div>
          <div class={styles.card}>
            <Show
              when={props.spaces.length > 0}
              fallback={
                <>
                  No spaces found in {shortHome(props.root, props.home)}. One space is all Tori needs to open, and you
                  can add more at any time.
                </>
              }
            >
              The new space is created inside {shortHome(props.root, props.home)}, beside the ones already there.
            </Show>
          </div>
          <Show when={props.spaces.length > 0}>
            <div>
              <button type="button" class={styles.link} onClick={() => props.onMode("pick")}>
                Pick an existing space instead
              </button>
            </div>
          </Show>
        </>
      }
    >
      <div class={styles.choices} role="radiogroup" aria-label="Space to open">
        <For each={props.spaces}>
          {(s) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.selected === s.name}
              class={styles.choice}
              classList={{ [styles.choiceOn]: props.selected === s.name }}
              onClick={() => props.onSelect(s.name)}
            >
              <span>{s.name}</span>
              <span class={styles.choiceCount}>{plural(s.projects.length)}</span>
            </button>
          )}
        </For>
      </div>
      <div class={styles.row}>
        <button type="button" class={styles.link} onClick={() => props.onMode("create")}>
          Add another space
        </button>
        <span class={styles.hint}>Tori opens on the space you select here.</span>
      </div>
    </Show>
  );
}
