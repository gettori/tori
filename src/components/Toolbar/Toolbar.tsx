import { createSignal, createEffect, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import Icon from "../Icon/Icon";
import Tooltip from "../Tooltip/Tooltip";
import { ChevronRight } from "lucide-solid";
import { memberInitials } from "../../utils/topics";
import { createTopicMembers, type TintedMember } from "../../utils/topicMembers";
import { createDragReorder } from "../../utils/dragReorder";
import styles from "./Toolbar.module.css";

// Where you are: the breadcrumb to the selected worktree. The trail ends at the
// branch, because the chat's own tab already wears the agent mark and the
// session title, and its figures sit in the chat's status strip beside the
// conversation they describe.
//
// It used to end in the two hand-offs out of the app as well. Those are
// `components/HandOffs` now, at the right end of the topbar: a crumb is elastic
// and a button pinned to the end of one is never twice in the same place.
//
// For a Topic the crumb is its name and branch, followed by one chip per
// member: the present ones switch the active root, the rest wear their state.
export default function Toolbar(props: { selected: Selection | null; onActiveRoot?: (root: string) => void }) {
  const [err, setErr] = createSignal("");

  const sel = () => props.selected;
  const isTopic = () => sel()?.kind === "feature";
  const topicId = () => (isTopic() ? (sel()?.featureId ?? null) : null);

  // The Selection carries only the present roots; badges need every member, so
  // the record comes from the shared resource, which also owns the tint and the
  // refetch on `topics://changed` / `config://changed`.
  const members = createTopicMembers(topicId);
  const isActive = (m: TintedMember) => !!m.member.worktreePath && m.member.worktreePath === sel()?.activeRoot;
  // Which repo the panels below are showing. Absent for a Topic whose members
  // are all broken, where the crumb falls back to the two it always had rather
  // than to an empty middle and a separator with nothing after it.
  const activeMember = () => members().find(isActive) ?? null;

  // The chip row reorders the Topic as the sidebar's member list does, through
  // the same helper. The command emits, so `members()` comes back in the new
  // order on its own and nothing here holds a second copy of it.
  const drag = createDragReorder({
    keys: () => members().map((m) => m.member.repoPath),
    onCommit: (repoPaths) => {
      const id = topicId();
      if (id) void invoke("reorder_members", { topicId: id, repoPaths }).catch((e) => setErr(String(e)));
    },
  });

  // A failed reorder belongs to the selection that produced it, so it leaves
  // with that selection rather than following you to the next one.
  createEffect(on(() => props.selected, () => setErr("")));

  return (
    <div class={styles.toolbar}>
      <Show when={sel()} fallback={<div class={styles.tbEmpty}>Select a branch or session</div>}>
        <div class={styles.tbRow}>
          <div class={styles.tbInfo}>
            <Show
              when={isTopic()}
              fallback={
                <nav class={styles.tbCrumb} aria-label="location">
                  <span class={`${styles.crumb} dim`}>{sel()!.spaceName}</span>
                  <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                  <span class={`${styles.crumb} dim`}>{sel()!.projectName}</span>
                  <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                  <span class={`${styles.crumb} ${styles.leaf}`}>{sel()!.branch}</span>
                </nav>
              }
            >
              <nav class={styles.tbCrumb} aria-label="location">
                <span class={`${styles.crumb} ${styles.leaf}`}>{sel()!.featureName ?? sel()!.projectName}</span>
                <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                {/* Named here and switched below: the crumb reads as where you
                    are, the chip row as the control that moves it. */}
                <Show when={activeMember()}>
                  {(m) => (
                    <>
                      <span class={`${styles.crumb} dim`}>{m().label}</span>
                      <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                    </>
                  )}
                </Show>
                <span class={`${styles.crumb} dim`}>{sel()!.branch}</span>
              </nav>
              <div class={styles.members} role="group" aria-label="Feature members">
                <For each={members()}>
                  {(m) => {
                    const name = () => (m.state.usable ? m.label : `${m.label}: ${m.state.label}`);
                    return (
                      <Tooltip
                        as="button"
                        type="button"
                        class={styles.member}
                        classList={{
                          [styles.memberActive]: isActive(m),
                          [styles.memberOff]: !m.state.usable,
                          [styles.memberDragging]: drag.dragging() === m.member.repoPath,
                          [styles.memberOver]: drag.over() === m.member.repoPath,
                        }}
                        style={m.style}
                        disabled={!m.state.usable}
                        aria-pressed={isActive(m)}
                        aria-label={name()}
                        label={name()}
                        data-member={m.member.repoPath}
                        {...drag.rowProps(m.member.repoPath)}
                        // A drag is a press that never becomes a click, except
                        // where the browser disagrees; carrying a chip must not
                        // also switch the panels below to it.
                        onClick={() =>
                          !drag.fromDrag() && m.member.worktreePath && props.onActiveRoot?.(m.member.worktreePath)
                        }
                      >
                        {memberInitials(m.member)}
                      </Tooltip>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </div>

        <Show when={err()}><div class={styles.tbErr}>{err()}</div></Show>
      </Show>
    </div>
  );
}
