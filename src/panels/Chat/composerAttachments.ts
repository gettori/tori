// The composer's attachment handlers, shared by the two surfaces that draw one.
//
// A draft tab and a live chat host the same composer, and what a mention *means*
// must not depend on which of them the user typed into: a relative path resolved
// against the wrong root, or a dragged file uploaded by one surface and mentioned
// by the other, would be a difference nobody could see until the agent read it.
// So the four handlers live here once and both surfaces pass their own key.
//
// Every attachment ends up the same shape: a labelled path the agent reads off
// disk ([[adr_attachments_are_labelled_paths]]). A dragged path is that already.
// Pasted bytes are written under Sway's app data first and become a path too.
import { invoke } from "@tauri-apps/api/core";
import { attachmentSources, type ChatTier } from "../../utils/chatCapabilities";
import {
  attachmentKind,
  checkAttachment,
  fileMentionBlocks,
  nextLabel,
  offerToComposer,
  pendingFor,
  type ComposerKey,
} from "../../utils/chatCompose";

/** A pasted or dropped file, as the composer read it. */
export type UploadFile = { name: string; bytes: Uint8Array };

export type ComposerAttachments = {
  loadProjectFiles: () => Promise<string[]>;
  onAttachFile: (relPath: string) => void;
  onAttachPaths: (absPaths: string[]) => void;
  onAttachUploads: (files: UploadFile[]) => void;
};

/** The filename rides in a header because the body is the file itself. */
export const ATTACHMENT_NAME_HEADER = "x-sway-attachment-name";

let dirRequest: Promise<string | null> | null = null;

/** Where uploads are written, asked once. Null when the backend cannot say,
 *  in which case no `--add-dir` is passed and a Read there prompts as usual. */
export function attachmentsDir(): Promise<string | null> {
  dirRequest ??= invoke<string>("attachments_dir").catch(() => {
    dirRequest = null;
    return null;
  });
  return dirRequest;
}

/** `key`, `cwd` and `tier` are read per call rather than captured, so a
 *  surface whose tab moves or whose session is minted mid-life keeps attaching
 *  to itself. */
export function composerAttachments(
  key: () => ComposerKey,
  cwd: () => string,
  tier: () => ChatTier,
  onRejected: (reason: string) => void,
): ComposerAttachments {
  // A path the agent already has. Labelled by kind so the prose can name it,
  // and refused by kind when this agent's Read would not open it.
  function mention(path: string) {
    const name = path.split("/").pop() || path;
    const verdict = checkAttachment(
      { name, mediaType: "", bytes: null },
      pendingFor(key()).length,
      attachmentSources(tier()).mentions,
    );
    if (!verdict.ok) {
      onRejected(verdict.reason);
      return;
    }
    offerToComposer(key(), fileMentionBlocks(path, nextLabel(key(), verdict.kind)));
  }

  return {
    // The project's file index, for `@` completion. Fetched on demand rather
    // than on mount: it is a full walk of the tree, and a chat that never
    // mentions a file should not pay for one. The composer asks once and caches.
    loadProjectFiles: () => invoke<string[]>("list_project_files", { projectPath: cwd() }).catch(() => []),
    // A completed `@` mention. The composer hands back the project-relative path
    // it showed; resolving it against the cwd happens here, so exactly one place
    // decides what a mention means.
    onAttachFile: (relPath) => mention(`${cwd()}/${relPath}`),
    // A dragged path is a mention, not an upload: the agent has the filesystem,
    // so sending the bytes would be sending it something it can already read.
    onAttachPaths: (absPaths) => {
      for (const path of absPaths) mention(path);
    },
    // Already checked against the upload source by the composer. Written one at
    // a time so the labels come out in the order the files were dropped.
    onAttachUploads: async (files) => {
      for (const file of files) {
        const kind = attachmentKind(file.name) ?? "file";
        try {
          const path = await invoke<string>("store_attachment", file.bytes, {
            headers: { [ATTACHMENT_NAME_HEADER]: encodeURIComponent(file.name) },
          });
          offerToComposer(key(), fileMentionBlocks(path, nextLabel(key(), kind)));
        } catch (e) {
          onRejected(`${file.name} could not be saved: ${String(e)}`);
        }
      }
    },
  };
}
