// The TypeScript mirror of `src-tauri/src/forge/model.rs`.
//
// Field names match that model's JSON 1:1, which is checked rather than
// trusted: the Rust round-trip test (`emit_wire_samples_for_the_typescript_mirror`
// in forge/model.rs) serializes one sample per type into
// `dev/fixtures/forge/model.json`, and forgeTypes.test.ts parses that exact
// file. A renamed field on either side fails there instead of surviving as two
// internally consistent halves that disagree on the wire.
//
// Nothing here is GitHub-shaped on purpose. These are the neutral types the
// forge trait speaks, so a second provider changes the mapping in Rust and
// nothing at all up here.

export type RepoRef = {
  owner: string;
  repo: string;
};

/// `merged` is its own state, not `closed` plus a flag. The sidebar chip and
/// the merge guard both branch on it, and a boolean beside a state is exactly
/// the pair that can end up disagreeing.
export type PrState = "open" | "closed" | "merged";

/// GitHub's own mergeability verdict, carried through rather than recomputed.
///
/// `unknown` covers both "still being computed" and any state string the server
/// adds later. It means *ask again*, never a green light: Sway cannot see branch
/// protection or required checks it does not model, so a locally-derived verdict
/// would render an enabled button the server then refuses.
export type MergeableState =
  | "clean"
  | "blocked"
  | "behind"
  | "dirty"
  | "unstable"
  | "draft"
  | "unknown";

export type PullRequest = {
  number: number;
  title: string;
  body: string | null;
  state: PrState;
  isDraft: boolean;
  /// Compared against `Viewer.login` to decide whether approve and
  /// request-changes are offerable at all: GitHub rejects both from the PR
  /// author with a 422, and on a single-owner repo that is every PR.
  author: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  url: string;
  mergeableState: MergeableState;
};

/// `none` is "no checks configured", which is not `pending` ("checks exist and
/// have not finished"). Collapsing them makes a repo with no CI look
/// permanently in flight.
export type CheckState = "success" | "failure" | "pending" | "none";

export type CheckRollup = {
  state: CheckState;
  total: number;
  failing: number;
};

/// `none` means nobody has reviewed. On a single-owner repo that is the
/// permanent state, which is why the merge guard reads `mergeableState` instead
/// of this.
export type ReviewDecision = "approved" | "changesRequested" | "reviewRequired" | "none";

/// One branch-unit's whole forge story, as the sidebar chip needs it.
export type UnitStatus = {
  headRef: string;
  /// `null` is "no PR for this branch", which the UI must render differently
  /// from "this remote is not a forge Sway can talk to".
  pullRequest: PullRequest | null;
  checks: CheckRollup;
  reviewDecision: ReviewDecision;
};

export type ReviewComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

/// `id` is a `PullRequestReviewThread` node id, which is why threads are read
/// over GraphQL: REST has no thread object, only comments, and the resolve
/// mutation will not take a comment's id.
export type ReviewThread = {
  id: string;
  path: string;
  /// Absent once the thread goes outdated. A null line is what routes a thread
  /// into the outdated group rather than onto a line that has moved.
  line: number | null;
  diffHunk: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ReviewComment[];
};

export type Viewer = {
  login: string;
  avatarUrl: string | null;
};

/// A collection that may not be complete.
///
/// `truncated` exists so a partial list cannot render as a full one: a 40-file
/// PR showing 30 files looks like a working feature, which is the failure
/// nobody notices.
export type Paged<T> = {
  items: T[];
  truncated: boolean;
};

export type Capabilities = {
  pullRequests: boolean;
  checks: boolean;
  reviewThreads: boolean;
  resolveThreads: boolean;
  merge: boolean;
};

/// `suspect` is a 401 that has *not* destroyed the token.
///
/// Clearing the keychain on one bad response costs a full device-flow re-auth
/// to recover from what may have been a proxy or a forge incident, so a 401
/// pauses polling and prompts instead. Only the user's sign-out or re-sign-in
/// actually clears the stored credential.
export type AuthState =
  | { kind: "signedOut" }
  | { kind: "signedIn"; login: string }
  | { kind: "suspect"; login: string | null };

/// A `ForgeError` as the Tauri layer serializes it: a stable `kind` to branch
/// on plus a sentence to show. The kind is deliberately not the message, so
/// rewording a sentence cannot change behaviour.
export type ForgeErrorDto = { kind: string; message: string };

export function isForgeError(e: unknown): e is ForgeErrorDto {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as ForgeErrorDto).kind === "string" &&
    typeof (e as ForgeErrorDto).message === "string"
  );
}

/// The sentence to show for anything a forge command rejected with.
///
/// A rejected Tauri command hands back the serialized DTO, an object, and the
/// panels' `String(e)` renders that as "[object Object]". Every forge failure is
/// user-facing, so the one that matters most (a PR that already exists, a base
/// that does not) must not arrive as the least informative string in the app.
export function forgeErrorMessage(e: unknown): string {
  if (isForgeError(e)) return e.message;
  return String(e);
}

/// The field names each type carries on the wire, as data.
///
/// Declared separately from the types above because a type alone cannot catch a
/// rename: a JSON import infers `string`, not a literal union, so assigning the
/// fixture to these types needs a cast, and a cast checks nothing. (The same
/// thing was verified not to work for `chatTypes`: renaming Rust's `turnId` left
/// `tsc --noEmit` completely clean.) The test compares these lists against the
/// keys Rust actually emitted.
export const FORGE_KEYS = {
  repoRef: ["owner", "repo"],
  pullRequest: [
    "author",
    "baseRef",
    "body",
    "headRef",
    "headSha",
    "isDraft",
    "mergeableState",
    "number",
    "state",
    "title",
    "url",
  ],
  checkRollup: ["failing", "state", "total"],
  unitStatus: ["checks", "headRef", "pullRequest", "reviewDecision"],
  reviewThread: [
    "comments",
    "diffHunk",
    "id",
    "isOutdated",
    "isResolved",
    "line",
    "path",
  ],
  reviewComment: ["author", "body", "createdAt", "id"],
  viewer: ["avatarUrl", "login"],
  capabilities: ["checks", "merge", "pullRequests", "resolveThreads", "reviewThreads"],
  pagedTruncated: ["items", "truncated"],
} as const satisfies Record<string, readonly string[]>;

/// Every value each closed enum can take, so a variant added in Rust and not
/// here (or vice versa) fails rather than degrading to a silent default.
export const PR_STATES: readonly PrState[] = ["open", "closed", "merged"];
export const CHECK_STATES: readonly CheckState[] = ["success", "failure", "pending", "none"];
export const MERGEABLE_STATES: readonly MergeableState[] = [
  "clean",
  "blocked",
  "behind",
  "dirty",
  "unstable",
  "draft",
  "unknown",
];
export const REVIEW_DECISIONS: readonly ReviewDecision[] = [
  "approved",
  "changesRequested",
  "reviewRequired",
  "none",
];
export const AUTH_STATE_KINDS: readonly AuthState["kind"][] = ["signedOut", "signedIn", "suspect"];

/// Whether the forge API may be called right now.
///
/// The mirror of `AuthCore::may_call` in `src-tauri/src/forge/auth.rs`, and it
/// exists for the same reason: **three independent things can say no** (no
/// token, a rejected token, the kill switch), and every call site remembering
/// its own subset is how a disabled integration ends up still making requests.
///
/// When this is false the caller does not fail, it falls back to the
/// compare-URL path, which is why signing out never costs the user the ability
/// to open a PR, only the ability to do it in-app.
export function mayUseForge(auth: AuthState, enabled: boolean): boolean {
  return enabled && auth.kind === "signedIn";
}

/// Whether a unit's forge state is something the user needs to look at.
///
/// The one piece of judgment in this file, kept here because the sidebar chip
/// and the needs-you attribution must agree on it: two call sites each deciding
/// "is this bad?" is how a red chip and a silent tray end up disagreeing.
export function needsAttention(status: UnitStatus): boolean {
  return status.checks.state === "failure" || status.reviewDecision === "changesRequested";
}
