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
import type { ChatCapabilities, ContentBlock } from "../../utils/chatTypes";
import type { PullRequest } from "../../utils/forgeTypes";
import { ensurePrList, prListEntry } from "../../utils/prListStore";
import { prLabel, prRef } from "../../utils/prMention";
import { createSignal } from "solid-js";
import type { SessionMeta } from "../../utils/sessionStore";
import { refLabel, refName, sessionRef, sessionTitle } from "../../utils/sessionMention";
import { projectRef, spaceRef, type NavProject, type NavSpace } from "../../utils/mentionNavigator";
import { samePath } from "../LeftSidebar/attempts";

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
  /** Answers the token the session's chip is named by. `project` is the
   *  folder of the project it was picked under, the chat's own by default. */
  onAttachSession: (s: SessionMeta, project?: string) => string;
  /** Every space for `@spaces/` and `@projects/`, undefined like `sessions`,
   *  and the one the chat's project sits in. */
  spaces: () => readonly NavSpace[] | undefined;
  here: () => NavSpace | null;
  /** A project's sessions across its every checkout, and a checkout's files,
   *  read on the first ask for each and empty until then. */
  sessionsOf: (projectPath: string) => readonly SessionMeta[];
  filesOf: (folder: string) => readonly string[];
  loadSessionsOf: (projectPath: string) => void;
  loadFilesOf: (folder: string) => void;
  onAttachProject: (space: NavSpace, project: NavProject) => string;
  onAttachSpace: (space: NavSpace) => string;
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
  const [project, setProject] = createSignal<string | null>(null);
  const [spaces, setSpaces] = createSignal<NavSpace[]>([]);
  const [sessionsBy, setSessionsBy] = createSignal<Record<string, SessionMeta[]>>({});
  const [filesBy, setFilesBy] = createSignal<Record<string, string[]>>({});

  // Labels the pending refs already hold, each against what it names, so a
  // second pick of one target reuses its token and two targets never share one.
  function taken(): Map<string, string> {
    const by = new Map<string, string>();
    for (const p of pendingFor(key())) {
      if (p.block.type !== "ref") continue;
      const t = p.block.target;
      const id =
        t.kind === "pr" ? String(t.number) : t.kind === "session" ? t.id : t.kind === "project" ? t.folder : t.name;
      by.set(p.block.label, `${t.kind}:${id}`);
    }
    return by;
  }

  function attachRef(
    kind: "Session" | "Project" | "Space",
    name: string,
    id: string,
    block: (label: string) => ContentBlock,
  ) {
    const held = taken();
    const owner = `${kind.toLowerCase()}:${id}`;
    const label = refLabel(kind, refName(name), held, owner);
    if (held.get(label) !== owner) offerToComposer(key(), [block(label)]);
    return label;
  }

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
    // the cwd would hide. A new `@` reads it afresh and drops what the
    // navigator read under the last one.
    loadSessions: () =>
      void (async () => {
        setSessionsBy({});
        setFilesBy({});
        const folder = cwd();
        const root = (await invoke<string | null>("project_of_folder", { folder }).catch(() => null)) ?? folder;
        setProject(root);
        setListed(await invoke<SessionMeta[]>("list_sessions", { folder: root, inclusive: true }).catch(() => []));
        if (toriMcp()) setSpaces((await invoke<{ spaces: NavSpace[] }>("get_config").catch(() => null))?.spaces ?? []);
      })(),
    onAttachSession: (s, at) =>
      attachRef("Session", sessionTitle(s), s.id, (label) => sessionRef(s, label, at ?? project() ?? s.cwd)),
    spaces: () => (toriMcp() ? spaces() : undefined),
    here: () => spaces().find((g) => g.projects.some((p) => samePath(p.path, project() ?? ""))) ?? null,
    sessionsOf: (path) => (sessionsBy()[path] ?? []).filter((s) => s.id !== self()),
    filesOf: (folder) => filesBy()[folder] ?? [],
    loadSessionsOf: (path) => {
      if (path in sessionsBy()) return;
      setSessionsBy((m) => ({ ...m, [path]: [] }));
      void invoke<SessionMeta[]>("list_sessions", { folder: path, inclusive: true })
        .catch(() => [])
        .then((list) => setSessionsBy((m) => ({ ...m, [path]: list })));
    },
    loadFilesOf: (folder) => {
      if (folder in filesBy()) return;
      setFilesBy((m) => ({ ...m, [folder]: [] }));
      void invoke<string[]>("list_project_files", { projectPath: folder })
        .catch(() => [])
        .then((list) => setFilesBy((m) => ({ ...m, [folder]: list })));
    },
    onAttachProject: (space, p) => attachRef("Project", p.name, p.path, (label) => projectRef(space, p, label)),
    onAttachSpace: (space) => attachRef("Space", space.name, space.name, (label) => spaceRef(space, label)),
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
