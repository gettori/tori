// Every request gets a reply, an error when nothing handles it, so the socket
// caller hears why rather than waiting out the Rust side's timeout.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { watchDaemon, type DaemonStatus } from "./daemonStatus";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "./events";
import { closeAsk, loadPendingAsks, showAsk, type SocketAsk } from "./socketAsks";

type Request = { rid: number; method: string; params: Record<string, unknown> };
type Handler = (params: unknown) => unknown;

const handlers = new Map<string, Handler>();

export function handleRpc<P>(method: string, handler: (params: P) => unknown): () => void {
  const held = handler as Handler;
  handlers.set(method, held);
  return () => {
    if (handlers.get(method) === held) handlers.delete(method);
  };
}

export async function serveRpcBridge(): Promise<UnlistenFn> {
  const unlisten = await listen<Request>("rpc://request", async ({ payload: { rid, method, params } }) => {
    try {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`the Tori window cannot answer ${method}`);
      const result = await handler(params);
      await invoke("rpc_reply", { rid, result: result ?? null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await invoke("rpc_reply", { rid, error }).catch((failed) => console.error(`rpc_reply for ${method}:`, failed));
    }
  });
  // The daemon holds the asks; a card raised while this window was not
  // listening is in the pending list, read again whenever the link comes back.
  const shown = await listen<SocketAsk>("asks://show", ({ payload }) => showAsk(payload));
  const closed = await listen<{ id: string }>("asks://close", ({ payload }) => closeAsk(payload.id));
  const relinked = await listen<DaemonStatus>("daemon://status", ({ payload }) => {
    if (payload.state === "connected") void loadPendingAsks();
  });
  void loadPendingAsks();
  const unwatch = await watchDaemon();
  return () => {
    unlisten();
    shown();
    closed();
    relinked();
    unwatch();
  };
}

handleRpc("window.open", ({ path, line }: { path: string; line: number | null }) => {
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path, ...(line ? { line } : {}) });
  return {};
});
