// Work a language server reports as it goes, per session, for the breadcrumb
// bar. Here rather than on the client, which the bar cannot import without
// pulling CodeMirror into the startup chunk.
import { createSignal } from "solid-js";

type Handle = { serverId: string; root: string };

type Token = string | number;

type WorkDone =
  | { kind: "begin"; title?: string; message?: string; percentage?: number }
  | { kind: "report"; message?: string; percentage?: number }
  | { kind: "end" };

export type LspProgress = Handle & { token: Token; title: string; message?: string; percentage?: number };

// In begin order, so the last entry for a session is its newest piece of work.
const [active, setActive] = createSignal<readonly LspProgress[]>([]);

// Which session answers a path is the client's call, and the client is behind
// the lazy edge, so it registers the answer here and says when it may change.
let answering: (path: string) => Handle | null = () => null;
const [scope, setScope] = createSignal(0);

export function setProgressScope(fn: (path: string) => Handle | null): void {
  answering = fn;
  setScope((n) => n + 1);
}

export function progressScopeChanged(): void {
  setScope((n) => n + 1);
}

// A server reports progress only to a client that declared it. The router in
// `lspClient.ts` answers the `create` request this invites.
export const progressClientCapabilities = {
  clientCapabilities: {
    window: { workDoneProgress: true },
  },
};

export function trackProgress(handle: Handle, msg: string): boolean {
  if (!msg.includes("$/progress")) return false;
  let frame: { id?: unknown; method?: unknown; params?: { token?: unknown; value?: WorkDone } };
  try {
    frame = JSON.parse(msg);
  } catch {
    return false;
  }
  if (frame.method !== "$/progress" || frame.id !== undefined) return false;
  const token = frame.params?.token;
  const value = frame.params?.value;
  if ((typeof token !== "string" && typeof token !== "number") || !value) return false;
  const same = (p: LspProgress) => p.token === token && p.serverId === handle.serverId && p.root === handle.root;
  switch (value.kind) {
    case "begin":
      setActive((list) => [
        ...list.filter((p) => !same(p)),
        {
          serverId: handle.serverId,
          root: handle.root,
          token,
          title: value.title ?? "",
          message: value.message,
          percentage: value.percentage,
        },
      ]);
      return true;
    case "report":
      // Either field left out keeps its last value, per the specification.
      setActive((list) =>
        list.some(same)
          ? list.map((p) =>
              same(p) ? { ...p, message: value.message ?? p.message, percentage: value.percentage ?? p.percentage } : p,
            )
          : list,
      );
      return true;
    case "end":
      setActive((list) => (list.some(same) ? list.filter((p) => !same(p)) : list));
      return true;
  }
  return false;
}

export function clearProgress(handle?: Handle): void {
  setActive((list) => (handle ? list.filter((p) => p.serverId !== handle.serverId || p.root !== handle.root) : []));
}

export function progressFor(path: string | null): LspProgress | null {
  scope();
  const list = active();
  const handle = path ? answering(path) : null;
  if (!handle) return null;
  let newest: LspProgress | null = null;
  for (const p of list) if (p.serverId === handle.serverId && p.root === handle.root) newest = p;
  return newest;
}

export function progressLabel(p: LspProgress): string {
  return [p.title, p.message, p.percentage === undefined ? null : `${Math.round(p.percentage)}%`]
    .filter(Boolean)
    .join(" ");
}
