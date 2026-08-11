import { For, Show } from "solid-js";
import {
  EDITOR_TOGGLES,
  Group,
  OWN_ROW_TOGGLES,
  TodoTagsRow,
  ToggleRow,
  idsIn,
  workspaceName,
  type PaneProps,
} from "../paneKit";
import { overlayRoot } from "../settingsStore";
import styles from "../Settings.module.css";

/**
 * The two Editor sections, merged into one pane.
 *
 * They were always one section to the eye and were titled "Editor" twice, which
 * read as a rendering bug rather than as a grouping. The ids stay split, which
 * is what lets the two groups be titled for what actually separates them: the
 * four above each need a paragraph of consequence, the list below is a line of
 * pixels each.
 */
export default function EditorPane(props: PaneProps) {
  return (
    <>
      <Group shown={props.shown} title="Behaviour" ids={idsIn("editor")}>
        {/* The same row as the comfort list below, so these four answer to the
            workspace overlay as well: before they did, the palette's
            “Preferences: Vim keybindings” wrote the layer in force while this
            row wrote and showed the global one, and a workspace that overrode
            either made the pair disagree on screen. */}
        <For each={OWN_ROW_TOGGLES}>{(t) => <ToggleRow shown={props.shown} entry={t} />}</For>
      </Group>

      <Group shown={props.shown} title="Editing" ids={idsIn("editing")}>
        {/* Data-driven rather than ten hand-written rows: every one of these is
            the same boolean row, and the list is what the wave keeps adding to.
            The hint is optional, carried only by the keys whose effect is not
            obvious from the label. */}
        <For each={EDITOR_TOGGLES}>{(t) => <ToggleRow shown={props.shown} entry={t} />}</For>
        <TodoTagsRow shown={props.shown} />
        <Show
          when={overlayRoot()}
          fallback={
            <div class={styles.hint}>Select a branch to override any of these for one workspace.</div>
          }
        >
          <div class={styles.hint}>
            “Set here” writes to {workspaceName()}/.sway/settings.json, which stays on this machine: Sway
            adds it to the repo's own ignore list, so it never reaches a commit or a teammate.
          </div>
        </Show>
      </Group>
    </>
  );
}
