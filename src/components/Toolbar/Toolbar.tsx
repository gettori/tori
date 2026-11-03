import { Show } from "solid-js";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import Icon from "../Icon/Icon";
import { ChevronRight } from "lucide-solid";
import SyncChip from "../SyncChip/SyncChip";
import { topics } from "../../utils/topicStore";
import { memberRoot } from "../../utils/topics";
import { GLOBAL_NAME, spaceLabel } from "../../utils/globalSpace";
import styles from "./Toolbar.module.css";

// Where you are: the breadcrumb to the selected worktree. The trail ends at the
// branch, because the chat's own tab already wears the agent mark and the
// session title, and its figures sit in the chat's status strip beside the
// conversation they describe.
//
// A global Topic spans several repos, so its trail stops at the Topic: which
// member the panels below show is the sidebar's to say.
export default function Toolbar(props: { selected: Selection | null }) {
  const sel = () => props.selected;
  const isTopic = () => sel()?.kind === "topic";
  const member = () => {
    const s = sel();
    if (!s?.spaceName || !s.activeRoot) return null;
    const topic = topics().find((t) => t.id === s.topicId);
    return topic?.members.find((m) => memberRoot(m) === s.activeRoot)?.displayName ?? null;
  };

  return (
    <div class={styles.toolbar}>
      <Show when={sel()} fallback={<div class={styles.tbEmpty}>Select a branch or session</div>}>
        <div class={styles.tbRow}>
          <div class={styles.tbInfo}>
            <Show
              when={isTopic()}
              fallback={
                <>
                  <nav class={styles.tbCrumb} aria-label="location">
                    <span class={`${styles.crumb} dim`}>{spaceLabel(sel()!.spaceName)}</span>
                    <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                    <span class={`${styles.crumb} dim`}>{sel()!.projectName}</span>
                    <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                    <span class={`${styles.crumb} ${styles.leaf}`}>{sel()!.branch}</span>
                  </nav>
                  {/* Outside the nav, which is a list of places: this is a
                      control, and a landmark that holds one is a landmark that
                      no longer describes itself. */}
                  <SyncChip root={sel()!.folderPath} />
                </>
              }
            >
              <nav class={styles.tbCrumb} aria-label="location">
                <span class={`${styles.crumb} dim`}>{sel()!.spaceName || GLOBAL_NAME}</span>
                <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                <span class={styles.crumb} classList={{ dim: !!member(), [styles.leaf]: !member() }}>
                  {sel()!.topicName ?? sel()!.projectName}
                </span>
                <Show when={member()}>
                  {(name) => (
                    <>
                      <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                      <span class={`${styles.crumb} ${styles.leaf}`}>{name()}</span>
                    </>
                  )}
                </Show>
              </nav>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
