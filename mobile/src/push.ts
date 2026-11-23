import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { METHOD_NOT_FOUND, RpcError, type RemoteClient } from "./remote";

const RELAY = import.meta.env.VITE_TORI_RELAY ?? "https://relay.gettori.app";

export const OLD_MAC = "Tori on your Mac is too old for alerts with the app closed: update Tori";
const NO_SHELL = "Alerts with the app closed need the Android app.";

type Pair = { on: boolean; handle?: string; key?: string };
export type Tap = { session: string; project: string; folder: string | null; branch: string | null };

const [alerts, setAlerts] = createSignal(false);
const [alertsNote, setAlertsNote] = createSignal<string | null>(null);
export { alerts, alertsNote };

const native = <T = void>(command: string, args: Record<string, unknown> = {}) =>
  invoke<T>(`plugin:tori-push|${command}`, args);

const said = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

async function hand(client: RemoteClient, pair: Pair) {
  try {
    await client.request("push.set", { handle: pair.handle, key: pair.key });
    setAlerts(true);
    setAlertsNote(null);
  } catch (e) {
    if (!(e instanceof RpcError && e.code === METHOD_NOT_FOUND)) throw e;
    await native("disable").catch(() => {});
    setAlerts(false);
    setAlertsNote(OLD_MAC);
  }
}

// The Mac needs this phone's current handle after a token refresh or a
// pairing again, and has to forget it if alerts went off while away.
export async function syncAlerts(client: RemoteClient) {
  const pair = await native<Pair>("state").catch(() => null);
  if (!pair) return;
  setAlerts(pair.on);
  if (pair.on) return hand(client, pair).catch(() => {});
  await client.request("push.clear").catch(() => {});
}

let turningOn = false;

export async function turnOn(client: RemoteClient) {
  if (turningOn) return;
  if (!("__TAURI_INTERNALS__" in window)) return setAlertsNote(NO_SHELL);
  if (client.status() !== "open") return setAlertsNote("Connect to Tori first.");
  turningOn = true;
  setAlertsNote(null);
  try {
    await hand(client, await native<Pair>("enable", { relay: RELAY }));
  } catch (e) {
    await native("disable").catch(() => {});
    setAlerts(false);
    setAlertsNote(said(e));
  } finally {
    turningOn = false;
  }
}

export async function takeTap(): Promise<Tap | null> {
  const opened = await native<{ tap: Tap | null }>("opened").catch(() => null);
  return opened?.tap ?? null;
}

export async function turnOff(client: RemoteClient) {
  setAlerts(false);
  setAlertsNote(null);
  await Promise.all([client.request("push.clear").catch(() => {}), native("disable").catch(() => {})]);
}
