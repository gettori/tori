// Everything one pull request's review needs while it is being read, held
// outside any view that shows it.
//
// ## Why a store and not component state
//
// A pull request is about to be read across several tabs at once: a diff tab
// per file, an overview tab, and the panel beside them. The Editor renders a
// synthetic tab's view only while that tab is active (`searchResultsStore.ts`
// explains the same constraint for Search), so a half-typed comment held in a
// view would be gone the moment the reader switched files to check something.
//
// It also decides who fetches. Every consumer calls `ensure(root, number)` on
// mount and reads from here; nothing fetches on its own. That is what stops
// four tabs of one pull request from being four `forge_pr_files` requests, and
// it is why re-reading is `refresh(root, number, part)`, which names the part
// so a submit does not re-download every patch to pick up one new thread.
//
// ## What is *not* here
//
// Gap expansion reads local git (`git_fetch_pr_head`, `git_blob_slice`), not
// the forge, so it is not one of the three parts and the view still issues it.
// The cache it fills lives here because it is per pull request and a tab switch
// must not throw away a stretch the reader already expanded.

import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { parseDiffHunks } from "./diffHunks";
import { newSideLines, oldSideLines } from "./reviewThreads";
import { unitStatusForPr } from "./forgeStatus";
import {
  forgeErrorMessage,
  type DraftComment,
  type MergeableState,
  type Paged,
  type PrFile,
  type ReviewThread,
} from "./forgeTypes";

/** A line comment's anchor, which is everything it carries except its words. */
export type DraftAnchor = Omit<DraftComment, "body">;

/// Whether a held comment still describes the diff in hand.
///
/// Three answers rather than two, because they call for different things.
/// `stale` is an anchor the current patch cannot express at all, so the comment
/// has nowhere to land. `moved` resolves to a line that now reads differently:
/// the server would accept it, and it would arrive as a remark about whatever
/// occupies that line today.
export type AnchorState = "ok" | "stale" | "moved";

export type PendingComment = DraftComment & {
  /** The diff row this was written against, as it read then. The only thing
   *  that can tell `moved` from `ok`: a line number alone still resolves. */
  rowText: string;
  anchor: AnchorState;
};

/** A composer with words in it that have not been added to the review. */
export type OpenComposer = {
  path: string;
  anchor: DraftAnchor;
  text: string;
};

/** Which of the three reads to take again. Named rather than "reload
 *  everything", so a submit costs one threads read and not every patch. */
export type RefreshPart = "files" | "threads" | "summary";

export type PrReviewEntry = {
  files: PrFile[];
  filesTruncated: boolean;
  filesLoading: boolean;
  filesError: string | null;
  /// The head commit the patches in hand describe.
  ///
  /// Taken from the poll store at the moment of the read rather than from the
  /// response, which carries no sha. Null while no tick has covered the unit,
  /// which reads as "cannot tell" and never as "up to date".
  headSha: string | null;
  threads: ReviewThread[];
  threadsTruncated: boolean;
  threadsError: string | null;
  mergeState: MergeableState | null;
  /** Gap keys the reader has expanded, and the lines fetched for them. */
  openGaps: string[];
  gapLines: Record<string, string[]>;
  /** Paths the reader has marked read. Local to this machine. */
  viewed: string[];
  composers: OpenComposer[];
  pending: PendingComment[];
  reviewBody: string;
};

/** Where a draft survives a relaunch. Exported so a test can stand in for a
 *  previous session by writing the key directly, the way `sideBySide` does. */
export const PR_REVIEW_DRAFTS_KEY = "tori.prReview.v1";
// A draft nobody has touched in this long belongs to a pull request that has
// been merged or abandoned. Same shape as `editorTabPersist`'s prune, shorter
// because a review is a sitting, not a workspace.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const blank = (): PrReviewEntry => ({
  files: [],
  filesTruncated: false,
  filesLoading: false,
  filesError: null,
  headSha: null,
  threads: [],
  threadsTruncated: false,
  threadsError: null,
  mergeState: null,
  openGaps: [],
  gapLines: {},
  viewed: [],
  composers: [],
  pending: [],
  reviewBody: "",
});

const EMPTY = blank();

const [entries, setEntries] = createStore<Record<string, PrReviewEntry>>({});
const [viewingMap, setViewingMap] = createSignal<Record<string, number | null>>({});

const key = (root: string, number: number) => `${root}\n${number}`;
const anchorKey = (a: DraftAnchor) => `${a.path}\n${a.side}\n${a.startLine ?? ""}\n${a.line}`;

/// Which read of each part is current, per pull request and per part.
///
/// Per part rather than one counter per pull request: a threads refresh must
/// not invalidate a files read that happens to be in flight beside it. Per pull
/// request rather than one counter for the store, because two of them can be
/// open at once and neither's answer is the other's to discard.
const seq = new Map<string, number>();
const claim = (k: string, part: RefreshPart) => {
  const n = (seq.get(`${k}\n${part}`) ?? 0) + 1;
  seq.set(`${k}\n${part}`, n);
  return n;
};
const holds = (k: string, part: RefreshPart, n: number) => seq.get(`${k}\n${part}`) === n;

/** Keys `ensure` has already loaded, so every consumer can call it on mount. */
const ensured = new Set<string>();

function slot(k: string) {
  if (!entries[k]) setEntries(k, blank());
}

// --- reading ----------------------------------------------------------------

/** Everything held for one pull request. A key nobody has opened reads blank
 *  rather than undefined, so a view mounting before its `ensure` lands has the
 *  same shape as one whose read failed. */
export function prEntry(root: string, number: number): PrReviewEntry {
  return entries[key(root, number)] ?? EMPTY;
}

/** Whether the head has moved since the patches in hand were read.
 *
 *  The guard on every write. `forge_submit_review` sends no `commit_id`, so the
 *  server re-resolves each anchor against the diff it has *now*: a comment
 *  written against a patch two commits old lands on whatever occupies that line
 *  today, silently. Null on either side means nobody can tell yet, which is not
 *  drift. */
export function headDrift(root: string, number: number): boolean {
  const mine = prEntry(root, number).headSha;
  const live = unitStatusForPr(root, number)?.pullRequest?.headSha ?? null;
  return mine !== null && live !== null && mine !== live;
}

/** Which pull request the panel is showing instead of the checked-out branch's,
 *  or null for the branch's own. Per root: picking one in a project says
 *  nothing about what another project should show. */
export function viewingPr(root: string): number | null {
  return viewingMap()[root] ?? null;
}

export function setViewingPr(root: string, number: number | null): void {
  setViewingMap((m) => ({ ...m, [root]: number }));
}

export function gapOpen(root: string, number: number, gapKey: string): boolean {
  return prEntry(root, number).openGaps.includes(gapKey);
}

export function gapLines(root: string, number: number, gapKey: string): string[] | undefined {
  return prEntry(root, number).gapLines[gapKey];
}

export function isViewed(root: string, number: number, path: string): boolean {
  return prEntry(root, number).viewed.includes(path);
}

/** What the reader has typed at this anchor, or "" for a composer with nothing
 *  in it. An empty composer is not state: there is nothing to come back to. */
export function composerText(root: string, number: number, anchor: DraftAnchor): string {
  const want = anchorKey(anchor);
  return prEntry(root, number).composers.find((c) => anchorKey(c.anchor) === want)?.text ?? "";
}

// --- loading ----------------------------------------------------------------

/** Load this pull request's three parts, once, however many consumers ask.
 *
 *  Every view calls this on mount rather than fetching: four tabs of one pull
 *  request are one read of each part, and a tab that mounts after the reads have
 *  landed shows them immediately. */
export function ensure(root: string, number: number): void {
  const k = key(root, number);
  if (ensured.has(k)) return;
  ensured.add(k);
  slot(k);
  restoreDraft(root, number);
  void loadFiles(root, number);
  void loadThreads(root, number);
  void loadSummary(root, number);
}

/** Take one part again, past what `ensure` already has. The caller names the
 *  part because it knows what it changed: a submit opens threads, an Update
 *  branch moves the verdict, and neither touches the patches. */
export function refresh(root: string, number: number, part: RefreshPart): Promise<void> {
  slot(key(root, number));
  if (part === "files") return loadFiles(root, number);
  if (part === "threads") return loadThreads(root, number);
  return loadSummary(root, number);
}

async function loadFiles(root: string, number: number): Promise<void> {
  const k = key(root, number);
  const mine = claim(k, "files");
  setEntries(k, { filesLoading: true, filesError: null });
  try {
    const page = await invoke<Paged<PrFile>>("forge_pr_files", { projectPath: root, number });
    if (!holds(k, "files", mine)) return;
    setEntries(k, {
      files: page.items,
      filesTruncated: page.truncated,
      // Replaced outright, never merged with what a restored draft was written
      // against: this field is what the patches in hand describe, and null for
      // "cannot tell" is the only other thing it may say.
      headSha: unitStatusForPr(root, number)?.pullRequest?.headSha ?? null,
    });
    recheckAnchors(k);
  } catch (e) {
    if (!holds(k, "files", mine)) return;
    // The patches already in hand survive. On the first read there are none and
    // this empties nothing; on a re-read, one transient failure would otherwise
    // take away the diff somebody is halfway through reading.
    setEntries(k, "filesError", forgeErrorMessage(e));
  } finally {
    if (holds(k, "files", mine)) setEntries(k, "filesLoading", false);
  }
}

/** Its own read and its own failure. A pull request whose conversations could
 *  not be fetched is still a pull request worth reading. */
async function loadThreads(root: string, number: number): Promise<void> {
  const k = key(root, number);
  const mine = claim(k, "threads");
  try {
    const page = await invoke<Paged<ReviewThread>>("forge_review_threads", {
      projectPath: root,
      number,
    });
    if (!holds(k, "threads", mine)) return;
    setEntries(k, { threads: page.items, threadsTruncated: page.truncated });
  } catch (e) {
    if (!holds(k, "threads", mine)) return;
    setEntries(k, "threadsError", forgeErrorMessage(e));
  }
}

/// The server's verdict, read for the opened pull request rather than taken
/// from the listing.
///
/// A listed `mergeableState` was computed before anyone opened the diff, and by
/// the time it has been read the base may have moved twice. The merge control is
/// the one place where a stale green light costs something.
///
/// A failure leaves it null, which renders as "checking" with the button inert:
/// not asking and being told no are different, and only one of them is a
/// verdict.
async function loadSummary(root: string, number: number): Promise<void> {
  const k = key(root, number);
  const mine = claim(k, "summary");
  try {
    const state = await invoke<MergeableState>("forge_mergeability", {
      projectPath: root,
      number,
    });
    if (holds(k, "summary", mine)) setEntries(k, "mergeState", state);
  } catch {
    // Deliberately silent, and deliberately not an error banner: the diff and
    // the conversations are worth reading without it.
  }
}

/** Put a reply, a resolve or a submitted review's own new thread into the list
 *  in hand. Here rather than in a view because the list is: two tabs showing
 *  one pull request must not disagree about which conversations are resolved. */
export function updateThreads(
  root: string,
  number: number,
  fn: (list: ReviewThread[]) => ReviewThread[],
): void {
  const k = key(root, number);
  slot(k);
  setEntries(k, "threads", (list) => fn([...list]));
}

/** What went wrong with the conversations, from a read or from a write. One
 *  line rather than two, because a reader who sees both wants to know what is
 *  currently broken, not which layer noticed. */
export function setThreadsError(root: string, number: number, message: string | null): void {
  const k = key(root, number);
  slot(k);
  setEntries(k, "threadsError", message);
}

// --- the draft --------------------------------------------------------------

/** Hold a line comment until the review goes out.
 *
 *  The caller hands over the anchor, the words and the row they were written
 *  against, and never the verdict on whether that anchor still fits: the files
 *  are here, so working it out here is what stops a call site from being able to
 *  get it wrong or skip it. */
export function addPending(
  root: string,
  number: number,
  comment: DraftComment & { rowText: string },
): void {
  const k = key(root, number);
  slot(k);
  const held: PendingComment = {
    ...comment,
    anchor: anchorStateFor(entries[k].files, comment, comment.rowText),
  };
  setEntries(k, "pending", (list) => [...list, held]);
  saveDraft(root, number);
}

export function removePending(root: string, number: number, at: number): void {
  const k = key(root, number);
  slot(k);
  setEntries(k, "pending", (list) => list.filter((_, i) => i !== at));
  saveDraft(root, number);
}

export function setReviewBody(root: string, number: number, body: string): void {
  const k = key(root, number);
  slot(k);
  setEntries(k, "reviewBody", body);
  saveDraft(root, number);
}

/** Give up the whole draft, which only a landed submit may do. A failed one
 *  hands the set back, or the reader loses every comment they wrote to one
 *  refusal. */
export function clearDraft(root: string, number: number): void {
  const k = key(root, number);
  slot(k);
  setEntries(k, { pending: [], reviewBody: "", composers: [] });
  saveDraft(root, number);
}

/** What goes on the wire: the anchor and the words, without the two fields that
 *  exist to decide whether it may be sent at all. */
export function toDrafts(list: readonly PendingComment[]): DraftComment[] {
  return list.map(({ path, line, side, startLine, startSide, body }) => ({
    path,
    line,
    side,
    startLine,
    startSide,
    body,
  }));
}

export function setComposerText(
  root: string,
  number: number,
  anchor: DraftAnchor,
  text: string,
): void {
  const k = key(root, number);
  slot(k);
  const want = anchorKey(anchor);
  setEntries(k, "composers", (list) => {
    const rest = list.filter((c) => anchorKey(c.anchor) !== want);
    return text ? [...rest, { path: anchor.path, anchor, text }] : rest;
  });
  saveDraft(root, number);
}

export function closeComposer(root: string, number: number, anchor: DraftAnchor): void {
  setComposerText(root, number, anchor, "");
}

export function setViewedFile(root: string, number: number, path: string, on: boolean): void {
  const k = key(root, number);
  slot(k);
  setEntries(k, "viewed", (list) =>
    on ? (list.includes(path) ? list : [...list, path]) : list.filter((p) => p !== path),
  );
  saveDraft(root, number);
}

// --- gap expansion ----------------------------------------------------------

export function noteGapLines(root: string, number: number, gapKey: string, lines: string[]): void {
  const k = key(root, number);
  slot(k);
  setEntries(k, "gapLines", gapKey, lines);
}

export function setGapOpen(root: string, number: number, gapKey: string, on: boolean): void {
  const k = key(root, number);
  slot(k);
  setEntries(k, "openGaps", (list) =>
    on ? (list.includes(gapKey) ? list : [...list, gapKey]) : list.filter((g) => g !== gapKey),
  );
}

// --- anchors ----------------------------------------------------------------

/** Whether this anchor still describes the patches in hand, and how it fails.
 *
 *  Pure, and over the patch rather than the file on disk: a review anchors to
 *  the diff the forge computed, and the head is usually not checked out here
 *  anyway. */
export function anchorStateFor(
  files: readonly PrFile[],
  at: DraftAnchor,
  rowText: string,
): AnchorState {
  const file = files.find((f) => f.path === at.path);
  if (!file?.patch) return "stale";
  for (const hunk of parseDiffHunks(file.patch)) {
    const lines = at.side === "LEFT" ? oldSideLines(hunk) : newSideLines(hunk);
    const at_ = lines.indexOf(at.line);
    if (at_ < 0) continue;
    return hunk.lines[at_] === rowText ? "ok" : "moved";
  }
  return "stale";
}

function recheckAnchors(k: string): void {
  const files = entries[k]?.files ?? [];
  setEntries(k, "pending", (list) =>
    list.map((c) => {
      const anchor = anchorStateFor(files, c, c.rowText);
      return anchor === c.anchor ? c : { ...c, anchor };
    }),
  );
}

// --- persistence ------------------------------------------------------------

type StoredDraft = {
  /** The head the rows below were read at, so a draft restored against a moved
   *  head reads as drift rather than as current. */
  headSha: string | null;
  pending: PendingComment[];
  reviewBody: string;
  composers: OpenComposer[];
  viewed: string[];
  savedAt: number;
};

type DraftStore = Record<string, StoredDraft>;

/** Tolerant of anything already in storage: a shape that does not parse is
 *  treated as nothing stored rather than throwing on the first read. */
export function parseDrafts(raw: string | null, now: number, maxAgeMs = MAX_AGE_MS): DraftStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: DraftStore = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<StoredDraft> | null;
      if (!e || typeof e.savedAt !== "number") continue;
      if (now - e.savedAt > maxAgeMs) continue;
      out[k] = {
        headSha: typeof e.headSha === "string" ? e.headSha : null,
        pending: Array.isArray(e.pending) ? e.pending : [],
        reviewBody: typeof e.reviewBody === "string" ? e.reviewBody : "",
        composers: Array.isArray(e.composers) ? e.composers : [],
        viewed: Array.isArray(e.viewed) ? e.viewed : [],
        savedAt: e.savedAt,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/// The parsed key, held in memory once this process has read it.
///
/// Every keystroke in a composer saves, and re-parsing and re-serialising the
/// whole key per character is work on the thread the typing is on. Nothing
/// outside this process writes the key, so what was written last is what is
/// there.
let cached: DraftStore | null = null;

function readDrafts(now = Date.now()): DraftStore {
  if (cached) return cached;
  try {
    cached = parseDrafts(localStorage.getItem(PR_REVIEW_DRAFTS_KEY), now);
  } catch {
    cached = {};
  }
  return cached;
}

function writeDrafts(store: DraftStore): void {
  cached = store;
  try {
    localStorage.setItem(PR_REVIEW_DRAFTS_KEY, JSON.stringify(store));
  } catch {
    /* quota or private mode: the draft degrades to not surviving a relaunch */
  }
}

function saveDraft(root: string, number: number, now = Date.now()): void {
  const k = key(root, number);
  const e = entries[k] ?? EMPTY;
  const store = readDrafts(now);
  const empty =
    e.pending.length === 0 &&
    e.composers.length === 0 &&
    e.viewed.length === 0 &&
    e.reviewBody === "";
  if (empty) delete store[k];
  else {
    store[k] = {
      headSha: e.headSha,
      pending: [...e.pending],
      reviewBody: e.reviewBody,
      composers: [...e.composers],
      viewed: [...e.viewed],
      savedAt: now,
    };
  }
  writeDrafts(store);
}

/** Put a previous session's draft back, before the patches it was written
 *  against have been read. The anchor check re-runs once they land, so a draft
 *  that no longer fits shows as stale rather than as ready to send. */
function restoreDraft(root: string, number: number): void {
  const k = key(root, number);
  const stored = readDrafts()[k];
  if (!stored) return;
  setEntries(k, {
    headSha: stored.headSha,
    pending: stored.pending,
    reviewBody: stored.reviewBody,
    composers: stored.composers,
    viewed: stored.viewed,
  });
}

/** Test seam: this outlives any one component, and the key outlives the
 *  process. */
export function resetPrReviewStoreForTests(): void {
  setEntries(reconcile({}));
  setViewingMap({});
  ensured.clear();
  seq.clear();
  cached = null;
  try {
    localStorage.removeItem(PR_REVIEW_DRAFTS_KEY);
  } catch {
    /* nothing to clear */
  }
}
