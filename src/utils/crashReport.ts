// The webview's half of crash visibility, and the launch-time notice.
//
// A Rust panic is recorded by the backend's own hook (src-tauri/src/crash.rs);
// what the frontend adds is the errors only it can see, an uncaught exception
// or a rejected promise nobody awaited, sent to the same folder. Fire and
// forget: a reporter that could itself throw into the handler it reports from
// would loop.
import { invoke } from "@tauri-apps/api/core";
import { emitWith, TOAST, type ToastEvent } from "./events";
import { ago } from "./relativeTime";

export type CrashFile = {
  path: string;
  kind: "panic" | "webview" | "rejection";
  headline: string;
  at: number;
};

export type CrashLogs = {
  version: string;
  dir: string;
  /** Newest first. */
  files: CrashFile[];
};

/** Install the two window listeners. Once, before the first render. */
export function installCrashReport() {
  window.addEventListener("error", (e) => {
    const err = e.error instanceof Error ? e.error : null;
    report(
      "error",
      err?.message || e.message,
      err?.stack,
      e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const err = r instanceof Error ? r : null;
    report("rejection", err?.message || String(r), err?.stack, undefined);
  });
}

function report(kind: "error" | "rejection", message: string, stack?: string, url?: string) {
  void invoke("record_webview_error", { kind, message, stack: stack ?? null, url: url ?? null }).catch(() => {});
}

/** The newest crash file the user has been told about. Per machine, since the
 *  files are. */
const SEEN_KEY = "tori:crash-seen";

/**
 * Say so once if Tori closed on its own since the last launch. One toast per
 * crash file, with Reveal and Report: the file is the evidence and the form is
 * where it goes, and neither happens without a click.
 *
 * Only a panic counts here. A webview error is written for the record but
 * the app survived it, so a toast on the next launch would be noise about
 * something the user already saw, or did not notice, last time.
 */
export async function announceCrash() {
  const logs = await invoke<CrashLogs>("crash_logs").catch(() => null);
  const newest = logs?.files.find((f) => f.kind === "panic");
  if (!newest) return;
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(SEEN_KEY);
  } catch {
    /* storage off: tell them every launch rather than never */
  }
  if (seen === newest.path) return;
  try {
    localStorage.setItem(SEEN_KEY, newest.path);
  } catch {
    /* same */
  }
  emitWith<ToastEvent>(TOAST, {
    message: `Tori closed on its own ${ago(newest.at)} ago. A crash file was written.`,
    kind: "info",
    action: [
      { label: "Reveal", run: () => void invoke("reveal_in_finder", { path: newest.path }).catch(() => {}) },
      { label: "Report", run: () => void invoke("open_crash_issue").catch(() => {}) },
    ],
  });
}
