// The forge status the sidebar reads, and the schedule that keeps it current.
//
// The thin half of the pair: `forgePoll.ts` owns every decision with its inputs
// explicit, this owns the timer, the invoke, and the signals. Same shape as
// `sessionActivity.ts` (fed inputs at the top, owned state below), and for the
// same reason: whoever knows a fact tells the store, and everyone else reads it
// rather than fetching their own copy.
//
// Nothing here is per-unit. One tick asks Rust about a whole project at once,
// because the rate budget scales with unit count and a per-unit request is what
// spends 5,000 an hour on an idle window.
//
// Credentials are per account, and a project reaches its account through its
// origin: the resolved `RepoAccount` is what every pause and budget is read
// through, so one account's 401 or rate limit leaves the others polling.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  isForgeError,
  type AuthState,
  type Capabilities,
  type ForgeAccount,
  type ForgeHost,
  type ForgeProvider,
  type RepoAccount,
  type StatusReport,
  type UnitStatus,
} from "./forgeTypes";
import { canonicalHost, type KnownHosts } from "./prUrl";
import {
  askOrder,
  backoffAfter,
  budgetBackoff,
  mayPoll,
  MIN_GAP_MS,
  POLL_INTERVAL_MS,
  projectPause,
  type PauseReason,
  type PollClock,
  type Trigger,
} from "./forgePoll";

/// A branch-unit as the poller needs it: what to ask about, and whether anyone
/// is looking at it. `branch` is null for a `plain-dir` unit, which has none.
export type WatchedUnit = { branch: string | null; visible: boolean };
export type WatchedProject = { path: string; units: readonly WatchedUnit[] };

// --- fed inputs -------------------------------------------------------------

const [accounts, setAccounts] = createSignal<readonly ForgeAccount[]>([]);
const [viewers, setViewers] = createSignal<Record<string, string>>({});
const [enabled, setEnabled] = createSignal(true);
const [projects, setProjects] = createSignal<readonly WatchedProject[]>([]);

const signedOut: AuthState = { kind: "signedOut" };
const accountAuth = (id: string): AuthState => accounts().find((a) => a.id === id)?.auth ?? signedOut;
const ids = (list: readonly ForgeAccount[]) => list.map((a) => a.id).sort().join("\n");

/** Every account and its credential state, from whoever last asked Rust. */
export function noteForgeAccounts(list: readonly ForgeAccount[]) {
  const was = accounts();
  setAccounts(list);
  // The viewer identity is a fact about *this* credential, and the review gate
  // reads it to decide whether approve and request-changes are offerable at
  // all. Carrying it across a sign-out, or across a 401, is how that gate ends
  // up answering for an account that is no longer the one signed in.
  //
  // Rust keeps the login through a suspicion on purpose, so the re-auth prompt
  // can name the account it wants back. That is a *label*; this is an
  // authorisation fact, and only one of the two survives a 401.
  setViewers((m) => {
    const kept: Record<string, string> = {};
    for (const a of list) if (a.auth.kind === "signedIn" && m[a.id]) kept[a.id] = m[a.id];
    return kept;
  });
  const login = (s: AuthState | undefined) => (s?.kind === "signedIn" ? s.login : null);
  let becameUsable = false;
  for (const a of list) {
    if (a.auth.kind !== "signedIn") continue;
    const before = was.find((b) => b.id === a.id)?.auth;
    if (login(before) !== login(a.auth)) void refreshForgeViewer(a.id);
    if (before?.kind !== "signedIn") becameUsable = true;
  }

  // An account added or removed can change which account any repo resolves
  // to, so every resolution is asked again.
  const changed = ids(was) !== ids(list);
  if (changed) resetForgeResolutions();
  // Becoming usable is itself a trigger, because every tick before it was
  // refused by `mayPoll` and none of them will be retried on their own.
  else if (becameUsable) void pollNow("focus");
}

/** Every repo asks Rust again which account it acts as, starting now. */
export function resetForgeResolutions() {
  setRepos({});
  setResolvedAt({});
  void pollNow("focus");
}

/// Ask Rust who an account's token belongs to and fold it in.
///
/// Usually free: Rust answers from the login it learned at sign-in and only
/// reaches the network for a credential restored without one.
export async function refreshForgeViewer(accountId: string) {
  const v = await invoke<string>("forge_viewer", { accountId }).catch(() => null);
  // Only when still signed in. A sign-out landing while this was in flight
  // would otherwise restore the identity it had just cleared.
  if (v && accountAuth(accountId).kind === "signedIn") setViewers((m) => ({ ...m, [accountId]: v }));
}

/** The login this checkout's account belongs to, or null while unknown. */
export function forgeViewer(path: string | null): string | null {
  const repo = forgeRepo(path);
  return repo?.kind === "account" ? (viewers()[repo.accountId] ?? null) : null;
}

/// Ask Rust for every account's credential state and fold it in.
///
/// Rust is the only place that knows: the tokens are in the keychain and the
/// suspect flag is set by whichever call last got a 401, which may be one no
/// surface here made. A failure is swallowed on purpose, since the alternative
/// to a stale answer is an invented one.
export async function refreshForgeAccounts() {
  const hosts = await invoke<ForgeHost[]>("forge_accounts").catch(() => null);
  if (Array.isArray(hosts)) noteForgeAccounts(hosts.flatMap((h) => h.accounts));
}

/** Every host with an account, with the provider and web URL it was added as. */
export function forgeHosts(): KnownHosts {
  const hosts = new Map<string, { provider: ForgeProvider; baseUrl: string }>();
  for (const a of accounts()) {
    try {
      hosts.set(canonicalHost(new URL(a.baseUrl).hostname), { provider: a.provider, baseUrl: a.baseUrl });
    } catch {
      // Rust normalizes every base URL it writes, so only a hand-edited file
      // lands here, and that account serves nothing.
    }
  }
  return hosts;
}

/** The `forge.enabled` kill switch, from the settings store. */
export function noteForgeEnabled(on: boolean) {
  setEnabled(on);
}

/** The projects worth polling and which of their units are on screen. Rebuilt
 *  whenever the sidebar's config or expansion changes. */
export function noteWatchedProjects(list: readonly WatchedProject[]) {
  setProjects(list);
}

// --- owned state ------------------------------------------------------------

const [repos, setRepos] = createSignal<Record<string, RepoAccount>>({});
const [resolvedAt, setResolvedAt] = createSignal<Record<string, number>>({});
const [statuses, setStatuses] = createSignal<Record<string, UnitStatus>>({});
const [uncovered, setUncovered] = createSignal<Record<string, number>>({});
/** Epoch ms before which nothing on an account may poll, by account id. A rate
 *  limit belongs to the token, so it stops that account's projects and no
 *  other's. */
const [accountBlocked, setAccountBlocked] = createSignal<Record<string, number>>({});
/** Per-project blocks, for the failures that belong to one repo (no origin, a
 *  remote this forge does not serve). */
const [projectBlocked, setProjectBlocked] = createSignal<Record<string, number>>({});
const [lastPollAt, setLastPollAt] = createSignal<Record<string, number>>({});

const key = (path: string, branch: string) => `${path}\n${branch}`;

/// Which account a checkout acts as, asked of Rust and kept per path.
///
/// Any root works, a worktree's or its project's: the origin is what resolves,
/// and it is shared. No request leaves the machine, only a local git read.
export async function resolveForgeRepo(path: string): Promise<RepoAccount | null> {
  const repo = await invoke<RepoAccount>("forge_repo_account", { projectPath: path }).catch(() => null);
  if (repo) setRepos((m) => ({ ...m, [path]: repo }));
  return repo;
}

/** What a checkout last resolved to, or null before it has been asked. */
export function forgeRepo(path: string | null): RepoAccount | null {
  return path ? (repos()[path] ?? null) : null;
}

/** What this checkout's provider can do, or null before it has resolved. */
export function forgeCapabilities(path: string | null): Capabilities | null {
  const repo = forgeRepo(path);
  return repo?.kind === "account" ? repo.capabilities : null;
}

/// Pick the account a repo acts as, then re-resolve everything sharing it.
///
/// Rejects with Rust's error for the caller to show: a pick that did not stick
/// must not look like one that did.
export async function pickForgeAccount(path: string, accountId: string) {
  await invoke("forge_pick_account", { projectPath: path, accountId });
  await Promise.all([...new Set([path, ...Object.keys(repos())])].map(resolveForgeRepo));
  await pollNow("focus");
}

/** One unit's forge story, or null when no tick has covered it yet. */
export function unitStatus(path: string, branch: string | null): UnitStatus | null {
  if (branch === null || branch === "") return null;
  return statuses()[key(path, branch)] ?? null;
}

/** Units of this project the last tick did not cover. Surfaced rather than
 *  swallowed: a partial answer rendered as a complete one leaves units with no
 *  chip and nothing on screen saying why. */
export function uncoveredUnits(path: string): number {
  return uncovered()[path] ?? 0;
}

/** Why polling is stopped for this checkout, or null when it is running or
 *  has not resolved yet (Rust is then the one to say). */
export function forgePause(path: string | null): PauseReason | null {
  if (!enabled()) return "disabled";
  if (accounts().length === 0) return "signedOut";
  const repo = forgeRepo(path);
  return repo ? projectPause(repo, accountAuth, true) : null;
}

function clockFor(path: string, repo: RepoAccount): PollClock {
  const account = repo.kind === "account" ? (accountBlocked()[repo.accountId] ?? null) : null;
  const project = projectBlocked()[path] ?? null;
  const blockedUntil =
    account === null ? project : project === null ? account : Math.max(account, project);
  return { lastPollAt: lastPollAt()[path] ?? null, blockedUntil };
}

function applyReport(path: string, repo: RepoAccount, report: StatusReport, now: number) {
  setStatuses((m) => {
    const next = { ...m };
    for (const s of report.statuses) next[key(path, s.headRef)] = s;
    return next;
  });
  setUncovered((m) => ({ ...m, [path]: report.uncovered }));
  // A project that answered is a project whose remote is fine again.
  setProjectBlocked((m) => {
    if (!(path in m)) return m;
    const next = { ...m };
    delete next[path];
    return next;
  });
  // The pre-emptive half of the rate story: slow down while there is still
  // budget left, so the request that gets refused is never the user's.
  const budget = budgetBackoff(report.rate, now);
  if (budget && repo.kind === "account") {
    setAccountBlocked((m) => ({ ...m, [repo.accountId]: budget.untilMs }));
  }
}

async function noteFailure(path: string, repo: RepoAccount, err: unknown, now: number) {
  const backoff = backoffAfter(err, now);
  if (backoff?.scope === "account" && repo.kind === "account") {
    setAccountBlocked((m) => ({ ...m, [repo.accountId]: backoff.untilMs }));
  }
  if (backoff?.scope === "project") setProjectBlocked((m) => ({ ...m, [path]: backoff.untilMs }));
  if (!isForgeError(err)) return;
  // Rust has already decided the credential cannot be used: a 401 moved it to
  // suspect, or `may_call` refused before the request was built. Re-reading the
  // state is what turns that into a paused scheduler and a prompt, rather than a
  // tick that fails the same way every two minutes forever. Both kinds matter,
  // because the decision can also be made by a *different* command (a PR create
  // that got the 401), leaving this store's copy of the auth state stale.
  if (err.kind === "credentialSuspect" || err.kind === "notAuthenticated") {
    await refreshForgeAccounts();
  }
  // Rust resolved this checkout differently from the copy here: an account or a
  // pick went away, or the origin changed.
  if (["notAuthenticated", "pickAccount", "noRemote", "unsupportedRemote"].includes(err.kind)) {
    await resolveForgeRepo(path);
  }
}

/// A resolved account changes only through an account or pick change, which
/// re-resolves on its own; anything else is re-asked at most once per gap.
async function repoFor(path: string, trigger: Trigger, now: number): Promise<RepoAccount | null> {
  const cached = repos()[path];
  const at = resolvedAt()[path];
  const fresh = at !== undefined && now - at < MIN_GAP_MS && trigger !== "manual";
  if (cached && (cached.kind === "account" || fresh)) return cached;
  setResolvedAt((m) => ({ ...m, [path]: now }));
  return resolveForgeRepo(path);
}

async function pollProject(project: WatchedProject, trigger: Trigger, now: number) {
  const repo = await repoFor(project.path, trigger, now);
  if (!repo) return;
  const pause = projectPause(repo, accountAuth, enabled());
  if (!mayPoll(clockFor(project.path, repo), trigger, now, pause)) return;
  const branches = askOrder(project.units);
  if (branches.length === 0) return;
  // Stamped before the await, so two triggers landing together do not both get
  // past the gap check. Rust coalesces the duplicate anyway; this stops it from
  // reaching Rust at all.
  setLastPollAt((m) => ({ ...m, [project.path]: now }));
  try {
    const report = await invoke<StatusReport>("forge_unit_statuses", {
      projectPath: project.path,
      branches,
      // Only an explicit refresh bypasses Rust's freshness window. A focus or an
      // interval tick is happy with an answer from the last few seconds.
      refresh: trigger === "manual",
    });
    applyReport(project.path, repo, report, now);
  } catch (e) {
    await noteFailure(project.path, repo, e, now);
  }
}

/// One tick over every watched project.
///
/// `now` is a parameter so a test can drive the schedule without a fake clock.
export async function pollNow(trigger: Trigger, now: number = Date.now()) {
  // With no account nothing can be polled, and resolving every project to
  // learn that would cost a git read each.
  if (accounts().length === 0 || !enabled()) return;
  await Promise.all(projects().map((p) => pollProject(p, trigger, now)));
}

/// What every "the window came back" trigger does, wherever it comes from.
///
/// One function rather than a line at each call site, because the two triggers
/// that exist (the DOM focus event here, and the Tauri window's own focus
/// change in the sidebar) race: whichever runs first stamps `lastPollAt` and the
/// other is refused by the gap. If only one of them re-read the credential, a
/// sign-out made outside Settings would reach the chips or not depending on
/// which of the two won.
export async function pollOnFocus(now: number = Date.now()) {
  await refreshForgeAccounts();
  await pollNow("focus", now);
}

/// Starts the background schedule: an interval, plus a tick whenever the window
/// comes back to the front.
///
/// Focus matters more than the interval does. Coming back to Tori after a build
/// finished is exactly when the chips are stale, and waiting out the rest of a
/// two-minute interval to notice is the difference between a live surface and a
/// stale one. The gap in `forgePoll` is what stops that from becoming a request
/// per alt-tab.
export function startForgePolling(): () => void {
  // The credentials, read once at startup. A local read costing no request, and
  // the store's own copy starts empty, so without it every tick before the
  // first focus is refused. It lands asynchronously, which is fine: becoming
  // signed-in is itself a trigger (see `noteForgeAccounts`).
  //
  // No opening tick here. Nothing is watched yet at mount, so it would poll an
  // empty list; the first real tick comes from whoever calls
  // `noteWatchedProjects`, which is the moment there is something to ask about.
  void refreshForgeAccounts();
  const onFocus = () => void pollOnFocus();
  window.addEventListener("focus", onFocus);
  const timer = window.setInterval(() => void pollNow("interval"), POLL_INTERVAL_MS);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.clearInterval(timer);
  };
}

/// Drops every signal back to its starting value.
///
/// Named for what it is, like `resetSessionActivityForTests`: the store is
/// process-wide, so one test's rate-limit block would otherwise silence the
/// next, and nothing in the app should ever call this.
export function resetForgeStatusForTests() {
  setAccounts([]);
  setViewers({});
  setEnabled(true);
  setProjects([]);
  setRepos({});
  setResolvedAt({});
  setStatuses({});
  setUncovered({});
  setAccountBlocked({});
  setProjectBlocked({});
  setLastPollAt({});
}
