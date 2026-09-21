// Installing a language server from the editor. The backend does the work
// (`src-tauri/src/lsp/managed.rs`); this module holds the banner's offers and
// announces an arrival without importing the editor, so Settings can use it too.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors `managed::NOT_INSTALLED`, what `lsp_start` rejects a server with
 *  when Tori could install it. */
export const NOT_INSTALLED = "not_installed";

/** What a pane's banner shows for one server that is not installed. */
export type InstallOffer = {
  serverId: string;
  label: string;
  /** The open files that asked for this server. */
  files: string[];
  status: "offered" | "installing" | "failed";
  error: string | null;
};

const [offers, setOffers] = createSignal<InstallOffer[]>([]);

// Not now is an answer for the session: every file of that language would ask
// again otherwise.
const answered = new Set<string>();

let listeners: ((serverId: string) => void)[] = [];

/** Hear about a server being installed. Returns an unsubscribe. */
export function onServerInstalled(cb: (serverId: string) => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function patch(serverId: string, change: Partial<InstallOffer>) {
  setOffers(offers().map((o) => (o.serverId === serverId ? { ...o, ...change } : o)));
}

/** Record that `file` asked for a server that is not installed. */
export function offerInstall(serverId: string, label: string, file: string): void {
  if (answered.has(serverId)) return;
  const offer = offers().find((o) => o.serverId === serverId);
  if (!offer) setOffers([...offers(), { serverId, label, files: [file], status: "offered", error: null }]);
  else if (!offer.files.includes(file)) patch(serverId, { files: [...offer.files, file] });
}

/** The offer for `file`, if one is open. */
export function offerFor(file: string | null): InstallOffer | null {
  return offers().find((o) => file !== null && o.files.includes(file)) ?? null;
}

/** Not now, or Never: drop the offer and do not make it again this session. */
export function dismissOffer(serverId: string): void {
  answered.add(serverId);
  setOffers(offers().filter((o) => o.serverId !== serverId));
}

/** Install (or update) Tori's copy of a server. On failure the offer, if there
 *  is one, says why, and the promise rejects for any other caller. */
export async function installServer(serverId: string): Promise<void> {
  patch(serverId, { status: "installing", error: null });
  try {
    await invoke("lsp_install", { serverId });
  } catch (e) {
    patch(serverId, { status: "failed", error: String(e) });
    throw e;
  }
  setOffers(offers().filter((o) => o.serverId !== serverId));
  for (const l of [...listeners]) l(serverId);
}
