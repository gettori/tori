import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Folder } from "lucide-solid";
import Button from "../Button/Button";
import Checkbox from "../Checkbox/Checkbox";
import Icon from "../Icon/Icon";
import { LayoutCard, type Inspection } from "./AttachFolderDialog";
import { moveBlockers } from "../../utils/moveProjects";
import { conversionRefusal, MOVE_WARNING, moveIntoSpace, type MoveOutcome } from "../../utils/moveIntoSpace";
import { projectTrusted } from "../../utils/projectTrust";
import { shortHome } from "../../utils/names";
import styles from "./Dialogs.module.css";

const NAME_LABEL = "move-into-space-name-label";

export type MoveForm = ReturnType<typeof createMoveForm>;

// The attach inspection's own refusal is not used: it turns away folders
// already in Tori, which are exactly what Move to space moves. `move_check`
// answers for a move instead.
export function createMoveForm(opts: {
  path: () => string | null;
  base: () => string;
  space: () => string | null;
  countRunning: (path: string) => Promise<number>;
}) {
  const [found, setFound] = createSignal<Inspection | null>(null);
  const [name, setName] = createSignal("");
  const [convert, setConvert] = createSignal(false);
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const [check, setCheck] = createSignal<string | null>(null);
  const [blockers, setBlockers] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(
    on(opts.path, (at) => {
      setFound(null);
      setRefusal(null);
      setError(null);
      setBlockers([]);
      if (!at) return;
      let live = true;
      onCleanup(() => (live = false));
      invoke<Inspection>("inspect_folder", { path: at })
        .then(async (f) => {
          if (!live) return;
          setFound(f);
          setName(f.name);
          const clone = f.layout.kind === "clone";
          setConvert(clone);
          if (!clone || !projectTrusted(at)) return;
          const why = await conversionRefusal(at);
          if (live && why) {
            setRefusal(why);
            setConvert(false);
          }
        })
        .catch((e) => live && setError(String(e)));
      opts.countRunning(at).then((n) => live && setBlockers(moveBlockers(n, [at])));
    }),
  );

  createEffect(
    on([opts.path, opts.space, name], ([at, space, n]) => {
      setCheck(null);
      if (!at || !space || !n.trim()) return;
      let live = true;
      onCleanup(() => (live = false));
      invoke<string | null>("move_check", { base: opts.base(), space, name: n.trim(), path: at })
        .then((why) => live && setCheck(why))
        .catch((e) => live && setCheck(String(e)));
    }),
  );

  const canMove = () =>
    !!opts.path() && !!opts.space() && !!found() && !!name().trim() && !check() && blockers().length === 0 && !busy();

  async function submit(): Promise<(MoveOutcome & { kind: "moved" }) | null> {
    const path = opts.path();
    const space = opts.space();
    if (!canMove() || !path || !space) return null;
    setBusy(true);
    setError(null);
    try {
      const out = await moveIntoSpace({ base: opts.base(), space, name: name().trim(), path, convert: convert() });
      setBusy(false);
      if (out.kind === "moved") return out;
      setRefusal(out.refusal);
      setConvert(false);
      return null;
    } catch (e) {
      setError(String(e));
      setBusy(false);
      return null;
    }
  }

  return { found, name, setName, convert, setConvert, refusal, check, blockers, busy, error, canMove, submit };
}

export function MoveFields(props: { form: MoveForm; path: string | null; home: string; onChange?: () => void }) {
  const f = props.form;
  const tilde = (p: string) => shortHome(p, props.home);
  const alerts = () => [f.error(), f.check(), ...f.blockers()].filter((x): x is string => !!x);

  return (
    <>
      <div class={styles.spaceField}>
        <div class={styles.spaceLabel}>Folder</div>
        <div class={styles.folderField}>
          <Icon icon={Folder} class={styles.folderFieldIcon} />
          <span class={styles.folderFieldPath} title={props.path ?? ""}>
            {props.path ? tilde(props.path) : "No folder chosen"}
          </span>
          <Show when={props.onChange}>
            {(change) => (
              <Button size="sm" onClick={() => change()()}>
                {props.path ? "Change…" : "Choose…"}
              </Button>
            )}
          </Show>
        </div>
      </div>

      <Show when={f.found()}>{(found) => <LayoutCard layout={found().layout} tilde={tilde} root={props.path} />}</Show>

      <Show when={f.found()?.layout.kind === "clone"}>
        <Checkbox
          class={styles.wtCheck}
          checked={f.convert()}
          disabled={!!f.refusal()}
          onChange={f.setConvert}
          label="Convert to worktree layout"
        />
        <Show
          when={f.refusal()}
          fallback={
            <Show when={f.convert()}>
              <p class={styles.attachFine}>
                Tori trusts the folder, then makes it a .bare repo with the default branch and the checked-out branch as
                worktrees.
              </p>
            </Show>
          }
        >
          {(why) => <p class={styles.attachFine}>It can't be converted, so it moves as it is. {why()}</p>}
        </Show>
      </Show>

      <div class={styles.spaceField}>
        <div class={styles.spaceLabel}>
          <span id={NAME_LABEL}>Name in the space</span>
        </div>
        <input
          class={styles.spaceInput}
          aria-labelledby={NAME_LABEL}
          value={f.name()}
          placeholder={f.found()?.name ?? "name"}
          onInput={(e) => f.setName(e.currentTarget.value)}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
        />
      </div>

      <Show when={alerts().length > 0}>
        <div class={styles.warning} role="alert">
          {alerts().join(" ")}
        </div>
      </Show>

      <p class={styles.attachFine}>{MOVE_WARNING}</p>
    </>
  );
}
