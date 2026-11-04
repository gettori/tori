// A second request while one is open is dropped rather than queued: a page
// could otherwise line up installs behind the one the user is reading.
import { createSignal } from "solid-js";
import { emitWith, TOAST, type ToastEvent } from "./events";
import type { PackKind } from "./packs";

export type PackInstallOrigin = "link" | "editor" | "upgrade";

export type PackInstallRequest = {
  kind: PackKind;
  id: string;
  origin: PackInstallOrigin;
};

const [pendingPackInstall, setPending] = createSignal<PackInstallRequest | null>(null);
export { pendingPackInstall };

export function requestPackInstall(request: PackInstallRequest): boolean {
  if (pendingPackInstall()) {
    emitWith<ToastEvent>(TOAST, {
      message: `Finish the open pack install before ${request.id}.`,
    });
    return false;
  }
  setPending(request);
  return true;
}

export function dismissPackInstall() {
  setPending(null);
}
