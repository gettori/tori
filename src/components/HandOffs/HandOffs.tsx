import { Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { SquareTerminal, Code2, ArrowUpRight } from "lucide-solid";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import Button from "../Button/Button";
import Icon from "../Icon/Icon";
import { pushToast } from "../Toasts/Toasts";
import { selectionRoot } from "../../utils/features";
import styles from "./HandOffs.module.css";

// The two ways out of Sway: what you have selected, opened in Ghostty or in
// VS Code.
//
// **They sit at the right end of the topbar, not at the end of the breadcrumb
// where they started.** The crumb is elastic - it grows and shrinks with the
// space, project and branch names it carries - so buttons pinned to its end
// were never twice in the same place, and reaching for one meant finding it
// first. Against the right edge they are a fixed target, and they keep the
// company they belong in: everything on that end of the bar is a way out of
// what you are looking at rather than a description of it.
//
// **A failed launch is a toast now.** In the breadcrumb it had a second row
// under the crumb to fall into. A 44px bar has nowhere to put a sentence, and
// "Ghostty is not installed" is a thing to say once rather than a thing to
// leave sitting on the chrome until the selection changes.

export default function HandOffs(props: { selected: Selection | null }) {
  const sel = () => props.selected;
  const isSession = () => !!sel()?.sessionId;
  // Shells is the one selection with no folder to hand over, so it gets no
  // buttons rather than two that refuse.
  const hasRoot = () => !!sel() && sel()?.kind !== "shells" && !!selectionRoot(sel());

  async function openGhostty(resume: boolean) {
    const s = sel();
    const cwd = selectionRoot(s);
    if (!s || !cwd) return;
    const args = resume && s.sessionId ? ["--resume", s.sessionId] : [];
    // Anchor on the working folder (the worktree/session dir), not the container.
    await invoke("open_in_ghostty", { cwd, program: "claude", args }).catch((e) => pushToast(String(e)));
  }

  async function openVSCode() {
    const path = selectionRoot(sel());
    if (path) await invoke("open_in_vscode", { path }).catch((e) => pushToast(String(e)));
  }

  return (
    <Show when={hasRoot()}>
      <div class={styles.actions}>
        <Button
          size="sm"
          onClick={() => openGhostty(isSession())}
          tooltip={isSession() ? "Resume in Ghostty" : "New in Ghostty"}
          aria-label={isSession() ? "Resume in Ghostty" : "New in Ghostty"}
          icon={<Icon icon={SquareTerminal} class={styles.appIco} />}
          iconRight={<Icon icon={ArrowUpRight} class={styles.arrow} />}
        />
        <Button
          size="sm"
          onClick={openVSCode}
          tooltip="Open in VSCode"
          aria-label="Open in VSCode"
          icon={<Icon icon={Code2} class={styles.appIco} />}
          iconRight={<Icon icon={ArrowUpRight} class={styles.arrow} />}
        />
      </div>
    </Show>
  );
}
