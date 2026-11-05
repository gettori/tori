// A pack is offered once a session whatever the answer was, so a file the
// user keeps opening does not keep asking.
import { invoke } from "@tauri-apps/api/core";
import { extensionOf } from "./lspServers";
import { requestPackInstall, type PackInstallOrigin } from "./packInstall";
import type { Catalog, CatalogPack, CatalogRow, PackKind } from "./packs";

let rows: Promise<CatalogRow[]> | null = null;

// Not revalidated: an offer sits on the path of opening a file, and must not
// put a network round trip there.
function catalogRows(): Promise<CatalogRow[]> {
  rows ??= invoke<Catalog | null>("packs_catalog", { forceRevalidate: false })
    .then((c) => (Array.isArray(c?.rows) ? c.rows : []))
    .catch((e) => {
      console.warn("packs_catalog failed", e);
      rows = null;
      return [];
    });
  return rows;
}

const claims = (pack: CatalogPack, ext: string) => (pack.extensions ?? pack.languages ?? []).includes(ext);

const offerable = (r: CatalogRow) => !r.installed && !r.bundled && !r.customFile;

export async function catalogPackFor(kind: PackKind, ext: string): Promise<CatalogPack | null> {
  const row = (await catalogRows()).find((r) => r.pack.kind === kind && offerable(r) && claims(r.pack, ext));
  return row?.pack ?? null;
}

async function catalogPackById(kind: PackKind, id: string): Promise<CatalogPack | null> {
  const row = (await catalogRows()).find((r) => r.pack.kind === kind && r.pack.id === id && offerable(r));
  return row?.pack ?? null;
}

const answered = new Set<string>();
const key = (kind: PackKind, id: string) => `${kind}:${id}`;

export function catalogOfferAnswered(kind: PackKind, id: string): boolean {
  return answered.has(key(kind, id));
}

export function answerCatalogOffer(kind: PackKind, id: string): void {
  answered.add(key(kind, id));
}

function offer(kind: PackKind, pack: CatalogPack | null, origin: PackInstallOrigin): boolean {
  if (!pack || catalogOfferAnswered(kind, pack.id)) return false;
  const taken = requestPackInstall({ kind, id: pack.id, origin });
  if (taken) answerCatalogOffer(kind, pack.id);
  return taken;
}

export async function offerPackFor(kind: PackKind, path: string, origin: PackInstallOrigin): Promise<boolean> {
  const ext = extensionOf(path);
  return !!ext && offer(kind, await catalogPackFor(kind, ext), origin);
}

export async function offerPackById(kind: PackKind, id: string, origin: PackInstallOrigin): Promise<boolean> {
  return offer(kind, await catalogPackById(kind, id), origin);
}
