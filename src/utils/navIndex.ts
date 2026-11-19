// The tree is fed by the sidebar, the only place that resolves the config.
// Other spaces' sessions come from one read-only listing and never enter the
// session store, which would put them on the needs-you pipeline and the probe.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NavTarget, OpenReview } from "./events";
import type { IssueRef, UnitIssue } from "./issues";
import { blockedOnUser, isWorking, type SessionHome, type SessionStatus } from "./sessionStatus";
import { liveSessionStatuses } from "./sessionActivity";
import { topics } from "./topicStore";
import { memberPrBranch, memberRoot, type Topic } from "./topics";
import { chats, NEW_CHAT_NAME, type Chat } from "./chats";
import { forgeViewer, requestedReviews, reviewRequests, unitStatus } from "./forgeStatus";
import { defaultBranchOf } from "./defaultBranch";
import { prLineTone, type PrChildState } from "./prChildState";
import { rememberedPr } from "./prMemory";
import { mentionId, mentionsOf } from "./sessionIssues";
import { originRepo } from "./prUrl";
import { issueId, ticketLabel, type IssueId } from "./navNumber";
import type { RankNumber } from "./navRank";
import { GLOBAL_KEY, spaceLabel } from "./globalSpace";

export type NavUnit = {
  folderPath: string;
  branch: string | null;
  label: string;
  kind: string;
  isCurrent?: boolean;
  issue?: UnitIssue;
};
export type NavProject = {
  name: string;
  path: string;
  branchUnits: NavUnit[];
  icon?: string;
  iconFile?: string;
  favicon?: string;
};
export type NavSpace = { name: string; projects: NavProject[]; icon?: string };

// Mirrors `Overview` in src-tauri/src/sessions.rs.
export type OverviewSession = {
  id: string;
  title: string;
  name: string | null;
  agent: string;
  profile_label: string | null;
  last_active: number;
  home: SessionHome;
};

export type PlaceKind = "space" | "project" | "unit" | "topic" | "member" | "review" | "chat" | "session";
export type PlaceDot = "needsYou" | "working";
export type PlacePr = {
  number: number;
  title: string;
  url: string;
  tone: PrChildState | "unlaned";
  remembered?: boolean;
};
export type PlaceTicket = { label: string; title: string; url: string; id: IssueId | null };
export type PlaceMention = { label: string; id: IssueId };

type PlaceBase = {
  kind: PlaceKind;
  id: string;
  title: string;
  trail: string;
  unitKind?: string;
  look?: { icon?: string; iconFile?: string; favicon?: string; seed: string };
  ticket?: PlaceTicket;
  pr?: PlacePr;
  repo?: string | null;
  mentions?: PlaceMention[];
  dot?: PlaceDot;
};

/** A review request is not a place yet: Enter opens or makes its worktree. */
export type Place = PlaceBase & ({ target: NavTarget } | { review: OpenReview });

type Status = { sessionId: string; status: SessionStatus; folderPath: string; home?: SessionHome | null };

export type PlaceInputs = {
  spaces: readonly NavSpace[];
  topics: readonly Topic[];
  chats: readonly Chat[];
  sessions: readonly OverviewSession[];
  statuses: readonly Status[];
  prOf: (projectPath: string, branch: string | null) => PlacePr | undefined;
  originOf: (projectPath: string) => string | null;
  reviews: (projectPath: string) => readonly IssueRef[];
  mentionsOf: (sessionId: string) => readonly IssueId[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
// A space, not a newline: Kobalte finds an option by an unescaped
// `[data-key="..."]` selector, and no branch name can hold a space.
const unitKey = (folder: string, branch: string | null | undefined) => `${folder} ${branch ?? ""}`;

function dotOf(status: SessionStatus): PlaceDot | undefined {
  if (blockedOnUser(status) || status === "prAttention") return "needsYou";
  return isWorking(status) ? "working" : undefined;
}

function worse(a: PlaceDot | undefined, b: PlaceDot | undefined): PlaceDot | undefined {
  return a === "needsYou" || b === "needsYou" ? "needsYou" : (a ?? b);
}

function ticketOf(issue: UnitIssue | undefined, origin: string | null): PlaceTicket | undefined {
  return issue && { label: ticketLabel(issue), title: issue.title, url: issue.url, id: issueId(issue, origin) };
}

/** `#N` in `origin`'s own repo, `name#N` anywhere else. */
export function mentionLabel(id: IssueId, origin: string | null): string {
  return id.repo && id.repo !== origin ? `${id.repo.split("/").pop()}#${id.number}` : `#${id.number}`;
}

function mentionsAt(ids: readonly IssueId[], origin: string | null): PlaceMention[] | undefined {
  const seen = new Set<string>();
  const out: PlaceMention[] = [];
  for (const id of ids) {
    const key = `${id.repo}#${id.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: mentionLabel(id, origin), id });
  }
  return out.length ? out : undefined;
}

/** The numbers a place answers to, for the ranker. */
export function placeNumbers(place: Place): RankNumber[] {
  const repo = place.repo ?? null;
  const out: RankNumber[] = [];
  const ticket = place.ticket;
  if (ticket?.id)
    out.push({ kind: "issue", slot: "ticket", id: ticket.id, digitsAt: ticket.label.lastIndexOf("#") + 1 });
  if (place.pr) out.push({ kind: "pr", slot: "pr", id: { repo, number: place.pr.number }, digitsAt: 1 });
  if (place.kind === "unit") {
    for (const m of place.title.matchAll(/(?<!\d)[1-9]\d*/g)) {
      out.push({ kind: "branch", slot: "title", id: { repo, number: Number(m[0]) }, digitsAt: m.index });
    }
  }
  place.mentions?.forEach((m, i) =>
    out.push({ kind: "mention", slot: `mention:${i}`, id: m.id, digitsAt: m.label.lastIndexOf("#") + 1 }),
  );
  return out;
}

/** Every place, in the order a tie between two equal matches falls back to. */
export function buildPlaces(input: PlaceInputs): Place[] {
  const byUnit = new Map<string, PlaceDot>();
  const byTopic = new Map<string, PlaceDot>();
  const byFolder = new Map<string, PlaceDot>();
  const bySession = new Map<string, PlaceDot>();
  for (const s of input.statuses) {
    const dot = dotOf(s.status);
    if (!dot) continue;
    bySession.set(s.sessionId, dot);
    byFolder.set(s.folderPath, worse(byFolder.get(s.folderPath), dot)!);
    if (s.home)
      byUnit.set(unitKey(s.home.folder, s.home.branch), worse(byUnit.get(unitKey(s.home.folder, s.home.branch)), dot)!);
    if (s.home?.topic) byTopic.set(s.home.topic, worse(byTopic.get(s.home.topic), dot)!);
  }

  const known = new Set(input.spaces.map((g) => g.name));
  const topicWorktrees = new Set(input.topics.flatMap((t) => t.members.map((m) => m.worktreePath).filter(Boolean)));
  const projectName = new Map<string, string>();
  const spaces: Place[] = [];
  const projects: Place[] = [];
  const units: Place[] = [];
  const reviews: Place[] = [];
  for (const g of input.spaces) {
    const space = spaceLabel(g.name);
    spaces.push({
      kind: "space",
      id: `space:${g.name}`,
      title: space,
      trail: plural(g.projects.length, "project"),
      look: { icon: g.icon, seed: g.name },
      target: { space, select: true },
    });
    for (const p of g.projects) {
      projectName.set(p.path, p.name);
      const repo = input.originOf(p.path);
      let projectDot: PlaceDot | undefined;
      for (const u of p.branchUnits) {
        if (topicWorktrees.has(u.folderPath)) continue;
        const dot = byUnit.get(unitKey(u.folderPath, u.branch));
        projectDot = worse(projectDot, dot);
        units.push({
          kind: "unit",
          id: `unit:${unitKey(u.folderPath, u.branch)}`,
          title: u.branch ?? u.label,
          trail: `${space} / ${p.name}`,
          unitKind: u.kind,
          ticket: ticketOf(u.issue, repo),
          pr: u.branch ? input.prOf(p.path, u.branch) : undefined,
          repo,
          dot,
          target: { folder: u.folderPath, ...(u.branch && { branch: u.branch }), select: true },
        });
      }
      for (const r of input.reviews(p.path)) {
        const number = Number(r.key);
        if (!Number.isInteger(number)) continue;
        reviews.push({
          kind: "review",
          id: `review:${p.path}:${number}`,
          title: r.title,
          trail: r.author ? `${r.author} in ${p.name}` : p.name,
          pr: { number, title: r.title, url: r.url, tone: "reviewRequested" },
          repo,
          review: { projectPath: p.path, number },
        });
      }
      projects.push({
        kind: "project",
        id: `project:${p.path}`,
        title: p.name,
        trail: space,
        look: { icon: p.icon, iconFile: p.iconFile, favicon: p.favicon, seed: p.path },
        dot: projectDot,
        target: { project: p.path, select: true },
      });
    }
  }

  const topicName = new Map<string, string>();
  const topicRows: Place[] = [];
  const members: Place[] = [];
  for (const t of input.topics) {
    topicName.set(t.id, t.name);
    const memberNames = t.members.map((m) => m.displayName || basename(m.repoPath));
    topicRows.push({
      kind: "topic",
      id: `topic:${t.id}`,
      title: t.name,
      trail: memberNames.join(", "),
      ticket: ticketOf(t.issue, null),
      dot: byTopic.get(t.id),
      target: { topic: t.id },
    });
    for (const [i, m] of t.members.entries()) {
      const root = memberRoot(m);
      members.push({
        kind: "member",
        id: `member:${t.id}:${m.repoPath}`,
        title: memberNames[i],
        trail: t.name,
        unitKind: "worktree",
        pr: input.prOf(m.repoPath, memberPrBranch(m, t.branch)),
        repo: input.originOf(m.repoPath),
        target: { topic: t.id, ...(root && { root }) },
      });
    }
  }

  const chatRows: Place[] = input.chats.map((c) => ({
    kind: "chat",
    id: `chat:${c.id}`,
    title: c.name ?? NEW_CHAT_NAME,
    trail: spaceLabel(c.space && known.has(c.space) ? c.space : GLOBAL_KEY),
    mentions: mentionsAt(
      c.sessions.flatMap((s) => input.mentionsOf(s.id)),
      null,
    ),
    dot: byFolder.get(c.folder),
    target: { chat: c.id },
  }));

  const sessionRows: Place[] = input.sessions.map((s) => {
    const topic = s.home.topic;
    const where = topic
      ? (topicName.get(topic) ?? s.home.project)
      : `${projectName.get(s.home.project) ?? basename(s.home.project)} / ${s.home.branch ?? basename(s.home.folder)}`;
    return {
      kind: "session",
      id: `session:${s.id}`,
      title: s.name || s.title || "Untitled session",
      trail: s.profile_label ? `${where}, ${s.profile_label}` : where,
      mentions: mentionsAt(input.mentionsOf(s.id), input.originOf(s.home.project)),
      dot: bySession.get(s.id),
      target: topic
        ? { topic, session: s.id }
        : { session: s.id, folder: s.home.folder, ...(s.home.branch && { branch: s.home.branch }), select: true },
    };
  });

  return [...spaces, ...projects, ...units, ...topicRows, ...members, ...reviews, ...chatRows, ...sessionRows];
}

const [tree, setTree] = createSignal<readonly NavSpace[]>([]);
const [origins, setOrigins] = createSignal<Readonly<Record<string, string | null>>>({});
const [overview, setOverview] = createSignal<readonly OverviewSession[]>([]);

/** Every space, Global included, as the sidebar resolved it. */
export function noteNavTree(spaces: readonly NavSpace[], originUrls: Readonly<Record<string, string | null>>) {
  setTree(spaces);
  setOrigins(originUrls);
}

/** Every project as the sidebar last resolved it, with its space's label. */
export function liveProjects(): { project: NavProject; space: string }[] {
  return tree().flatMap((g) => g.projects.map((project) => ({ project, space: spaceLabel(g.name) })));
}

/** The issue on the unit at `folderPath` and `branch`, as the sidebar last resolved it. */
export function linkedIssueAt(folderPath: string, branch: string): UnitIssue | null {
  for (const s of tree())
    for (const p of s.projects)
      for (const u of p.branchUnits) if (u.folderPath === folderPath && u.branch === branch) return u.issue ?? null;
  return null;
}

/** The unit a chat in `folder` runs on: its worktree, or a plain repo's checked-out branch. */
export function unitAt(folder: string): { projectPath: string; branch: string; issue?: UnitIssue } | null {
  for (const s of tree())
    for (const p of s.projects)
      for (const u of p.branchUnits)
        if (u.folderPath === folder && u.branch && (u.kind !== "plain" || u.isCurrent))
          return { projectPath: p.path, branch: u.branch, issue: u.issue };
  return null;
}

/** `owner/name`, lowercased, of the project's origin. */
export function liveOrigin(projectPath: string): string | null {
  const url = origins()[projectPath];
  return url ? originRepo(url) : null;
}

/** The PR on `branch`: the forge's in the active space, the remembered one elsewhere. */
export function livePr(projectPath: string, branch: string | null): PlacePr | undefined {
  const status = unitStatus(projectPath, branch);
  if (!status) {
    const last = branch ? rememberedPr(projectPath, branch) : null;
    return last
      ? { number: last.number, title: last.title, url: last.url, tone: "closed", remembered: true }
      : undefined;
  }
  const pr = status.pullRequest;
  if (!pr) return undefined;
  const asked = pr.state === "open" && (requestedReviews(projectPath)?.includes(pr.number) ?? false);
  const release = branch !== null && branch === defaultBranchOf(projectPath);
  const tone = prLineTone(status, forgeViewer(projectPath), asked, release);
  return { number: pr.number, title: pr.title, url: pr.url, tone };
}

/** Every place from the live stores. Reactive, so call it inside a memo. */
export function livePlaces(): Place[] {
  return buildPlaces({
    spaces: tree(),
    topics: topics(),
    chats: chats(),
    sessions: overview(),
    statuses: liveSessionStatuses(),
    prOf: livePr,
    originOf: liveOrigin,
    reviews: (projectPath) => reviewRequests(projectPath)?.rows ?? [],
    mentionsOf: (session) => mentionsOf(session).map(mentionId),
  });
}

// Latest request wins: a listing started later must not be overwritten by an
// earlier one that resolved later.
let seq = 0;
async function readOverview() {
  const mine = ++seq;
  const rows = await invoke<OverviewSession[] | null>("sessions_overview").catch(() => null);
  if (mine === seq && rows) setOverview(rows);
}

/** List every space's sessions now and again on each `sessions://changed`,
 *  until the returned function is called. The last listing stays for the next
 *  open to draw while it asks again. */
export function watchSessionsOverview(): () => void {
  void readOverview();
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void listen("sessions://changed", () => void readOverview()).then((off) => {
    if (stopped) off();
    else unlisten = off;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** Drop everything. Test support. */
export function resetNavIndexForTests() {
  setTree([]);
  setOrigins({});
  setOverview([]);
  seq = 0;
}
