// Asking a language server what it could do about the code under the caret.
//
// `@codemirror/lsp-client` declares no `codeAction` capability at all, so a
// conformant server advertises no `codeActionProvider` and there is nothing to
// ask - the same shape of silence the outline had before `symbolClientCapabilities`
// existed. Everything here is raw protocol on top of `lspClient`'s `LspTarget`.
//
// Deliberately free of `@codemirror/view`: what an action *is* and how one is
// run are decisions worth testing without a mounted editor. The gutter and the
// menu live beside this, not in it.

import { ChangeSet, type Text } from "@codemirror/state";
import { serverById } from "../../utils/lspServers";
import { diffChanges } from "./docDiff";
import { lspTargetsFor, type LspTarget } from "./lspClient";
import { diagnosticsIn, type LspRange } from "./lspDiagnosticContext";
import { offsetIn } from "./lspDiagnostics";
import { pathToUri, uriToPath } from "./toriWorkspace";
import { editsByUri, type LspTextEdit, type WorkspaceEdit } from "./workspaceEdit";

/** The action kinds Tori asks for, and the order the menu groups them in.
 *
 *  A server may answer with kinds outside this list (`refactor.move`,
 *  `source.removeUnused`); the valueSet is what the client *understands*, not a
 *  filter, and the spec says a client must tolerate unknown kinds by treating
 *  them as their nearest prefix. Grouping does exactly that, so a kind nobody
 *  here has heard of still lands under the right heading. */
export const CODE_ACTION_KINDS = [
  "quickfix",
  "refactor",
  "refactor.extract",
  "refactor.inline",
  "refactor.rewrite",
  "source",
  "source.organizeImports",
  "source.fixAll",
] as const;

/**
 * What this module lets the client promise about code actions.
 *
 * `codeActionLiteralSupport` is the load-bearing one: without it a server is
 * entitled to answer with bare `Command` objects, which carry no `edit` and no
 * `kind`, so there would be nothing to group and nothing to apply without a
 * round trip per action.
 *
 * `dataSupport` and `resolveSupport` are one promise in two halves: `data` is
 * the opaque token a server round-trips through `codeAction/resolve`, and
 * declaring `resolveSupport` for `edit` is what licenses it to leave the edit
 * out of the first reply. tsserver's refactors cost a compile each, so the
 * lazy shape is the difference between a menu that opens and one that hangs.
 *
 * `isPreferredSupport` says the menu can mark the one action the server would
 * pick, which is what makes a fix-it worth offering before it is read.
 */
export const codeActionClientCapabilities = {
  clientCapabilities: {
    textDocument: {
      codeAction: {
        codeActionLiteralSupport: {
          codeActionKind: { valueSet: [...CODE_ACTION_KINDS] },
        },
        isPreferredSupport: true,
        dataSupport: true,
        // `edit` only. Declaring `command` too would let a server strip the
        // command from the first reply, and a command-only action with neither
        // is one the menu cannot describe, let alone run.
        resolveSupport: { properties: ["edit"] },
      },
    },
  },
};

// ------------------------------------------------------------ what comes back

/** A server command, as an action carries one. */
export type LspCommand = { title?: string; command: string; arguments?: unknown[] };

/**
 * One thing the server offers to do here.
 *
 * `edit` and `command` are both optional and both may be present: the spec says
 * an action carrying each applies the edit first and then runs the command, and
 * tsserver's "add missing imports" is exactly that shape. `data` is opaque and
 * exists only to be handed back through `codeAction/resolve`.
 */
export type CodeAction = {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
  command?: LspCommand;
  data?: unknown;
  /** The server that offered it, which is the one to resolve and run it. */
  serverId?: string;
  /** The object the server actually sent, kept so `codeAction/resolve` can be
   *  handed its own item back verbatim. The spec's round trip is "return the
   *  action you were given, filled in", and a server is entitled to read fields
   *  off it that mean nothing here (`diagnostics`, its own extensions), so
   *  sending a rebuilt copy is how a resolve quietly comes back empty. */
  raw?: unknown;
};

/**
 * Read the reply, which may hold either shape.
 *
 * Even with literal support declared, the spec still permits a bare `Command`,
 * and a server predating the literal (or one answering an older client on the
 * same code path) will send them. A `Command` is told from a `CodeAction` by
 * `command` being a string rather than an object, and becomes an action whose
 * only step is to run it.
 *
 * A `disabled` action is dropped: Tori declares no `disabledSupport`, so a
 * conformant server never sends one, and offering a row that refuses when
 * picked is worse than a shorter menu.
 */
export function normalizeCodeActions(res: unknown): CodeAction[] {
  if (!Array.isArray(res)) return [];
  const out: CodeAction[] = [];
  for (const raw of res) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.disabled) continue;
    if (typeof item.command === "string") {
      const title = typeof item.title === "string" ? item.title : item.command;
      out.push({
        title,
        command: {
          title,
          command: item.command,
          arguments: Array.isArray(item.arguments) ? item.arguments : undefined,
        },
        raw,
      });
      continue;
    }
    if (typeof item.title !== "string" || !item.title) continue;
    const command = item.command as Record<string, unknown> | undefined;
    out.push({
      title: item.title,
      kind: typeof item.kind === "string" ? item.kind : undefined,
      isPreferred: item.isPreferred === true,
      edit: (item.edit as WorkspaceEdit | undefined) ?? undefined,
      command:
        command && typeof command.command === "string"
          ? {
              title: typeof command.title === "string" ? command.title : undefined,
              command: command.command,
              arguments: Array.isArray(command.arguments) ? command.arguments : undefined,
            }
          : undefined,
      data: item.data,
      raw,
    });
  }
  return out;
}

// -------------------------------------------------------------- asking for it

/**
 * What the servers on `path` offer for `range`, or null when there is nothing
 * to ask.
 *
 * Null covers the three states that are the same to a caller: no server claims
 * this file, the servers claim it but advertise no `codeActionProvider`, or
 * every request failed. All three mean "no actions here", and every surface
 * hides itself rather than showing an empty menu that reads as "the server
 * looked and found nothing".
 *
 * Every server whose config allows code actions is asked, the primary's answer
 * first, and each action is tagged with the server that offered it.
 *
 * `await ready` before `supports`, because `supports` is false until
 * `initialize` is answered and refusing then would make the first ⌘⌥A after
 * opening a project depend on how fast the server started. `sync()` before the
 * request, because the reply is a set of positions and the library's own sync
 * is debounced by 500 ms - asking sooner would be asking about a document the
 * server has not been sent.
 */
export async function requestCodeActions(
  path: string,
  range: LspRange,
  only?: readonly string[],
): Promise<CodeAction[] | null> {
  const answers = await Promise.all(
    lspTargetsFor(path, "code_action").map((target) => {
      const answer = askTarget(target, path, range, only);
      return serverById(target.serverId)?.role === "secondary" ? briefly(answer) : answer;
    }),
  );
  const answered = answers.filter((a) => a !== null);
  return answered.length ? answered.flat() : null;
}

// A server beside the file's own is waited on only this long, so a slow linter
// cannot hold the menu open for its whole request timeout.
const SECONDARY_WAIT_MS = 2000;

function briefly<T>(answer: Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), SECONDARY_WAIT_MS)));
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

async function askTarget(
  target: LspTarget,
  path: string,
  range: LspRange,
  only?: readonly string[],
): Promise<CodeAction[] | null> {
  await target.ready;
  if (!target.supports("codeActionProvider")) return null;
  target.sync();
  const uri = pathToUri(path);
  try {
    const res = await target.request<unknown>("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context: {
        // Named when the caller wants one specific thing. Not an optimisation:
        // tsserver computes a source action only when it is asked for by kind,
        // so an unfiltered request over the whole file comes back without the
        // organize-imports the caller is there for.
        ...(only ? { only: [...only] } : {}),
        diagnostics: diagnosticsIn(uri, target.serverId, range),
        // 1 is Invoked: a person asked. The other value is Automatic, which
        // licenses a server to answer more cheaply and skip the expensive
        // refactors, and every request Tori makes is the result of a keystroke
        // or a caret move the user made.
        triggerKind: 1,
      },
    });
    return normalizeCodeActions(res).map((a) => ({ ...a, serverId: target.serverId }));
  } catch (e) {
    console.error("codeAction failed", path, e);
    return null;
  }
}

/** The live server `serverId` on `path`, which is where an action it offered
 *  is resolved and run, or null once it is gone. */
export function codeActionTarget(path: string, serverId: string | undefined): LspTarget | null {
  return lspTargetsFor(path, "code_action").find((t) => t.serverId === serverId) ?? null;
}

/**
 * The one whole-file action of `kind` the server offers, or null.
 *
 * Asked over the whole document because that is what a source action is about:
 * "organize the imports" is a claim about the file, not about wherever the
 * caret happens to be. Servers differ on whether they read the range at all,
 * and the ones that do expect this.
 *
 * The first match wins where a server answers with several. That is not
 * arbitrary either: a server ordering its own answers puts the one it means
 * first, and a command named "Organize imports" has no way to ask the user
 * which organize-imports they meant.
 */
export async function requestSourceAction(path: string, kind: string, wholeFile: LspRange): Promise<CodeAction | null> {
  const actions = await requestCodeActions(path, wholeFile, [kind]);
  if (!actions?.length) return null;
  // A server may answer a filtered request with kinds it thinks are close
  // enough. Only what was actually asked for is run: an "add missing imports"
  // arriving in answer to "organize imports" would be a different edit under
  // the command's name.
  return actions.find((a) => a.kind === kind || a.kind?.startsWith(`${kind}.`)) ?? null;
}

/**
 * Every server's fix-all for `path`, as one list of edits against `doc`, or null
 * when none offers one.
 *
 * All of them answer about the same text, so their edits are merged rather than
 * applied in turn. A server whose edits touch text an earlier one already
 * changed is left out whole: two fixes to one range would apply both.
 */
export async function requestFixAllEdits(path: string, doc: Text, wholeFile: LspRange): Promise<LspTextEdit[] | null> {
  const kind = "source.fixAll";
  const lists = await Promise.all(
    lspTargetsFor(path, "code_action").map(async (target) => {
      const actions = await askTarget(target, path, wholeFile, [kind]);
      const action = actions?.find((a) => a.kind === kind || a.kind?.startsWith(`${kind}.`));
      const full = action && (action.edit ? action : await resolveCodeAction(path, action));
      return editsByUri(full?.edit).find((t) => uriToPath(t.uri) === path)?.edits ?? [];
    }),
  );
  let merged = ChangeSet.empty(doc.length);
  for (const edits of lists) {
    const set = changeSetOf(doc, edits);
    if (set && !touches(merged, set)) merged = merged.compose(set.map(merged));
  }
  if (merged.empty) return null;
  const at = (offset: number) => {
    const line = doc.lineAt(offset);
    return { line: line.number - 1, character: offset - line.from };
  };
  const out: LspTextEdit[] = [];
  merged.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
    out.push({ range: { start: at(fromA), end: at(toA) }, newText: inserted.toString() }),
  );
  return out;
}

function changeSetOf(doc: Text, edits: LspTextEdit[]): ChangeSet | null {
  const changes = [];
  for (const e of edits) {
    const from = offsetIn(doc, e.range.start);
    const to = offsetIn(doc, e.range.end);
    if (from === null || to === null || to < from) return null;
    changes.push({ from, to, insert: e.newText });
  }
  // Down to the text that actually changed: Biome answers with the whole
  // document, which would otherwise overlap every other server's fix.
  return changes.length ? diffChanges(doc, ChangeSet.of(changes, doc.length).apply(doc)) : null;
}

function touches(done: ChangeSet, next: ChangeSet): boolean {
  let clash = false;
  next.iterChangedRanges((from, to) => (clash ||= done.touchesRange(from, to) !== false));
  return clash;
}

// ----------------------------------------------------------- ordering a menu

/** Which family a kind belongs to, by the spec's own prefix rule: a kind is
 *  hierarchical and dotted, and an unknown one belongs to its nearest known
 *  ancestor. So `refactor.move`, which nothing here has heard of, still lands
 *  with the refactors. */
function family(kind: string | undefined): number {
  if (!kind) return 3;
  if (kind === "quickfix" || kind.startsWith("quickfix.")) return 0;
  if (kind === "refactor" || kind.startsWith("refactor.")) return 1;
  if (kind === "source" || kind.startsWith("source.")) return 2;
  return 3;
}

/**
 * Split the actions into the groups a menu draws a separator between, keeping
 * each group in the order the server sent it.
 *
 * The server's order inside a group is deliberately preserved: it is not
 * arbitrary, it is the server's own ranking, and re-sorting it would put a
 * generic fix above the one tsserver thinks is most likely. The one exception
 * is `isPreferred`, which is the server explicitly naming its best answer and
 * therefore belongs at the top of its own group.
 *
 * Empty groups are dropped, so a file offering only quick fixes gets no
 * leading separator and no empty heading.
 */
export function groupedCodeActions(actions: CodeAction[]): CodeAction[][] {
  const groups: CodeAction[][] = [[], [], [], []];
  for (const a of actions) groups[family(a.kind)].push(a);
  for (const g of groups) {
    const preferred = g.filter((a) => a.isPreferred);
    if (preferred.length && preferred.length < g.length) {
      g.splice(0, g.length, ...preferred, ...g.filter((a) => !a.isPreferred));
    }
  }
  return groups.filter((g) => g.length);
}

// ------------------------------------------------------------ running one

/**
 * Fill in an action the server left half-finished, or hand back what we have.
 *
 * A server is allowed to answer the list request with titles and `data` alone
 * and compute each edit only when one is picked, which is the whole point of
 * declaring `resolveSupport`: tsserver costs a compile per refactor, so a menu
 * that resolved every entry up front would be a menu that never opened.
 *
 * Every failure here returns the original action rather than throwing. An
 * unresolved action still has whatever it arrived with, and an action carrying
 * a command needs no edit at all - refusing at this point would turn a working
 * command-only action into an error message.
 */
export async function resolveCodeAction(path: string, action: CodeAction): Promise<CodeAction> {
  // Nothing to fill in, or nothing to fill it in from. `data` is the token the
  // server round-trips; without one there is no resolve to make.
  if (action.edit || action.data === undefined) return action;
  const target = codeActionTarget(path, action.serverId);
  if (!target) return action;
  await target.ready;
  const provider = target.capability("codeActionProvider");
  // `true` means "I do code actions", not "I resolve them". Only the object
  // form can carry `resolveProvider`, and asking a server that never claimed it
  // draws a MethodNotFound.
  if (!provider || provider === true || !(provider as { resolveProvider?: boolean }).resolveProvider) {
    return action;
  }
  try {
    const res = await target.request<unknown>("codeAction/resolve", action.raw ?? action);
    const [resolved] = normalizeCodeActions([res]);
    return resolved ? { ...resolved, serverId: action.serverId } : action;
  } catch (e) {
    console.error("codeAction/resolve failed", action.title, e);
    return action;
  }
}

/** What running an action needs from the app around it. Injected because both
 *  halves reach the filesystem, and neither decision is worth a mounted editor
 *  to test. */
export type RunCodeActionDeps = {
  /** Apply through the interactive applier. Returns a refusal to show, or null
   *  when it went through. */
  applyEdit: (edit: WorkspaceEdit, title: string) => Promise<string | null>;
  /** `workspace/executeCommand`. The server answers one by pushing a
   *  `workspace/applyEdit` straight back, which the Phase 1 router answers. */
  runCommand: (command: LspCommand) => Promise<void>;
};

export type RunOutcome = { kind: "done" } | { kind: "nothing" } | { kind: "refused"; reason: string };

/**
 * Do what an action offers to do.
 *
 * Edit first, then command, which is the order the spec gives and not an
 * arbitrary one: an action carrying both means "make these changes, then tell
 * me about it", and tsserver's add-all-missing-imports is exactly that shape.
 * A command that ran before its own edit would be reporting on a file that had
 * not been changed yet.
 *
 * A refused edit stops there. The command half is the server's follow-up to an
 * edit that happened, so running it anyway would tell the server a change
 * landed that Tori declined to make.
 */
export async function runCodeAction(path: string, action: CodeAction, deps: RunCodeActionDeps): Promise<RunOutcome> {
  const full = await resolveCodeAction(path, action);
  if (full.edit) {
    const refused = await deps.applyEdit(full.edit, full.title);
    if (refused) return { kind: "refused", reason: refused };
  }
  if (full.command) {
    try {
      await deps.runCommand(full.command);
    } catch (e) {
      return { kind: "refused", reason: `${full.title} did not run: ${String(e)}` };
    }
    return { kind: "done" };
  }
  // Neither half, even after resolving. A server that offers a title and then
  // has nothing to do is not something Tori can report as success.
  return full.edit ? { kind: "done" } : { kind: "nothing" };
}

// ------------------------------------------------- what is on offer right now

/** What the last answered request was about, and what it came back with.
 *  `actions` is null for "there was nothing to ask", which the gutter and the
 *  menu tell apart from an empty list. */
export type CodeActionsAt = { path: string; range: LspRange; actions: CodeAction[] | null };

let latest: CodeActionsAt | null = null;
let listeners: (() => void)[] = [];

/** Two ranges asking the same question.
 *
 *  By value, never by identity: two requests made about the same caret are the
 *  same request, and whichever of them the store happens to hold answers both.
 *  Comparing the objects would make a caller's own answer unrecognisable the
 *  moment anything else asked at the same time. */
export function sameRange(a: LspRange, b: LspRange): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

/** The offer the surfaces are currently drawing, or null before the first
 *  answer. Callers compare `range` against their own selection rather than
 *  assuming it is still theirs. */
export function currentCodeActions(): CodeActionsAt | null {
  return latest;
}

/** Be told when the offer changes. Returns an unsubscribe. */
export function onCodeActionsChange(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function publish(next: CodeActionsAt | null): void {
  latest = next;
  for (const l of [...listeners]) l();
}

/** Forget the offer. What a tab swap and a closed file call: an action is a
 *  promise about a range in a document, and neither survives the file leaving
 *  the screen. */
export function clearCodeActions(): void {
  if (latest) publish(null);
}

// One token per path with a request outstanding, exactly as
// `refreshDocumentSymbols` keeps one. Deleted by whichever request finishes
// latest, so this holds only what is genuinely in flight.
const pending = new Map<string, number>();

/**
 * Ask what is on offer at `range` in `path` and publish it, unless a newer ask
 * has been made since.
 *
 * The guard is not optional and it is not about tidiness. Three things re-ask
 * (a caret move, a keypress, and ⌘⌥A itself), a server answering a refactor
 * query can take a compile to do it, and an older reply landing last would put
 * the previous line's fixes behind the current caret - a menu that offers to
 * fix something the user is no longer looking at, and a lightbulb on the wrong
 * line.
 *
 * Publishing lives inside the guard rather than in the caller, because that is
 * what makes it unskippable: there is no way to ask without going through here.
 *
 * `stillCurrent` is the caller's own check that the caret has not moved on
 * while the server was answering. Separate from the token because a caret move
 * does not always re-ask (nothing asks for a file with no server), so nothing
 * would otherwise supersede a reply that is already about the wrong place.
 */
export async function refreshCodeActions(
  path: string,
  range: LspRange,
  stillCurrent: (path: string, range: LspRange) => boolean = () => true,
): Promise<boolean> {
  const token = (pending.get(path) ?? 0) + 1;
  pending.set(path, token);
  const actions = await requestCodeActions(path, range);
  if (pending.get(path) !== token) return false;
  pending.delete(path);
  if (!stillCurrent(path, range)) return false;
  publish({ path, range, actions });
  return true;
}
