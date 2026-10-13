import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";

/** `path` made absolute against `cwd`, or null when it lands outside `cwd` or
 *  cannot be placed (a `~` path, which only the backend can expand). */
export function workspacePath(path: string, cwd: string): string | null {
  if (path.startsWith("~") || path.startsWith("$")) return null;
  const joined = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const resolved = `/${parts.join("/")}`;
  return isUnderPath(resolved, cwd) ? resolved : null;
}

/** Open a file a tool touched in the editor. */
export function openWorkspacePath(path: string, cwd: string, line?: number) {
  // A path outside the workspace is a real case, not a bug: a tool can read a
  // system header or a file in another project. Saying so beats opening an
  // editor tab on something the user did not expect.
  if (!isUnderPath(path, cwd)) {
    emitWith<ToastEvent>(TOAST, { message: `${path} is outside this workspace.`, kind: "info" });
    return;
  }
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path, line });
}
