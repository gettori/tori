// Once per outage rather than on every retry.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { pushToast } from "../components/Toasts/Toasts";

export type DaemonStatus =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "unreachable"; message: string }
  | { state: "restartNeeded"; message: string }
  | { state: "off" }
  | { state: "gaveUp"; message: number };

let last: DaemonStatus["state"] | undefined;

export function noteDaemonStatus(status: DaemonStatus | null) {
  if (!status) return;
  if (status.state === "unreachable" && last !== "unreachable") {
    pushToast(`The Tori daemon cannot be reached, so tori and MCP tools cannot reach Tori: ${status.message}`);
  }
  if (status.state === "connected" || status.state === "unreachable") last = status.state;
}

export async function watchDaemon(): Promise<UnlistenFn> {
  const unlisten = await listen<DaemonStatus>("daemon://status", ({ payload }) => noteDaemonStatus(payload));
  noteDaemonStatus(await invoke<DaemonStatus | null>("daemon_status").catch(() => null));
  return unlisten;
}
