import type { ContentBlock } from "./chatTypes";

/** Text Tori wrote into a chat itself, marked by `from_tori` in src-tauri/src/rpc/events.rs. */
export type ToriNote = { kind: string; from: string | null; body: string };

const MARK = /^<tori kind="([^"]+)"(?: from="([^"]*)")?>\n([\s\S]*)\n<\/tori>$/;

export const toriText = (kind: string, body: string) => `<tori kind="${kind}">\n${body}\n</tori>`;

export function toriNote(blocks: ContentBlock[]): ToriNote | null {
  const [only] = blocks;
  if (blocks.length !== 1 || only.type !== "text") return null;
  const m = MARK.exec(only.text.trim());
  return m ? { kind: m[1], from: m[2] ?? null, body: m[3] } : null;
}
