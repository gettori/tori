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
// Pasted bytes are written under Tori's app data first and become a path too.
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
import type { ChatCapabilities } from "../../utils/chatTypes";
import type { PullRequest } from "../../utils/forgeTypes";
import { ensurePrList, prListEntry } from "../../utils/prListStore";
import { prLabel, prRef } from "../../utils/prMention";
import { createSignal } from "solid-js";
import type { SessionMeta } from "../../utils/sessionStore";
import { sessionLabel, sessionRef, sessionTitle } from "../../utils/sessionMention";

/** A pasted or dropped file, as the composer read it. */
export type UploadFile = { name: string; bytes: Uint8Array };

export type ComposerAttachments = {
  loadProjectFiles: () => Promise<string[]>;
  /** Answers the token the new chip is named by, so the composer can leave the
   *  mention where it was typed; null when the file was refused. */
  onAttachFile: (relPath: string) => string | null;
  /** Both answer the tokens the new chips are named by, in arrival order and
   *  with the refused ones absent, so the composer can put them in the sentence
   *  where the file landed rather than waiting to be clicked. */
  onAttachPaths: (absPaths: string[]) => string[];
  onAttachUploads: (files: UploadFile[]) => Promise<string[]>;
  /** The open pull requests `#` lists, read on the first `#`. */
  prs: () => readonly PullRequest[];
  loadPrs: () => void;
  /** A picked pull request becomes a ref chip; picking one already held
   *  answers its token without a second chip. */
  onAttachPr: (pr: PullRequest) => string;
  resolvePr: (number: number) => Promise<PullRequest | null>;
  /** The repo's sessions for `@`, or undefined for an agent without the
   *  `tori` MCP server, which has no tool to read one through. */
  sessions: () => readonly SessionMeta[] | undefined;
  loadSessions: () => void;
  /** Answers the token the session's chip is named by. */
  onAttachSession: (s: SessionMeta) => string;
};

/** The filename rides in a header because the body is the file itself. */
export const ATTACHMENT_NAME_HEADER = "x-tori-attachment-name";

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
  capabilities: () => ChatCapabilities | null | undefined,
  onRejected: (reason: string) => void,
  toriMcp: () => boolean,
  self: () => string | null = () => null,
): ComposerAttachments {
  const [listed, setListed] = createSignal<SessionMeta[]>([]);
  let project: string | null = null;

  // A path the agent already has. Labelled by kind so the prose can name it,
  // and refused by kind when this agent's Read would not open it.
  function mention(path: string): string | null {
    const name = path.split("/").pop() || path;
    const verdict = checkAttachment(
      { name, mediaType: "", bytes: null },
      pendingFor(key()).length,
      attachmentSources(tier(), capabilities()).mentions,
    );
    if (!verdict.ok) {
      onRejected(verdict.reason);
      return null;
    }
    const label = nextLabel(key(), verdict.kind);
    offerToComposer(key(), fileMentionBlocks(path, label));
    return label;
  }

  return {
    prs: () => prListEntry(cwd()).items,
    loadPrs: () => ensurePrList(cwd()),
    onAttachPr: (pr) => {
      const label = prLabel(pr.number);
      const held = pendingFor(key()).some((p) => p.block.type === "ref" && p.block.label === label);
      if (!held) offerToComposer(key(), [prRef(pr)]);
      return label;
    },
    sessions: () => (toriMcp() ? listed().filter((s) => s.id !== self()) : undefined),
    // The repo's whole tree, every worktree included, which a plain listing of
    // the cwd would hide.
    loadSessions: () =>
      void (async () => {
        const folder = cwd();
        project = (await invoke<string | null>("project_of_folder", { folder }).catch(() => null)) ?? folder;
        setListed(await invoke<SessionMeta[]>("list_sessions", { folder: project, inclusive: true }).catch(() => []));
      })(),
    onAttachSession: (s) => {
      const taken = new Map<string, string>();
      for (const p of pendingFor(key())) {
        if (p.block.type === "ref" && p.block.target.kind === "session") taken.set(p.block.label, p.block.target.id);
      }
      const label = sessionLabel(sessionTitle(s), taken, s.id);
      if (taken.get(label) !== s.id) offerToComposer(key(), [sessionRef(s, label, project ?? s.cwd)]);
      return label;
    },
    resolvePr: (number) => invoke<PullRequest>("forge_get_pr", { projectPath: cwd(), number }).catch(() => null),
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
    onAttachPaths: (absPaths) => absPaths.map(mention).filter((label) => label !== null),
    // Already checked against the upload source by the composer. Written one at
    // a time so the labels come out in the order the files were dropped.
    onAttachUploads: async (files) => {
      const labels: string[] = [];
      for (const file of files) {
        const kind = attachmentKind(file.name) ?? "file";
        // ACP image input is bytes on the prompt itself. Keeping it inline is
        // both what the agent advertised and what avoids asking it to read a
        // path under Tori's private app-data directory.
        if (kind === "image" && capabilities()?.imageInput) {
          offerToComposer(key(), [{ type: "image", mediaType: imageMediaType(file.name), data: base64(file.bytes) }]);
          continue;
        }
        try {
          const path = await invoke<string>("store_attachment", file.bytes, {
            headers: { [ATTACHMENT_NAME_HEADER]: encodeURIComponent(file.name) },
          });
          const label = nextLabel(key(), kind);
          offerToComposer(key(), fileMentionBlocks(path, label));
          labels.push(label);
        } catch (e) {
          onRejected(`${file.name} could not be saved: ${String(e)}`);
        }
      }
      return labels;
    },
  };
}

function imageMediaType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

/** Browser-safe base64 without spreading a multi-megabyte image onto the stack. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
