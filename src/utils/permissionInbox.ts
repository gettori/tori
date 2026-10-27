import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pushToast } from "../components/Toasts/Toasts";
import { emitWith, NAVIGATE, type NavTarget } from "./events";
import { setPendingCard } from "./pendingCard";
import type { PermissionRow } from "./permissionGroups";

const [permissionRows, setPermissionRows] = createSignal<PermissionRow[]>([]);
export { permissionRows };

export const permissionCount = () => permissionRows().length;

let request = 0;

export async function refreshPermissions() {
  const mine = ++request;
  const rows = await invoke<PermissionRow[]>("permissions_pending").catch(() => null);
  if (rows && mine === request) setPermissionRows(rows);
}

export async function allowGroup(rows: PermissionRow[]) {
  const ids = rows.map((r) => ({ session: r.session, id: r.id }));
  await invoke<{ failed: string[] }>("permissions_allow_group", { ids })
    .then(({ failed }) => {
      if (failed.length) pushToast(`${failed.length} of ${ids.length} did not reach the agent: ${failed[0]}`);
    })
    .catch((e) => pushToast(`The allow did not reach the agents: ${String(e)}`));
  void refreshPermissions();
}

export async function denyPermission(row: PermissionRow) {
  await invoke("permissions_deny", { session: row.session, id: row.id }).catch((e) =>
    pushToast(`The deny did not land: ${String(e)}`),
  );
  void refreshPermissions();
}

export function openPermission(row: PermissionRow) {
  setPendingCard(row.session);
  emitWith<NavTarget>(NAVIGATE, { folder: row.folder, session: row.session });
}

let started = false;

export function watchPermissions() {
  if (started) return;
  started = true;
  void listen("permissions://changed", () => void refreshPermissions());
  void refreshPermissions();
}
