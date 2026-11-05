import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, TOAST, type ToastEvent } from "./events";
import { requestPackInstall } from "./packInstall";
import type { PackKind } from "./packs";

export const PACK_LINK = "packs://link";

export type PackLink = { kind: PackKind; id: string };

export function takePackLink(): Promise<PackLink | null> {
  return invoke<PackLink | null>("packs_take_link").catch((e) => {
    console.warn("packs_take_link failed", e);
    return null;
  });
}

export function openPackLink(link: PackLink): void {
  if (document.querySelector('[role="dialog"]')) {
    emitWith<ToastEvent>(TOAST, { message: `Close the open dialog, then use the ${link.id} link again.` });
    return;
  }
  requestPackInstall({ ...link, origin: "link" });
}

export async function watchPackLinks(): Promise<UnlistenFn> {
  const open = async () => {
    const link = await takePackLink();
    if (link) openPackLink(link);
  };
  const off = await listen(PACK_LINK, () => void open());
  // The OS hands a launch link over before this listener is up.
  void open();
  return off;
}
