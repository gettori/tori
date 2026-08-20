// The composer's attachment handlers, shared by the two surfaces that draw one.
//
// A draft tab and a live chat host the same composer, and what a mention *means*
// must not depend on which of them the user typed into: a relative path resolved
// against the wrong root, or a dragged file uploaded by one surface and mentioned
// by the other, would be a difference nobody could see until the agent read it.
// So the four handlers live here once and both surfaces pass their own key.
import { invoke } from "@tauri-apps/api/core";
import { fileMentionBlocks, imageBlocks, offerToComposer, type ComposerKey } from "../../utils/chatCompose";

export type ComposerAttachments = {
  loadProjectFiles: () => Promise<string[]>;
  onAttachFile: (relPath: string) => void;
  onAttachPaths: (absPaths: string[]) => void;
  onAttachImages: (images: { mediaType: string; base64: string }[]) => void;
};

/** `key` and `cwd` are read per call rather than captured, so a surface whose
 *  tab moves or whose session is minted mid-life keeps attaching to itself. */
export function composerAttachments(key: () => ComposerKey, cwd: () => string): ComposerAttachments {
  return {
    // The project's file index, for `@` completion. Fetched on demand rather
    // than on mount: it is a full walk of the tree, and a chat that never
    // mentions a file should not pay for one. The composer asks once and caches.
    loadProjectFiles: () => invoke<string[]>("list_project_files", { projectPath: cwd() }).catch(() => []),
    // A completed `@` mention. The composer hands back the project-relative path
    // it showed; resolving it against the cwd happens here, so exactly one place
    // decides what a mention means.
    onAttachFile: (relPath) => offerToComposer(key(), fileMentionBlocks(`${cwd()}/${relPath}`)),
    // A dragged path is a mention, not an upload: the agent has the filesystem,
    // so sending the bytes would be sending it something it can already read.
    onAttachPaths: (absPaths) => {
      for (const path of absPaths) offerToComposer(key(), fileMentionBlocks(path));
    },
    onAttachImages: (images) => {
      for (const img of images) offerToComposer(key(), imageBlocks(img.mediaType, img.base64));
    },
  };
}
