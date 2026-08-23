// Where a link in assistant prose goes.
//
// Pure and separate from the renderer, because "which of four things is this
// href" needs no DOM to answer, and the renderer's own job is only to make sure
// the webview never follows one.

import { isUnderPath } from "../../utils/pathScope";

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; line?: number }
  | { kind: "outside"; path: string }
  | { kind: "ignore" };

const EXTERNAL = /^(?:https?|mailto|tel):/i;

/** Percent-encoding is `marked`'s doing, not the model's: a path with a space
 *  arrives as `%20` and would open a file that does not exist. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** POSIX only, which is every platform this ships on. `..` resolves rather than
 *  being refused, because a model writing `../src/foo.ts` means it. */
function resolve(base: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${base}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * Classify one `href` from assistant prose against the session's workspace.
 *
 * A model writes links three ways - a real URL, a path relative to where it is
 * working, an absolute path - and the transcript has to tell them apart before
 * anything opens. Anything it cannot place is `ignore`, which still gets its
 * default prevented: refusing to act is safe, navigating is not.
 */
export function linkTarget(href: string, cwd: string): LinkTarget {
  const raw = href.trim();
  // A fragment has nothing to scroll to in a transcript, and an empty href
  // reloads the page.
  if (!raw || raw.startsWith("#")) return { kind: "ignore" };
  if (EXTERNAL.test(raw)) return { kind: "external", url: raw };
  if (!cwd) return { kind: "ignore" };

  const path = decode(raw.startsWith("file://") ? raw.slice("file://".length) : raw);
  const at = /^(.+?):(\d+)$/.exec(path);
  const body = at ? at[1] : path;
  if (!body) return { kind: "ignore" };

  const abs = resolve(body.startsWith("/") ? "" : cwd, body);
  const line = at ? Number(at[2]) : undefined;
  return isUnderPath(abs, cwd) ? { kind: "file", path: abs, line } : { kind: "outside", path: abs };
}
