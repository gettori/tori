// Every request gets a reply, an error when nothing handles it, so the socket
// caller hears why rather than waiting out the Rust side's timeout.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { asTabProfile } from "./agentHealth";
import { quotaBand, quotaState } from "./chatRateLimit";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "./events";
import { usageWarnAt } from "./usageSettings";
import { windowsFor } from "./usageStore";

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

export function serveRpcBridge(): Promise<UnlistenFn> {
  return listen<Request>("rpc://request", async ({ payload: { rid, method, params } }) => {
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
}

handleRpc("window.open", ({ path, line }: { path: string; line: number | null }) => {
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path, ...(line ? { line } : {}) });
  return {};
});

handleRpc("usage.windows", ({ agent, account }: { agent: string; account: string | null }) => {
  const profile = asTabProfile(account);
  const warnAt = usageWarnAt(agent, profile);
  const now = Date.now();
  return windowsFor(agent, profile).map((w) => {
    const state = quotaState(w, warnAt, now);
    return { kind: w.kind, utilization: w.utilization, resetsAt: w.resetsAt, state, band: quotaBand(w, state) };
  });
});
