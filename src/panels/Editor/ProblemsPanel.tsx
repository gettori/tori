import { For, Index, Show } from "solid-js";
import { emitWith, OPEN_IN_EDITOR, TOAST, type ToastEvent } from "../../utils/events";
import { diagnostics, fixesFor, orderFiles, summarize, type Problem, type Severity } from "../../utils/diagnostics";
import { composeDiagnosticWithFixes, requestSend, type SessionTarget } from "../../utils/safeSend";
import { diagnosticBlocks } from "../../utils/chatCompose";
import { sendBlockedReason, sendTargetFor } from "../../utils/sendTarget";
import { isUnderPath } from "../../utils/pathScope";
import { groupByMemberRoot, memberSectionsHeaded, type MemberRoot } from "../../utils/topicMembers";
import Button from "../../components/Button/Button";
import MemberSection from "../../components/MemberSection/MemberSection";
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
 *  insert-only and never auto-submitted, exactly like the hunk-comment path.
 *
 *  Inside a Topic it answers for every member at once, one section each: a
 *  type error in the repo you are not looking at is still one of this Topic's
 *  problems, and the tab badge counts it whether or not this panel would. */
export default function ProblemsPanel(props: { selected: Selection | null; roots?: MemberRoot[] }) {
  /** Every root this panel answers for. A branch unit is its own single root, so
   *  the grouping below has one shape rather than two. */
  const scope = (): MemberRoot[] => {
    if (props.roots) return props.roots;
    const r = props.selected?.folderPath;
    return r ? [{ path: r, repoPath: r, label: "" }] : [];
  };
  const headed = () => memberSectionsHeaded(props.roots);

  // Scoped to the selected workspace: the store spans every warm project now
  // (servers survive a switch), and this panel answers for one of them. Nothing
  // outside the scope is listed, because a store this wide cannot tell a
  // Topic's departed member from another workspace entirely.
  const here = () => {
    const roots = scope().map((r) => r.path);
    return Object.entries(diagnostics()).filter(([p]) => roots.some((r) => isUnderPath(p, r)));
  };
  const sections = () =>
    groupByMemberRoot(orderFiles(here()), ([p]) => p, scope()).map((g) => ({
      root: g.root,
      files: g.items,
      count: g.items.reduce((n, [, list]) => n + list.length, 0),
    }));
  const total = () => here().reduce((n, [, list]) => n + list.length, 0);

  // Same capability gate as the Changes panel, and the same one the TODO and
  // Debug panels ask: safe-send needs a resumable session to land the text in.
  const gate = () => sendTargetFor(props.selected);

  function target(): SessionTarget | null {
    const answer = gate();
    return "target" in answer ? answer.target : null;
  }

  function disabledReason(): string | null {
    return sendBlockedReason(props.selected);
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
    // Asked before composing, not cached: what the server would fix depends on
    // the file as it is now, and this row may have been on screen for a while.
    // Answers `[]` when no editor is mounted or the server will not say, and
    // the message goes without them rather than not going.
    const fixes = await fixesFor(path, p);
    const text = composeDiagnosticWithFixes(t, path, p.line, p.endLine, p.severity, p.message, fixes);
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
        {/* `Index`, not `For`: the sections are rebuilt from scratch on every
            diagnostic, and a referentially-keyed list would remount each one
            and reopen a member the reader had collapsed. */}
        <Index each={sections()}>
          {(section) => (
            <MemberSection root={section().root} headed={headed()} count={section().count}>
              <For each={section().files}>
                {([path, list]) => {
                  const counts = summarize(list);
                  return (
                    <div class={styles.fileGroup}>
                      <div class={styles.fileHead} title={path}>
                        <span class={styles.fileName}>{basename(path)}</span>
                        <For
                          each={(["error", "warning", "info", "hint"] as Severity[]).filter(
                            (s) => counts[s] > 0,
                          )}
                        >
                          {(s) => <span class={`${styles.count} ${styles[s]}`}>{counts[s]}</span>}
                        </For>
                      </div>
                      <For each={list}>
                        {(p) => (
                          <div class={styles.problemRow} onClick={() => jumpTo(path, p)} title={p.message}>
                            {/* `role` as well as the label: severity is carried
                                by colour alone here, and `aria-label` on a bare
                                span is ignored. */}
                            <span
                              role="img"
                              class={`${styles.dot} ${styles[p.severity]}`}
                              aria-label={SEVERITY_LABEL[p.severity]}
                            />
                            <span class={styles.loc}>
                              {p.line}:{p.column}
                            </span>
                            <span class={styles.message}>{p.message}</span>
                            <Show when={p.source}>
                              <span class={styles.source}>{p.source}</span>
                            </Show>
                            <Button
                              size="xs"
                              variant="ghost"
                              class={styles.sendButton}
                              tooltip={disabledReason() ?? "Send to agent"}
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
            </MemberSection>
          )}
        </Index>
      </Show>
    </div>
  );
}
