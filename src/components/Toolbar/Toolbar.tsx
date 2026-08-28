import { createSignal, createEffect, on, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import ClaudeIcon from "../../seti/ClaudeIcon";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import Tooltip from "../Tooltip/Tooltip";
import { ChevronRight, SquareTerminal, Code2, ArrowUpRight } from "lucide-solid";
import { memberInitials, selectionRoot } from "../../utils/features";
import { createFeatureMembers, type TintedMember } from "../../utils/featureMembers";
import { createDragReorder } from "../../utils/dragReorder";
import styles from "./Toolbar.module.css";

// Where you are and what to open it with: the breadcrumb to the selected
// session, and the two hand-offs out of the app. The session's figures live in
// the chat's own status strip, next to the conversation they describe, rather
// than being read a second time here.
//
// For a Feature the crumb is its name and branch, followed by one chip per
// member: the present ones switch the active root, the rest wear their state.
export default function Toolbar(props: { selected: Selection | null; onActiveRoot?: (root: string) => void }) {
  const [displayName, setDisplayName] = createSignal("");
  const [err, setErr] = createSignal("");

  const sel = () => props.selected;
  const isSession = () => !!sel()?.sessionId;
  const isFeature = () => sel()?.kind === "feature";
  const featureId = () => (isFeature() ? (sel()?.featureId ?? null) : null);

  // The Selection carries only the present roots; badges need every member, so
  // the record comes from the shared resource, which also owns the tint and the
  // refetch on `features://changed` / `config://changed`.
  const members = createFeatureMembers(featureId);
  const isActive = (m: TintedMember) => !!m.member.worktreePath && m.member.worktreePath === sel()?.activeRoot;
  // Which repo the panels below are showing. Absent for a Feature whose members
  // are all broken, where the crumb falls back to the two it always had rather
  // than to an empty middle and a separator with nothing after it.
  const activeMember = () => members().find(isActive) ?? null;

  // The chip row reorders the Feature as the sidebar's member list does, through
  // the same helper. The command emits, so `members()` comes back in the new
  // order on its own and nothing here holds a second copy of it.
  const drag = createDragReorder({
    keys: () => members().map((m) => m.member.repoPath),
    onCommit: (repoPaths) => {
      const id = featureId();
      if (id) void invoke("reorder_members", { featureId: id, repoPaths }).catch((e) => setErr(String(e)));
    },
  });

  createEffect(
    on(
      () => sel()?.sessionId,
      () => {
        setErr("");
        const s = sel();
        setDisplayName(s?.sessionName || s?.sessionTitle || "");
      },
    ),
  );

  async function openGhostty(resume: boolean) {
    const s = sel();
    const cwd = selectionRoot(s);
    if (!s || !cwd) return;
    const args = resume && s.sessionId ? ["--resume", s.sessionId] : [];
    // Anchor on the working folder (the worktree/session dir), not the container.
    await invoke("open_in_ghostty", { cwd, program: "claude", args }).catch((e) => setErr(String(e)));
  }
  async function openVSCode() {
    const path = selectionRoot(sel());
    if (path) await invoke("open_in_vscode", { path }).catch((e) => setErr(String(e)));
  }

  return (
    <div class={styles.toolbar}>
      <Show when={sel()} fallback={<div class={styles.tbEmpty}>Select a branch or session</div>}>
        <div class={styles.tbRow}>
          <div class={styles.tbInfo}>
            <Show
              when={isFeature()}
              fallback={
                <nav class={styles.tbCrumb} aria-label="location">
                  <span class={`${styles.crumb} dim`}>{sel()!.spaceName}</span>
                  <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                  <span class={`${styles.crumb} dim`}>{sel()!.projectName}</span>
                  <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                  <Show
                    when={isSession()}
                    fallback={<span class={`${styles.crumb} ${styles.leaf}`}>{sel()!.branch}</span>}
                  >
                    <span class={`${styles.crumb} dim`}>{sel()!.branch}</span>
                    <Icon icon={ChevronRight} class={`${styles.crumbSep} dim`} />
                    <span class={`${styles.crumb} ${styles.leaf}`}>
                      <ClaudeIcon />
                      {displayName()}
                    </span>
                  </Show>
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

          <div class={styles.tbActions}>
            <Button
              size="sm"
              onClick={() => openGhostty(isSession())}
              tooltip={isSession() ? "Resume in Ghostty" : "New in Ghostty"}
              aria-label={isSession() ? "Resume in Ghostty" : "New in Ghostty"}
              icon={<Icon icon={SquareTerminal} class={styles.tbAppIco} />}
              iconRight={<Icon icon={ArrowUpRight} class={styles.tbArrow} />}
            />
            <Button
              size="sm"
              onClick={openVSCode}
              tooltip="Open in VSCode"
              aria-label="Open in VSCode"
              icon={<Icon icon={Code2} class={styles.tbAppIco} />}
              iconRight={<Icon icon={ArrowUpRight} class={styles.tbArrow} />}
            />
          </div>
        </div>

        <Show when={err()}><div class={styles.tbErr}>{err()}</div></Show>
      </Show>
    </div>
  );
}
