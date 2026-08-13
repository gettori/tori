import { createSignal, createEffect, on, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import ClaudeIcon from "../../seti/ClaudeIcon";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import { ChevronRight, SquareTerminal, Code2, ArrowUpRight } from "lucide-solid";
import styles from "./Toolbar.module.css";

// Where you are and what to open it with: the breadcrumb to the selected
// session, and the two hand-offs out of the app. The session's figures live in
// the chat's own status strip, next to the conversation they describe, rather
// than being read a second time here.
export default function Toolbar(props: { selected: Selection | null }) {
  const [displayName, setDisplayName] = createSignal("");
  const [err, setErr] = createSignal("");

  const sel = () => props.selected;
  const isSession = () => !!sel()?.sessionId;

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
    if (!s) return;
    const args = resume && s.sessionId ? ["--resume", s.sessionId] : [];
    // Anchor on the working folder (the worktree/session dir), not the container.
    await invoke("open_in_ghostty", { cwd: s.folderPath, program: "claude", args }).catch((e) => setErr(String(e)));
  }
  async function openVSCode() {
    const s = sel();
    if (s) await invoke("open_in_vscode", { path: s.folderPath }).catch((e) => setErr(String(e)));
  }

  return (
    <div class={styles.toolbar}>
      <Show when={sel()} fallback={<div class={styles.tbEmpty}>Select a branch or session</div>}>
        <div class={styles.tbRow}>
          <div class={styles.tbInfo}>
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
