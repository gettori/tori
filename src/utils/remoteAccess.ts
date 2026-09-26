import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { loadSettings, settings, type Settings } from "../panels/Settings/settingsStore";
import { pushToast } from "../components/Toasts/Toasts";

/** Mirrors `remote::Status` in src-tauri/src/rpc/remote.rs. */
export type RemoteStatus = { state: "off" } | { state: "listening"; url: string } | { state: "failed"; error: string };

/** What `devices_list` returns. */
export type Device = { id: string; name: string; created_ms: number; connected: boolean };

export const [remoteStatus, setRemoteStatus] = createSignal<RemoteStatus>({ state: "off" });

let saving: Promise<void> = Promise.resolve();

// Not through `set_settings`: Rust owns this block. Chained, and each change
// reloads the store before the next builds on it, so two quick changes never
// send the first one's stale value back. A change to what is already stored is
// dropped: the switch fires `onChange` when a reload moves its `checked`, and
// sending that on would reload again, forever.
export function setRemote(patch: Partial<Settings["remote"]>) {
  saving = saving
    .then(async () => {
      const next = { ...settings.remote, ...patch };
      const now = settings.remote;
      if (next.enabled === now.enabled && next.address === now.address && next.port === now.port) return;
      setRemoteStatus(await invoke<RemoteStatus>("remote_set", { remote: next }));
      await loadSettings();
    })
    .catch((e) => pushToast(`Remote access did not change: ${String(e)}`));
}
