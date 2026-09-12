// Which file the commit view should open with, handed across from a sidebar
// row. A signal rather than a field in the tab id: the id is the tab's
// identity, and a file in it would make one commit two tabs.
import { createSignal } from "solid-js";

export type CommitFileRequest = { sha: string; file: string };

const [commitFileRequest, setCommitFileRequest] = createSignal<CommitFileRequest | null>(null);

export { commitFileRequest };

export function requestCommitFile(sha: string, file: string): void {
  setCommitFileRequest({ sha, file });
}

/** The commit view calls this once it has acted, so reopening the same tab
 *  later does not open the file again. */
export function clearCommitFileRequest(): void {
  setCommitFileRequest(null);
}
