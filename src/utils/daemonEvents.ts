import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { watchDaemon, type DaemonStatus } from "./daemonStatus";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "./events";
import { closeAsk, loadPendingAsks, showAsk, type SocketAsk } from "./socketAsks";

export async function serveDaemonEvents(): Promise<UnlistenFn> {
  const opened = await listen<{ path: string; line: number | null }>("window://open", ({ payload: { path, line } }) =>
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path, ...(line ? { line } : {}) }),
  );
  void invoke("window_listening").catch((e) => console.error("window_listening:", e));
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
    opened();
    shown();
    closed();
    relinked();
    unwatch();
  };
}
