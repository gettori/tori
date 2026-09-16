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

/// What the last answered call said about the rate budget.
///
/// Every field is nullable because a response that carried no rate headers must
/// read as "no news", never as a budget of zero: the latter would stop polling
/// on the first proxy that strips headers.
export type RateSnapshot = {
  remaining: number | null;
  limit: number | null;
  /// Epoch **seconds**, as the header sends it. Converted at the point of use so
  /// the field keeps the wire's units.
  resetAt: number | null;
};

/// One poll tick's answer.
///
/// `uncovered` is the count the UI must not swallow: a project past the per-tick
/// cap gets a partial answer, and a partial answer rendered as a complete one
/// leaves units with no chip and nothing saying why.
export type StatusReport = {
  statuses: UnitStatus[];
  uncovered: number;
  /// All-null when the tick was served from Rust's cache, which spends nothing
  /// and so learns nothing about the budget.
  rate: RateSnapshot;
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
  /// The first line of a multi-line comment, null on a single-line one. Sway
  /// itself sends ranges, so a reader that only knew `line` would narrow a
  /// range it had just written.
  startLine: number | null;
  diffHunk: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ReviewComment[];
};

/// `changed` is GitHub's own word for a file it could not classify further. It
/// is kept rather than folded into `modified` so a status the server invents
/// later does not arrive wearing a word it did not choose.
export type FileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

/// One file of a pull request's diff, with the forge's **own** patch.
///
/// The patch is carried through rather than recomputed, which is the whole
/// point of the type: a review thread anchors to the hunk GitHub calculated, and
/// a locally recomputed diff would differ in context size, rename detection and
/// whitespace handling. Each of those differences lands a comment on a wrong
/// line rather than failing outright.
export type PrFile = {
  path: string;
  /// Where a renamed or copied file came from; null for everything else.
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  /// Hunks only, with no `diff --git` preamble. Null in three situations the UI
  /// must not render alike (binary, mode-only, and a patch past the size the
  /// API will send), which the line counts beside it are what tell apart.
  patch: string | null;
};

/// Which side of the diff a line is counted on.
///
/// `LEFT` is the base file and `RIGHT` the head file: two numberings of the same
/// region, which stop agreeing the moment anything above the line changed. A
/// comment that names a line without its side is a comment on whichever line
/// the server guesses.
export type DiffSide = "LEFT" | "RIGHT";

/// A line comment held in a review that has not been submitted.
///
/// Anchored with `line`/`side` and never with `position`. `position` counts
/// lines from the top of a patch, so it means something different the moment the
/// pull request gets another commit; GitHub deprecated it for that, and the
/// line-and-side form is re-resolved by the server against the diff it has now.
export type DraftComment = {
  path: string;
  /// The last line of the range, in `side`'s numbering.
  line: number;
  side: DiffSide;
  /// The first line of a multi-line range; null for a single line.
  startLine: number | null;
  startSide: DiffSide | null;
  body: string;
};

/// The verdict a submitted review carries.
///
/// `approve` and `requestChanges` are rejected with a 422 on a pull request the
/// viewer authored, which on a single-owner repo is every pull request Sway
/// opens. Both are built and gated rather than omitted: the gate is about this
/// pull request, not about the app.
export type ReviewEvent = "approve" | "comment" | "requestChanges";

/// How to land a pull request. The picker offers all three and lets the server
/// refuse: a repo can forbid any of them, and that setting is not visible here.
export type MergeMethod = "merge" | "squash" | "rebase";

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
  /// One flag per verdict: GitLab has approve and comment but nothing that
  /// carries "changes requested".
  approve: boolean;
  requestChanges: boolean;
  commentReview: boolean;
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

export type ForgeProvider = "github" | "gitlab";

/// One account Sway holds on a forge host, with its credential state.
export type ForgeAccount = {
  id: string;
  provider: ForgeProvider;
  baseUrl: string;
  login: string | null;
  label: string;
  /// Epoch **seconds**, for tokens that expire.
  expiresAt: number | null;
  /// Epoch **seconds** when the host stopped accepting the token.
  rejectedAt: number | null;
  auth: AuthState;
};

export type ForgeHost = {
  host: string;
  accounts: ForgeAccount[];
  /// Git over https on this host uses the repo's account instead of whatever
  /// credential helper the user has configured.
  gitCredentials: boolean;
  /// The account a repo with no pick of its own acts as.
  defaultAccount: string | null;
};

/// Which account a checkout acts as. `noAccount` carries no host when the
/// checkout has no remote at all.
export type RepoAccount =
  | { kind: "account"; accountId: string; host: string; auth: AuthState; capabilities: Capabilities }
  | { kind: "pick"; host: string; candidates: ForgeAccount[] }
  | { kind: "noAccount"; host: string | null };

export type SignInRoutes = {
  host: string;
  baseUrl: string;
  deviceFlow: boolean;
  scopes: string[];
  tokenUrl: string;
  /// The OAuth application registered on this instance, GitLab only. Null where
  /// there is none, which is what leaves token paste as the only route.
  appId: string | null;
};

export function forgeAccountName(account: ForgeAccount): string {
  return account.label || account.login || account.baseUrl;
}

/// A `ForgeError` as the Tauri layer serializes it: a stable `kind` to branch
/// on plus a sentence to show. The kind is deliberately not the message, so
/// rewording a sentence cannot change behaviour.
///
/// The rate-limit fields are null on every other failure. They exist so the poll
/// scheduler backs off by the server's own number instead of parsing it back out
/// of the sentence, which would work right up until the sentence is reworded.
export type ForgeErrorDto = {
  kind: string;
  message: string;
  rateLimitKind: string | null;
  retryAfterSecs: number | null;
  /// Epoch **seconds** at which the primary budget refills. Read off the refusal
  /// itself, because a refusal is the one response whose rate snapshot never
  /// reaches a caller.
  resetAtSecs: number | null;
};

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
    "startLine",
  ],
  reviewComment: ["author", "body", "createdAt", "id"],
  prFile: ["additions", "deletions", "patch", "path", "previousPath", "status"],
  draftComment: ["body", "line", "path", "side", "startLine", "startSide"],
  viewer: ["avatarUrl", "login"],
  capabilities: [
    "approve",
    "checks",
    "commentReview",
    "merge",
    "pullRequests",
    "requestChanges",
    "resolveThreads",
    "reviewThreads",
  ],
  pagedTruncated: ["items", "truncated"],
  rateSnapshot: ["limit", "remaining", "resetAt"],
  statusReport: ["rate", "statuses", "uncovered"],
  forgeAccount: ["auth", "baseUrl", "expiresAt", "id", "label", "login", "provider", "rejectedAt"],
  signInRoutes: ["appId", "baseUrl", "deviceFlow", "host", "scopes", "tokenUrl"],
  // Not a domain type, but it crosses the same bridge and the poll scheduler
  // branches on it, so it is checked against Rust the same way.
  forgeError: ["kind", "message", "rateLimitKind", "resetAtSecs", "retryAfterSecs"],
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
export const DIFF_SIDES: readonly DiffSide[] = ["LEFT", "RIGHT"];
export const REVIEW_EVENTS: readonly ReviewEvent[] = ["approve", "comment", "requestChanges"];
export const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];
export const FILE_STATUSES: readonly FileStatus[] = [
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged",
];

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
