// Mirrors src-tauri/src/lsp/registry.rs's `LspServer` (the JSON `lsp_registry`
// returns), so the frontend can answer "which server claims this file, and what
// language id does it open as" without hardcoding an extension list.
//
// Snake_case field names, matching the Rust struct and `utils/agents.ts`: these
// registry mirrors are the one place Tori keeps the backend's spelling rather
// than camel-casing at the boundary.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { isToriSettingsFile } from "./toriSettingsFiles";

export type LspLaunch =
  | { kind: "bundled_node"; entry: string; args: string[] }
  | { kind: "path"; program: string; args: string[] }
  | { kind: "project_bin"; program: string; args: string[] }
  | { kind: "managed"; program: string; args: string[]; runtime: "node" | "native" };

export type LspFeature = "diagnostics" | "code_action" | "format";

export type LspServer = {
  id: string;
  label: string;
  /** Extension (dotless, lowercase) to LSP language id. */
  languages: Record<string, string>;
  root_markers: string[];
  /** Per-server request timeout. The library's own default is 3s, which is far
   *  too tight for a server that indexes on startup. */
  request_timeout_ms: number;
  launch: LspLaunch;
  initialization_options: unknown | null;
  /** Free-form server configuration, delivered both ways: pushed once as
   *  `workspace/didChangeConfiguration`, and answered section by section
   *  whenever the server pulls with `workspace/configuration`. Servers
   *  disagree about which one they read, and a config author should not have
   *  to know which. */
  settings: Record<string, unknown> | null;
  /** Send this server the SchemaStore catalog as `json/schemaAssociations`
   *  after initialize. One server's protocol extension, so it is opted into by
   *  config rather than handed to everything. */
  schema_associations: boolean;
  verified_against: string | null;
  /** Refused by `lsp_start` in a project the user has not trusted. */
  runs_project_code: boolean;
  role: "primary" | "secondary";
  priority: number;
  features: LspFeature[];
  activation_markers: string[];
  activation_keys: { file: string; path: string[] }[];
  source: string;
};

/** Mirrors `lsp::Resolution`: the servers one file gets, by id. */
export type Resolution = { primary: string | null; secondaries: string[] };

// Empty until `lsp_registry` resolves, and empty is a *correct* state rather
// than a degraded one: no server claims anything, so nothing gets a plugin, so
// files open and edit exactly as they do for a language Tori has no server for.
// The load fires `onLspChange` through its subscriber, which is what makes a
// file opened during startup attach once the registry lands.
const [servers, setServers] = createSignal<LspServer[]>([]);
export { servers };

let requested: Promise<void> | null = null;
let onLoaded: (() => void) | null = null;

/** Called once the registry lands, so open buffers can re-ask for a plugin. */
export function setRegistryListener(cb: () => void) {
  onLoaded = cb;
}

/** Load the registry once per process. Safe to call from anywhere; later calls
 *  await the same request rather than issuing another. */
export function ensureLspServersLoaded(): Promise<void> {
  if (requested) return requested;
  requested = invoke<LspServer[]>("lsp_registry")
    .then((list) => {
      setServers(list);
      onLoaded?.();
    })
    .catch((e) => {
      // A registry that fails to load leaves every file server-less, which is
      // the same shape as a language with no server: degraded, never broken.
      console.error("lsp_registry failed", e);
    });
  return requested;
}

/** A path's extension, dotless and lowercase.
 *
 *  Taken from the basename so a dotted *directory* cannot fake one, and
 *  matching `LspServer::language_id_for` in registry.rs exactly: the two
 *  disagreeing would mean the frontend asks a server about a file the backend
 *  never claimed. */
function extensionOf(path: string): string | null {
  const file = path.split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  // `>0` not `>=0`: a dotfile like `.zshrc` has no extension, it *is* its name.
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : null;
}

/** Whether any registered server claims this path's extension. */
export function hasServerFor(path: string): boolean {
  const ext = extensionOf(path);
  return !!ext && servers().some((s) => ext in s.languages);
}

/** Every primary claiming this path's extension: what a caller that cannot wait
 *  for `resolveServers` has to choose among. */
export function primariesClaiming(path: string): LspServer[] {
  const ext = extensionOf(path);
  return ext ? servers().filter((s) => s.role === "primary" && ext in s.languages) : [];
}

/** The registered server with this id, or null. */
export function serverById(id: string): LspServer | null {
  return servers().find((s) => s.id === id) ?? null;
}

// Keyed by directory and extension, which is all a resolution depends on apart
// from settings and markers, and those clear it through `forgetResolutions`.
const resolutions = new Map<string, Resolution>();
let forgotten = 0;

function resolutionKey(path: string): string {
  return `${path.slice(0, path.lastIndexOf("/"))}\u0000${extensionOf(path)}`;
}

/** Which servers `path` gets, asked of the backend once per directory and
 *  extension. `fresh` says the answer was not cached before this call. */
export async function resolveServers(
  path: string,
  projectPath: string,
): Promise<{ resolution: Resolution; fresh: boolean }> {
  const key = resolutionKey(path);
  const cached = resolutions.get(key);
  if (cached) return { resolution: cached, fresh: false };
  const before = forgotten;
  const resolution = await invoke<Resolution>("lsp_resolve", { filePath: path, projectPath });
  // Cleared while this was in flight: the answer may predate the marker or
  // setting that caused the clear, so it is asked again rather than cached.
  if (forgotten !== before) return resolveServers(path, projectPath);
  resolutions.set(key, resolution);
  return { resolution, fresh: true };
}

/** The cached primary for `path`: null when it has none, undefined when its
 *  directory has not been resolved yet. */
export function resolvedPrimary(path: string): LspServer | null | undefined {
  const resolution = resolutions.get(resolutionKey(path));
  if (!resolution) return undefined;
  return resolution.primary ? serverById(resolution.primary) : null;
}

/** Every server the cached resolution for `path` names, primary first:
 *  undefined when its directory has not been resolved yet. */
export function resolvedServerIds(path: string): string[] | undefined {
  const resolution = resolutions.get(resolutionKey(path));
  if (!resolution) return undefined;
  return resolution.primary ? [resolution.primary, ...resolution.secondaries] : resolution.secondaries;
}

/** Drop cached resolutions for directories at or under `dir`, or all of them. */
export function forgetResolutions(dir?: string): void {
  forgotten += 1;
  if (dir === undefined) {
    resolutions.clear();
    return;
  }
  for (const key of [...resolutions.keys()]) {
    const keyDir = key.slice(0, key.indexOf("\u0000"));
    if (keyDir === dir || keyDir.startsWith(`${dir}/`)) resolutions.delete(key);
  }
}

/** Whether a change to this file can change what some file resolves to. */
export function isActivationMarker(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return servers().some((s) => s.activation_markers.includes(name) || s.activation_keys.some((k) => k.file === name));
}

/** The LSP language id to open this path as, for its claiming server.
 *
 *  Tori's own settings files are the one exception to "the extension decides".
 *  They end in `.json` but are read with json5, so a comment in one is
 *  supported; the JSON server reports comments as errors under every language
 *  id but `jsonc`. Only offered to a server that declared it speaks `jsonc`,
 *  since an id a server never advertised is one it may not answer for.
 *
 *  This changes the id, never *which* server is asked, so it stays consistent
 *  with `registry.rs`'s `language_id_for`: the backend reads that only as "does
 *  some server claim this file", and the answer here is unchanged. */
export function languageIdFor(server: LspServer, path: string): string | null {
  const ext = extensionOf(path);
  if (!ext) return null;
  const id = server.languages[ext] ?? null;
  if (id && isToriSettingsFile(path) && Object.values(server.languages).includes("jsonc")) return "jsonc";
  return id;
}
