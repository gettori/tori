// Opening a pull request, owned outside whichever surface draws the button.
//
// Two of them ask for it: the Changes panel's "Open PR", and the Pull requests
// panel's states that have no pull request to show. What must not exist twice
// is the ordering, because every one of those steps is a way to get it wrong.
// A create without a push opens a pull request against a head the remote has
// never seen; a compare URL built before the push points at a branch that is
// not there; a form reachable without an account is a submit that cannot work,
// which is what `prPath` already decides and this only obeys.
//
// The caller supplies what only it knows (which repo is on screen, its origin,
// its base branch) and, where it has a session to ask, how to hand the agent a
// draft request. Everything else is read from the same module-level stores both
// panels already read, so the two cannot hold different opinions about a repo.

import { createSignal, type Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, PR_OPENED, TOAST, type PrOpened, type ToastEvent } from "./events";
import { gitStateFor, push, refreshMeta } from "./gitActions";
import { composeDraftRequest, prPath, type PrPath } from "./createPr";
import { comparePrUrl } from "./prUrl";
import { forgeHosts, forgeRepo } from "./forgeStatus";
import { BLOCKED_REASON, requestSend } from "./safeSend";
import { sendBlockedReason, sendTargetFor, type SendCandidate } from "./sendTarget";
import { forgeErrorMessage, type AuthState, type PullRequest } from "./forgeTypes";
import { settings } from "../panels/Settings/settingsStore";

/// How this surface asks an agent for a title and body, where it has a session.
///
/// The selection rather than a send, so the capability gate is asked once here
/// and not worded again per panel: `sendTarget` exists because three of them had
/// grown their own copy of the same two checks.
export type PrDraftAsk = {
  selected: Accessor<SendCandidate | null>;
  /** The paths the request names, so the session can find what changed. May go
   *  and read them: what a branch changed is not something either panel is
   *  already holding. */
  paths: () => string[] | Promise<string[]>;
};

export type PrCreateFlow = ReturnType<typeof createPrFlow>;

export function createPrFlow(deps: {
  root: Accessor<string | null>;
  origin: Accessor<string | null>;
  /** `git_default_base_branch`. The form's own base starts here and then stops
   *  following it, so a cancelled edit cannot retarget the compare page. */
  baseBranch: Accessor<string | null>;
  ask?: PrDraftAsk;
  /** The pull request the backend answered, for a caller that shows it. */
  onOpened?: (pr: PullRequest) => void;
}) {
  const [formOpen, setFormOpen] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [base, setBase] = createSignal("");
  const [drafting, setDrafting] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const branch = () => gitStateFor(deps.root()).branch;
  const auth = (): AuthState => {
    const repo = forgeRepo(deps.root());
    return repo?.kind === "account" ? repo.auth : { kind: "signedOut" };
  };
  const path = (): PrPath =>
    prPath(deps.origin(), forgeHosts(), auth(), settings.forge.enabled);

  function toastError(message: string) {
    emitWith<ToastEvent>(TOAST, { message, kind: "error" });
  }

  function openForm() {
    setTitle("");
    setBody("");
    setBase(deps.baseBranch() ?? "");
    setFormOpen(true);
  }

  // The decision lives in `prPath` so the button and the submit cannot disagree
  // about it.
  async function openPr() {
    if (busy()) return;
    if (path() === "form") return openForm();
    await openCompare();
  }

  // The unauthenticated path: push first if the branch is unpushed or ahead,
  // then open the provider's compare/new-MR/new-PR page for branch -> base.
  async function openCompare() {
    const root = deps.root();
    const branchName = branch();
    const org = deps.origin();
    const to = deps.baseBranch();
    if (!root || !branchName || !org || !to) return;
    const url = comparePrUrl(org, to, branchName, forgeHosts());
    if (!url) {
      toastError("This origin isn't a recognized GitHub/GitLab/Bitbucket host.");
      return;
    }
    setBusy(true);
    const ab = gitStateFor(root).aheadBehind;
    const needsPush = !ab || !ab.has_upstream || ab.ahead > 0;
    if (needsPush && !(await push(root, branchName))) {
      setBusy(false);
      return;
    }
    setBusy(false);
    window.open(url, "_blank");
  }

  /// Push the branch and nothing else, for a surface that offers that on its own.
  ///
  /// Answers whether it landed, since what follows a push differs per caller and
  /// a failed one has already said so in a toast.
  async function pushBranch(): Promise<boolean> {
    const root = deps.root();
    const branchName = branch();
    if (!root || !branchName || busy()) return false;
    setBusy(true);
    const ok = await push(root, branchName);
    setBusy(false);
    return ok;
  }

  /// Insert-only: the agent proposes at its own prompt, unsubmitted, and the
  /// user copies what they want into the form.
  async function draftWithAgent() {
    const branchName = branch();
    // The form's base, not the repo default: a title for "wave-3 into main" is
    // a different sentence from one for "wave-3 into release".
    const to = base();
    if (!deps.ask || !branchName || !to || drafting()) return;
    const gate = sendTargetFor(deps.ask.selected());
    if (!("target" in gate)) return;
    setDrafting(true);
    const paths = await deps.ask.paths();
    const result = await requestSend({
      ...gate.target,
      text: composeDraftRequest(branchName, to, paths),
    });
    setDrafting(false);
    // A blocked session is refused outright rather than queued: the user has to
    // answer that permission prompt first, and saying so is the difference
    // between a gate and a button that silently did nothing.
    if (result.kind === "blocked") toastError(BLOCKED_REASON);
    else if (result.kind === "timeout") toastError("Couldn't reach the session, try again.");
  }

  /// Why the draft button is dead. A surface with no session to ask reads the
  /// shared gate's own sentence rather than inventing a second one.
  const draftBlockedReason = () => sendBlockedReason(deps.ask?.selected() ?? null);

  // Always through the push-then-create command rather than checking
  // ahead/behind first: an up-to-date push is a no-op, while a stale
  // ahead/behind reading would open a PR against a head the remote has never
  // seen.
  async function submit(opts: { draft: boolean }) {
    const root = deps.root();
    const branchName = branch();
    const to = base().trim();
    if (!root || !branchName || !to || busy()) return;
    setBusy(true);
    try {
      const pr = await invoke<PullRequest>("forge_push_and_create_pr", {
        projectPath: root,
        remote: "origin",
        newPr: {
          title: title().trim(),
          body: body().trim(),
          head: branchName,
          base: to,
          draft: opts.draft,
        },
      });
      setFormOpen(false);
      emitWith<ToastEvent>(TOAST, { message: `Opened #${pr.number}`, kind: "info" });
      // The listings hold their own reads, so the write-through that makes the
      // sidebar chip flip does not reach them. Without this the pull request
      // the user just opened is absent until they hit Refresh.
      emitWith<PrOpened>(PR_OPENED, { projectPath: root });
      deps.onOpened?.(pr);
      await refreshMeta(root);
    } catch (e) {
      // The form stays open with the typed title and body intact: most of these
      // failures are fixable in place (a base that does not exist, a PR that is
      // already open), and losing the description to retype it is its own insult.
      // `forgeErrorMessage` because a rejected forge command hands back an
      // object, which `String(e)` would render as "[object Object]".
      toastError(forgeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return {
    formOpen,
    /** The branch a pull request would propose, which is the one checked out. */
    head: branch,
    title,
    setTitle,
    body,
    setBody,
    base,
    setBase,
    drafting,
    busy,
    path,
    draftBlockedReason,
    openPr,
    openCompare,
    openForm,
    pushBranch,
    draftWithAgent,
    submit,
    closeForm: () => setFormOpen(false),
  };
}
