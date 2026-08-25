import { createSignal, createEffect, createResource, on, onCleanup, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import ClaudeIcon from "../../seti/ClaudeIcon";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import Tooltip from "../Tooltip/Tooltip";
import { ChevronRight, SquareTerminal, Code2, ArrowUpRight } from "lucide-solid";
import { memberInitials, memberState, selectionRoot, type Feature, type Member } from "../../utils/features";
import { spaceHue, spaceHueRgb } from "../../utils/spaceTint";
import styles from "./Toolbar.module.css";

type TintSpace = { name: string; color?: string; projects: { path: string }[] };

const samePath = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

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

  // The Selection carries only the present roots; badges need every member,
  // so the record is read whenever the Feature changes or the tree does.
  const [tick, setTick] = createSignal(0);
  const [feature] = createResource(
    () => (featureId() ? { id: featureId()!, tick: tick() } : null),
    async ({ id }) => {
      const list = (await invoke<Feature[] | null>("list_features").catch(() => null)) ?? [];
      return list.find((f) => f.id === id) ?? null;
    },
  );
  const [spaces] = createResource(
    () => (featureId() ? tick() : null),
    async () => {
      const cfg = await invoke<{ spaces: TintSpace[] } | null>("get_config").catch(() => null);
      return cfg?.spaces ?? [];
    },
  );
  let unlistenConfig: UnlistenFn | undefined;
  let unlistenFeatures: UnlistenFn | undefined;
  onMount(async () => {
    unlistenConfig = await listen("config://changed", () => setTick((n) => n + 1));
    unlistenFeatures = await listen("features://changed", () => setTick((n) => n + 1));
  });
  onCleanup(() => {
    unlistenConfig?.();
    unlistenFeatures?.();
  });

  const members = () => [...(feature()?.members ?? [])].sort((a, b) => a.order - b.order);
  const spaceOf = (m: Member) => (spaces() ?? []).find((g) => g.projects.some((p) => samePath(p.path, m.repoPath)));
  const tint = (m: Member) => {
    const g = spaceOf(m);
    return g ? { "--chip-hue": spaceHue(g.name, g.color), "--chip-rgb": spaceHueRgb(g.name, g.color) } : undefined;
  };
  const isActive = (m: Member) => !!m.worktreePath && m.worktreePath === sel()?.activeRoot;

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
                <span class={`${styles.crumb} dim`}>{sel()!.branch}</span>
              </nav>
              <div class={styles.members} role="group" aria-label="Feature members">
                <For each={members()}>
                  {(m) => {
                    const state = () => memberState(m.state);
                    return (
                      <Tooltip
                        as="button"
                        type="button"
                        class={styles.member}
                        classList={{ [styles.memberActive]: isActive(m), [styles.memberOff]: !state().usable }}
                        style={tint(m)}
                        disabled={!state().usable}
                        aria-pressed={isActive(m)}
                        aria-label={state().usable ? m.displayName : `${m.displayName}: ${state().label}`}
                        label={state().usable ? m.displayName : `${m.displayName}: ${state().label}`}
                        data-member={m.repoPath}
                        onClick={() => m.worktreePath && props.onActiveRoot?.(m.worktreePath)}
                      >
                        {memberInitials(m)}
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
