// Open one pull request as a stage tab, from wherever it was picked.
//
// The tab reads `prReviewStore` on mount, and a pull request the poll never
// covered has no other source, so it is noted there before the tab opens.
import { invoke } from "@tauri-apps/api/core";
import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "./events";
import { forgeErrorMessage, type PullRequest } from "./forgeTypes";
import { notePr, setViewingPr } from "./prReviewStore";
import { prTabId } from "./syntheticTabs";

export function openPrTab(workspace: string, pr: PullRequest) {
  notePr(workspace, pr.number, pr);
  setViewingPr(workspace, pr.number);
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: prTabId(workspace, pr.number) });
}

/** For a reference that holds only the number: read it fresh, then open it. */
export async function openPrByNumber(workspace: string, number: number) {
  try {
    openPrTab(workspace, await invoke<PullRequest>("forge_get_pr", { projectPath: workspace, number }));
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: forgeErrorMessage(e), kind: "error" });
  }
}
