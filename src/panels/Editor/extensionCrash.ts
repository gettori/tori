// CodeMirror catches what an extension throws and logs it to a console nobody
// using the app sees. Said once per distinct failure, since an update listener
// that throws does it on every keystroke.
import { EditorView } from "@codemirror/view";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";

const told = new Set<string>();

export function crashedIn(e: unknown): string | null {
  // V8 leads with an "Error: message" line; WebKit does not.
  const frame = e instanceof Error ? e.stack?.split("\n").find((l) => /^\s*at |@/.test(l)) : undefined;
  return frame?.match(/^\s*at (?:new )?([\w$.]+) /)?.[1] ?? frame?.match(/^([\w$.]+)@/)?.[1] ?? null;
}

export const extensionCrashSink = EditorView.exceptionSink.of((e) => {
  console.error("CodeMirror extension crashed:", e);
  const where = crashedIn(e);
  const message = e instanceof Error ? e.message : String(e);
  const key = `${where}\u0000${message}`;
  if (told.has(key)) return;
  told.add(key);
  emitWith<ToastEvent>(TOAST, {
    message: `An editor extension stopped working${where ? ` in ${where}` : ""}: ${message}`,
    kind: "error",
  });
});
