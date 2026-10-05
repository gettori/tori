// The prompt stash. `chat/stash_store.rs` is the file's only writer, since
// removing an entry sweeps the uploads it named, so this side only holds the
// list the backend last answered.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  checkAttachment,
  draftFor,
  offerToComposer,
  parseLabel,
  pendingFor,
  pushHistory,
  relabelInto,
  setDraft,
  stashComposer,
  stripToken,
  unstashComposer,
  type AttachCheck,
  type AttachmentSource,
  type ComposerKey,
} from "../../utils/chatCompose";
import type { ContentBlock } from "../../utils/chatTypes";
import { TOAST, emitWith, type ToastEvent } from "../../utils/events";
import { attachmentsDir } from "./composerAttachments";

export type StashEntry = { id: string; text: string; chips: ContentBlock[]; at: number };

/** Where a restored chip is checked: uploads against what the agent takes as
 *  bytes, everything else against what it reads as a mention. */
export type StashSources = { mentions: AttachmentSource; uploads: AttachmentSource };

const [entries, setEntries] = createSignal<StashEntry[]>([]);
let loading: Promise<void> | null = null;
// One chain, so the list a reply carries is never older than one already shown.
let chain: Promise<unknown> = Promise.resolve();
let seq = 0;

/** Oldest first, as the file keeps them. */
export function stashEntries(): readonly StashEntry[] {
  return entries();
}

export function loadStash(): Promise<void> {
  const load = (loading ??= invoke<unknown>("stash_list").then(
    (raw) => {
      setEntries(valid(raw));
    },
    () => {
      loading = null;
    },
  ));
  return load;
}

function valid(raw: unknown): StashEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is StashEntry =>
      typeof e?.id === "string" && typeof e?.text === "string" && Array.isArray(e?.chips) && typeof e?.at === "number",
  );
}

function queued<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op);
  chain = next.catch(() => {});
  return next;
}

function toast(message: string) {
  emitWith<ToastEvent>(TOAST, { message, kind: "error" });
}

// Durable rather than per run: the backend takes and discards by this id, and
// it outlives a relaunch.
function newId(): string {
  return `${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

function push(entry: StashEntry): Promise<void> {
  return queued(() => invoke<unknown>("stash_push", { entry })).then((raw) => {
    setEntries(valid(raw));
  });
}

/** Park the composer's draft and chips, leaving it empty. A failed write
 *  hands them back: as the draft while the composer is still empty, to recall
 *  history otherwise, the rule a queued edit follows. */
export async function stashDraft(key: ComposerKey): Promise<boolean> {
  const taken = stashComposer(key);
  if (!taken.draft.trim() && !taken.chips.length) {
    unstashComposer(key, taken);
    return false;
  }
  try {
    await push({ id: newId(), text: taken.draft, chips: taken.chips.map((p) => p.block), at: Date.now() });
    return true;
  } catch (e) {
    if (!draftFor(key) && !pendingFor(key).length) unstashComposer(key, taken);
    else pushHistory(key, taken.draft);
    toast(`Could not stash the draft: ${String(e)}`);
    return false;
  }
}

function verdictFor(block: ContentBlock, count: number, sources: StashSources, dir: string | null): AttachCheck | null {
  if (block.type === "image")
    return checkAttachment({ name: "", mediaType: block.mediaType, bytes: null }, count, sources.uploads);
  if (block.type !== "fileRef" || !block.label) return null;
  const upload = dir !== null && block.path.startsWith(`${dir}/`);
  const name = block.path.split("/").pop() || block.path;
  return checkAttachment({ name, mediaType: "", bytes: null }, count, upload ? sources.uploads : sources.mentions);
}

/** Bring an entry back numbered for `key`. A chip this agent cannot open
 *  stays stashed so no upload is lost, and text typed while the entry was on
 *  its way wins: the entry goes back untouched. */
export async function restoreEntry(key: ComposerKey, id: string, sources: StashSources): Promise<void> {
  let entry: StashEntry | undefined;
  try {
    const reply = await queued(() => invoke<{ entry: unknown; stash: unknown }>("stash_take", { id }));
    setEntries(valid(reply.stash));
    entry = valid([reply.entry])[0];
  } catch (e) {
    toast(`Could not restore the draft: ${String(e)}`);
    return;
  }
  if (!entry) return;
  const dir = await attachmentsDir();
  if (draftFor(key) || pendingFor(key).length) {
    await push(entry).catch((e) => toast(`Could not put the draft back: ${String(e)}`));
    return;
  }
  const kept: ContentBlock[] = [];
  const refused: ContentBlock[] = [];
  const reasons = new Set<string>();
  let text = entry.text;
  for (const block of entry.chips) {
    const verdict = verdictFor(block, kept.length, sources, dir);
    if (verdict && !verdict.ok) {
      refused.push(block);
      reasons.add(verdict.reason);
      if (block.type === "fileRef" && block.label && parseLabel(block.label)) text = stripToken(text, block.label);
    } else {
      kept.push(block);
    }
  }
  const moved = relabelInto(key, text, kept);
  offerToComposer(key, moved.blocks);
  setDraft(key, moved.text);
  if (!refused.length) return;
  toast([...reasons].join(" "));
  await push({ id: newId(), text: "", chips: refused, at: entry.at }).catch((e) =>
    toast(`Could not keep the refused attachments: ${String(e)}`),
  );
}

export function discardEntry(id: string): Promise<void> {
  return queued(() => invoke<unknown>("stash_discard", { id })).then(
    (raw) => {
      setEntries(valid(raw));
    },
    (e) => toast(`Could not discard the draft: ${String(e)}`),
  );
}
