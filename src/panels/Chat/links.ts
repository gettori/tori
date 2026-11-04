// Where a link in assistant prose goes.
//
// Pure and separate from the renderer, because "which of four things is this
// href" needs no DOM to answer, and the renderer's own job is only to make sure
// the webview never follows one.

import { isUnderPath } from "../../utils/pathScope";
import type { NavTarget } from "../../utils/events";

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "navigate"; target: NavTarget }
  | { kind: "file"; path: string; line?: number }
  | { kind: "outside"; path: string; line?: number }
  | { kind: "ignore" };

const EXTERNAL = /^(?:https?|mailto|tel):/i;
const TORI = "tori://open?";

// A place in Tori, as the autopilot writes one: `tori://open?folder=..&session=..`.
function navigateTo(raw: string): LinkTarget {
  const query = new URLSearchParams(raw.slice(TORI.length));
  const folder = query.get("folder") || undefined;
  const session = query.get("session") || undefined;
  return folder?.startsWith("/") || (!folder && session)
    ? { kind: "navigate", target: { folder, session } }
    : { kind: "ignore" };
}

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
  if (raw.startsWith(TORI)) return navigateTo(raw);
  if (!cwd) return { kind: "ignore" };

  const path = decode(raw.startsWith("file://") ? raw.slice("file://".length) : raw);
  const at = /^(.+?):(\d+)$/.exec(path);
  const body = at ? at[1] : path;
  if (!body) return { kind: "ignore" };

  const abs = resolve(body.startsWith("/") ? "" : cwd, body);
  const line = at ? Number(at[2]) : undefined;
  return isUnderPath(abs, cwd) ? { kind: "file", path: abs, line } : { kind: "outside", path: abs, line };
}

/** One path segment: anything but whitespace, quotes and brackets. Not `\w`,
 *  which drops a folder named with a multiplication sign or an accent, while
 *  prose and code expressions still fall out before anything asks the disk. */
const SEGMENT = "[^\\s/`'\"<>()\\[\\]{}]+";
const PATH_LIKE = new RegExp(`^(?:~?\\.{0,2}/)?${SEGMENT}(?:/${SEGMENT})*(?::\\d+)?$`);
const EXTENSION = /\.[a-z0-9]{1,8}(?::\d+)?$/;

/**
 * The file a span of reply text names, or null when it does not look like one.
 * `outside` when it resolves past the workspace, which the caller may still be
 * able to place in another worktree.
 *
 * Shape only: `bucket.count` passes it as readily as `src/limiter.ts`, so the
 * caller still has to ask the disk before drawing a link.
 */
export function pathTarget(text: string, cwd: string): { path: string; line?: number; outside: boolean } | null {
  const raw = text.trim().replace(/^@/, "");
  if (!PATH_LIKE.test(raw) || raw.startsWith("~")) return null;
  if (!raw.includes("/") && !EXTENSION.test(raw)) return null;
  const target = linkTarget(raw, cwd);
  if (target.kind !== "file" && target.kind !== "outside") return null;
  return { path: target.path, line: target.line, outside: target.kind === "outside" };
}

/** Path-shaped words in running prose: a slash in them somewhere, so a plain
 *  word never costs a disk check. Trailing sentence punctuation is not part of
 *  the path. */
const PROSE_PATH = new RegExp(`@?(?:~?\\.{0,2}/)?${SEGMENT}(?:/${SEGMENT})+|@?/${SEGMENT}`, "g");

export function pathWords(text: string): { start: number; raw: string }[] {
  const out: { start: number; raw: string }[] = [];
  for (const m of text.matchAll(PROSE_PATH)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    if (raw.length > 1) out.push({ start: m.index, raw });
  }
  return out;
}
