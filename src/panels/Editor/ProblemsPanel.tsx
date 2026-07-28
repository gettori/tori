import { For, Show } from "solid-js";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { diagnostics, orderFiles, summarize, type Problem, type Severity } from "../../utils/diagnostics";
import { composeDiagnostic, requestSend, type SessionTarget } from "../../utils/safeSend";
import { diagnosticBlocks } from "../../utils/chatCompose";
import { findAgent } from "../../utils/agents";
import Button from "../../components/Button/Button";
import type { Selection } from "../LeftSidebar/LeftSidebar";
import styles from "./ProblemsPanel.module.css";

const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
  hint: "Hint",
};

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** Problems list: the LSP diagnostics of every open file, grouped by file and
 *  ordered worst-first. Reads the same open-tab-scoped store the editor
 *  publishes to, so what is listed here always matches the markers in the
 *  gutter; closing a file drops its entries from both.
 *
 *  Each row can hand its diagnostic to the selected session through safe-send,
 *  insert-only and never auto-submitted, exactly like the hunk-comment path. */
export default function ProblemsPanel(props: { selected: Selection | null }) {
  const files = () => orderFiles(Object.entries(diagnostics()));
  const total = () => Object.values(diagnostics()).reduce((n, list) => n + list.length, 0);

  function target(): SessionTarget | null {
    const sel = props.selected;
    if (!sel?.sessionId) return null;
    return {
      sessionId: sel.sessionId,
      agent: sel.agent ?? "claude",
      folderPath: sel.folderPath,
      sessionCwd: sel.sessionCwd,
      sessionPath: sel.sessionPath,
      sessionTitle: sel.sessionTitle,
      sessionFile: sel.sessionFile,
    };
  }

  // Same capability gate as the Changes panel: safe-send needs a resumable
  // session to land the text in.
  function disabledReason(): string | null {
    const sel = props.selected;
    if (!sel?.sessionId) return "Select a session first";
    if (findAgent(sel.agent ?? "claude").resume_args.length === 0) return "This agent's sessions can't be resumed";
    return null;
  }

  function jumpTo(path: string, p: Problem) {
    emitWith(OPEN_IN_EDITOR, { path, line: p.line, col: p.column });
  }

  async function sendToAgent(path: string, p: Problem) {
    const t = target();
    const reason = disabledReason();
    if (reason) {
      emitWith<ToastEvent>(TOAST, { message: reason, kind: "error" });
      return;
    }
    if (!t) return;
    const text = composeDiagnostic(t, path, p.line, p.endLine, p.severity, p.message);
    const result = await requestSend({
      ...t,
      text,
      blocks: diagnosticBlocks(path, p.line, p.endLine, p.severity, p.message),
    });
    if (result.kind === "blocked") {
      emitWith<ToastEvent>(TOAST, { message: "That session is waiting on a prompt, answer it first.", kind: "error" });
    } else if (result.kind === "timeout") {
      emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
    }
  }

  return (
    <div class={styles.problemsPanel}>
      <Show
        when={total() > 0}
        fallback={<div class={styles.empty}>No problems in the open files.</div>}
      >
        <For each={files()}>
          {([path, list]) => {
            const counts = summarize(list);
            return (
              <div class={styles.fileGroup}>
                <div class={styles.fileHead} title={path}>
                  <span class={styles.fileName}>{basename(path)}</span>
                  <For each={(["error", "warning", "info", "hint"] as Severity[]).filter((s) => counts[s] > 0)}>
                    {(s) => <span class={`${styles.count} ${styles[s]}`}>{counts[s]}</span>}
                  </For>
                </div>
                <For each={list}>
                  {(p) => (
                    <div class={styles.problemRow} onClick={() => jumpTo(path, p)} title={p.message}>
                      <span class={`${styles.dot} ${styles[p.severity]}`} aria-label={SEVERITY_LABEL[p.severity]} />
                      <span class={styles.loc}>
                        {p.line}:{p.column}
                      </span>
                      <span class={styles.message}>{p.message}</span>
                      <Button
                        size="xs"
                        variant="ghost"
                        class={styles.sendButton}
                        title={disabledReason() ?? "Send to agent"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void sendToAgent(path, p);
                        }}
                      >
                        Send
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
