// Which whole-file actions the server answering for the active file will do.
//
// A source action is not asked for by putting the caret somewhere: "organize
// the imports" is about the file, so it reaches the user as a command by name
// rather than as a menu at a position. That means the palette has to know
// whether the command means anything *before* anyone runs it, and the only
// thing that knows is the server's advertised `codeActionKinds`.
//
// Eager and CodeMirror-free on purpose, for the same reason `utils/diagnostics`
// is: the omnibox reads this to build its list, and a runtime `@codemirror/*`
// import on that path would drag the editor graph into the startup chunk. The
// editor side publishes into it; nothing here imports the editor.

import { createSignal } from "solid-js";
import { SOURCE_KINDS } from "./events";

// Null means "nobody has said", which is the state before a file is open or
// before its server has answered `initialize`. Distinct from `[]`, which is a
// server that answered and offers nothing.
const [kinds, setKinds] = createSignal<readonly string[] | null>(null);

/** What the active file's server advertises, or null when nothing has said. */
export function sourceActionKinds(): readonly string[] | null {
  return kinds();
}

/** Publish the active file's advertised kinds. Called by the editor on a tab
 *  swap and whenever a client comes or goes, since both change the answer. */
export function publishSourceActionKinds(next: readonly string[] | null): void {
  const now = kinds();
  // Same answer, same array contents: publishing again would rebuild the
  // palette's list for nothing, on a path that runs on every tab swap.
  if (now === next) return;
  if (now && next && now.length === next.length && now.every((k, i) => k === next[i])) return;
  setKinds(next ? [...next] : null);
}

/**
 * Whether a source action of `kind` is worth offering.
 *
 * A server advertising **no** `codeActionKinds` at all is treated as offering
 * them, deliberately: the field is optional in the spec, and a server that
 * omits it is saying "I have not told you", not "I have none". Refusing there
 * would hide organize-imports against a conformant server that simply does not
 * enumerate, which is the same silence `codeActionLiteralSupport` exists to
 * avoid.
 */
export function offersSourceAction(kind: string): boolean {
  const list = kinds();
  if (list === null) return false;
  if (list.length === 0) return true;
  // Prefix, not equality: the spec's kinds are hierarchical, so a server
  // advertising `source` answers for every `source.*` beneath it.
  return list.some((k) => kind === k || kind.startsWith(`${k}.`) || k.startsWith(`${kind}.`));
}

/** Whether any whole-file action is on offer. What the palette gates on: a
 *  server with none should not list three commands that cannot run. */
export function offersAnySourceAction(): boolean {
  return kinds() !== null && Object.values(SOURCE_KINDS).some(offersSourceAction);
}
