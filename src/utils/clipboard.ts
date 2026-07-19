// One copy path for the whole app.
//
// The webview's `navigator.clipboard.writeText` is the fast path, but in a Tauri
// window it can reject (no user-gesture attribution on a context-menu click, or
// a non-secure origin). Failure is taken from the promise itself; there is
// deliberately no read-back check, which would need clipboard-read permission
// and would race anything else writing to the pasteboard. On rejection we fall
// back to the Tauri clipboard plugin, which writes through the native
// pasteboard API and has no such constraints.
import { writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      await tauriWriteText(text);
      return true;
    } catch {
      return false;
    }
  }
}
