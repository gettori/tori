// What Read speaks for a reply, taken from what is on screen rather than the
// Markdown source: the rendered blocks are what the highlight has to land on,
// and the lexer's tokens do not line up with them for lists, quotes and tables.
import type { Chunk } from "../../utils/speech";
import type { ChatItem } from "./chatStore";
import styles from "./Chat.module.css";

export const CODE_SKIPPED = "Code block skipped.";

export type SpeakableBlock = { text: string; el: Element; pause: number };

// A heading or a list item gets a longer break after it than a paragraph,
// as a reader would give it.
const HEADING_PAUSE = 500;
const ITEM_PAUSE = 250;

const CONTAINERS = new Set(["UL", "OL", "DL", "TABLE", "THEAD", "TBODY", "TFOOT"]);
const MIXED = new Set(["LI", "BLOCKQUOTE", "DIV", "DETAILS", "SECTION"]);
const LEAVES = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "DT", "DD", "SUMMARY", "FIGCAPTION"]);
const isBlock = (el: Element) =>
  CONTAINERS.has(el.tagName) || MIXED.has(el.tagName) || LEAVES.has(el.tagName) || el.tagName === "TR";

const words = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function directText(el: Element): string {
  const box = el.querySelector(":scope > input[type=checkbox]") as HTMLInputElement | null;
  const state = box ? (box.checked ? "done, " : "to do, ") : "";
  return (
    state +
    words(
      [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE || (n instanceof Element && !isBlock(n)))
        .map((n) => n.textContent)
        .join(""),
    )
  );
}

function walk(el: Element, out: SpeakableBlock[]) {
  for (const child of el.children) {
    if (child.tagName === "TR") {
      const cells = [...child.children].map((c) => words(c.textContent)).filter(Boolean);
      if (cells.length) out.push({ text: cells.join(", "), el: child, pause: 0 });
    } else if (CONTAINERS.has(child.tagName)) {
      walk(child, out);
    } else if (MIXED.has(child.tagName)) {
      const own = directText(child);
      if (own) out.push({ text: own, el: child, pause: child.tagName === "LI" ? ITEM_PAUSE : 0 });
      walk(child, out);
    } else if (LEAVES.has(child.tagName)) {
      const text = words(child.textContent);
      if (text) out.push({ text, el: child, pause: child.tagName.startsWith("H") ? HEADING_PAUSE : 0 });
    }
  }
}

export function speakableBlocks(root: Element): SpeakableBlock[] {
  const out: SpeakableBlock[] = [];
  for (const seg of root.children) {
    if (seg.classList.contains(styles.mdProse)) walk(seg, out);
    else out.push({ text: CODE_SKIPPED, el: seg, pause: 0 });
  }
  return out;
}

export function speakableChunks(root: Element): Chunk[] {
  return speakableBlocks(root).map((b, block) => ({ text: b.text, block, pause: b.pause }));
}

export function lastReply(items: readonly ChatItem[], root: Element | undefined) {
  const last = [...items].reverse().find((it) => it.kind === "text");
  const body = last && root?.querySelector(`[data-reply="${CSS.escape(last.id)}"]`);
  return last && body ? { id: last.id, body } : null;
}
