import { For, Show } from "solid-js";
import {
  EDITOR_TOGGLES,
  Group,
  OWN_ROW_TOGGLES,
  Row,
  TodoTagsRow,
  ActiveLineRow,
  TabSizeRow,
  ToggleRow,
  idsIn,
  workspaceName,
  type PaneProps,
} from "../../components/paneKit";
import { overlayRoot } from "../../settingsStore";
import { blameOn, writeBlamePref } from "../../../../utils/blamePref";
import { sideBySideOn, writeSideBySide } from "../../../../utils/sideBySide";
import styles from "../../Settings.module.css";
import Switch from "../../../../components/Switch/Switch";

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
      <Group {...props} title="Behaviour" ids={idsIn("editor")}>
        {/* The same row as the comfort list below, so these four answer to the
            workspace overlay as well: before they did, the palette's
            “Preferences: Vim keybindings” wrote the layer in force while this
            row wrote and showed the global one, and a workspace that overrode
            either made the pair disagree on screen. */}
        <For each={OWN_ROW_TOGGLES}>{(t) => <ToggleRow {...props} entry={t} />}</For>
      </Group>

      <Group {...props} title="Editing" ids={idsIn("editing")}>
        {/* Data-driven rather than ten hand-written rows: every one of these is
            the same boolean row, and the list is what the wave keeps adding to.
            The hint is optional, carried only by the keys whose effect is not
            obvious from the label. */}
        <TabSizeRow {...props} />
        <For each={EDITOR_TOGGLES}>{(t) => <ToggleRow {...props} entry={t} />}</For>
        <ActiveLineRow {...props} />
        <TodoTagsRow {...props} />
        {/* The two reader preferences that live in localStorage rather than in
            `EditorDefaults`, so they get plain rows: no workspace badge and no
            "Set here", because there is no overlay layer under them to write. */}
        <Row {...props} id="blame" label="Git blame">
          <Switch checked={blameOn()} onChange={writeBlamePref} aria-label="Git blame" />
        </Row>
        <Row {...props} id="side-by-side-diff" label="Side-by-side diffs">
          <Switch
            checked={sideBySideOn()}
            onChange={writeSideBySide}
            aria-label="Side-by-side diffs"
          />
        </Row>
        <Show
          when={overlayRoot()}
          fallback={
            <div class={styles.note}>Select a branch to override any of these for one workspace.</div>
          }
        >
          <div class={styles.note}>
            “Set here” writes to <code>{workspaceName()}/.tori/settings.json</code>, which stays on this
            machine: Tori adds it to the repo's own ignore list, so it never reaches a commit or a
            teammate.
          </div>
        </Show>
      </Group>
    </>
  );
}
