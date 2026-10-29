import { convertFileSrc } from "@tauri-apps/api/core";
import { attachmentKind, chipLabel } from "../../utils/chatCompose";
import type { ContentBlock } from "../../utils/chatTypes";
import { isPdfPath } from "../../utils/pathScope";
import { excerptOf, type TipContent } from "./Tip";

/** What the prose names this attachment by, or null for a chip that is not one
 *  (a selection, a hunk comment: they have no token to insert). */
export function tokenOf(block: ContentBlock): string | null {
  return block.type === "fileRef" ? (block.label ?? null) : null;
}

/** The picture on the chip, or null for a chip that is not an image. A path is
 *  drawn through the asset protocol; the bytes of a replayed `image` block are
 *  drawn as they arrived. */
export function thumbSrc(block: ContentBlock): string | null {
  if (block.type === "image") return `data:${block.mediaType};base64,${block.data}`;
  if (block.type === "fileRef" && block.label && attachmentKind(block.path) === "image") {
    return convertFileSrc(block.path);
  }
  return null;
}

/** Whether the chip is a tile with a preview box, or a pill of text. The two
 *  never share a row, so this is also which grid it goes in. */
export function isTile(block: ContentBlock): boolean {
  return block.type === "fileRef" || block.type === "image" || block.type === "imageRef";
}

/** What a tile is captioned by. A tile is looked at rather than read, so the
 *  file's own name leads and the label goes under it. */
export function tileName(block: ContentBlock): string {
  if (block.type === "image") return "Pasted image";
  if (block.type === "imageRef") return "Earlier image";
  if (block.type !== "fileRef") return chipLabel(block);
  return block.path.split("/").pop() || block.path;
}

function span(block: Extract<ContentBlock, { type: "fileRef" }>): string | null {
  if (block.startLine === null) return null;
  const pdf = isPdfPath(block.path);
  const end = block.endLine !== null && block.endLine !== block.startLine ? block.endLine : null;
  if (pdf) return end ? `p.${block.startLine}-${end}` : `p.${block.startLine}`;
  return end ? `L${block.startLine}-L${end}` : `L${block.startLine}`;
}

/** The line under the name: the token the prose says this attachment by, or
 *  the region a selection covers. Null when the chip is neither. */
export function tileNote(block: ContentBlock): string | null {
  if (block.type !== "fileRef") return null;
  return block.label ?? span(block);
}

/** A selection's range in words: "Lines 40 to 58", "Page 3". */
function rangeWords(block: Extract<ContentBlock, { type: "fileRef" }>): string {
  const unit = isPdfPath(block.path) ? "Page" : "Line";
  const end = block.endLine !== null && block.endLine !== block.startLine ? block.endLine : null;
  return end ? `${unit}s ${block.startLine} to ${end}` : `${unit} ${block.startLine}`;
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at > 0 ? path.slice(0, at) : path;
}

const KIND_WORDS = { image: "Image", pdf: "PDF", file: "File" } as const;

/** Everything worth knowing about a chip before clicking it. `nameable` is
 *  false for a sent prompt's chip, which no longer goes into any message. */
export function attachmentTip(block: ContentBlock, opts: { missing?: boolean; nameable?: boolean } = {}): TipContent {
  const preview = "Click to preview";
  if (block.type === "fileRef") {
    const kind = attachmentKind(block.path);
    const lines = [dirOf(block.path)];
    const where = span(block);
    if (where) lines.push(rangeWords(block));
    else if (!block.label) lines.push("The whole file");
    if (block.label) lines.push(`${kind ? KIND_WORDS[kind] : "File"} attachment, ${block.label} in the message`);
    return {
      heading: tileName(block),
      lines,
      excerpt: excerptOf(block.text),
      warn: opts.missing ? "No file at this path any more. It was moved or deleted after it was attached." : null,
      hint:
        block.label && opts.nameable !== false ? `${preview}. Cmd+click or drag to name it in the message` : preview,
    };
  }
  switch (block.type) {
    case "image":
      return { heading: "Pasted image", lines: [block.mediaType], hint: preview };
    case "imageRef":
      return { heading: "Image from an earlier turn" };
    case "text":
      return { heading: "Note to the agent", excerpt: excerptOf(block.text, 12), hint: preview };
    case "ref": {
      const t = block.target;
      switch (t.kind) {
        case "pr":
          return {
            heading: `${block.label} ${t.title}`,
            lines: [t.draft ? "Draft pull request" : `Pull request, ${t.state}`, `${t.head} into ${t.base}`],
            hint: `${preview}. The agent reads it through the forge`,
          };
        case "session":
          return {
            heading: t.title,
            lines: [`Session, ${t.agent}`, t.project],
            hint: `${preview}. The agent reads its transcript through Tori`,
          };
        case "project":
          return { heading: t.name, lines: [`Project in ${t.space}`, t.folder], hint: preview };
        case "space": {
          const count = t.projects.length === 1 ? "1 project" : `${t.projects.length} projects`;
          return {
            heading: t.name,
            lines: [`Space, ${count}`, t.projects.map((p) => p.name).join(", ")],
            hint: preview,
          };
        }
      }
    }
  }
}
