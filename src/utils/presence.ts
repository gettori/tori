import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

// Requests permission once per app run; a denial just means later calls also
// skip sending (isPermissionGranted is re-checked every time, so a
// mid-session grant via System Settings takes effect without a restart).
let permissionRequested = false;

async function notificationsAllowed(): Promise<boolean> {
  let granted = await isPermissionGranted().catch(() => false);
  if (!granted && !permissionRequested) {
    permissionRequested = true;
    granted = (await requestPermission().catch(() => "denied")) === "granted";
  }
  return granted;
}

/// A quota window crossing into approaching or reached, for an account rather
/// than a session. No target: the news is about a login, and three chats may
/// be on it, so there is no one tab a click could honestly focus.
export async function notifyQuota(title: string, body: string) {
  if (!(await notificationsAllowed())) return;
  try {
    sendNotification({ title, body });
  } catch {
    // Best-effort: a notification that fails to show changes nothing else.
  }
}
