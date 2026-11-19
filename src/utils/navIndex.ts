// The tree is fed by the sidebar, the only place that resolves the config.
// Other spaces' sessions come from one read-only listing and never enter the
// session store, which would put them on the needs-you pipeline and the probe.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NavTarget } from "./events";
import type { UnitIssue } from "./issues";
import { blockedOnUser, isWorking, type SessionHome, type SessionStatus } from "./sessionStatus";
import { liveSessionStatuses } from "./sessionActivity";
import { topics } from "./topicStore";
import { memberPrBranch, memberRoot, type Topic } from "./topics";
import { chats, NEW_CHAT_NAME, type Chat } from "./chats";
import { forgeViewer, requestedReviews, unitStatus } from "./forgeStatus";
import { defaultBranchOf } from "./defaultBranch";
import { prLineTone, type PrChildState } from "./prChildState";
import { GLOBAL_KEY, spaceLabel } from "./globalSpace";

export type NavUnit = { folderPath: string; branch: string | null; label: string; kind: string; issue?: UnitIssue };
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

export type PlaceKind = "space" | "project" | "unit" | "topic" | "member" | "chat" | "session";
export type PlaceDot = "needsYou" | "working";
export type PlacePr = { number: number; title: string; tone: PrChildState | "unlaned" };

export type Place = {
  kind: PlaceKind;
  id: string;
  title: string;
  trail: string;
  unitKind?: string;
  look?: { icon?: string; iconFile?: string; favicon?: string; seed: string };
  issue?: UnitIssue;
  pr?: PlacePr;
  dot?: PlaceDot;
  target: NavTarget;
};

type Status = { sessionId: string; status: SessionStatus; folderPath: string; home?: SessionHome | null };

export type PlaceInputs = {
  spaces: readonly NavSpace[];
  topics: readonly Topic[];
  chats: readonly Chat[];
  sessions: readonly OverviewSession[];
  statuses: readonly Status[];
  prOf: (projectPath: string, branch: string | null) => PlacePr | undefined;
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
          issue: u.issue,
          pr: u.branch ? input.prOf(p.path, u.branch) : undefined,
          dot,
          target: { folder: u.folderPath, ...(u.branch && { branch: u.branch }), select: true },
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
      issue: t.issue,
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
        target: { topic: t.id, ...(root && { root }) },
      });
    }
  }

  const chatRows: Place[] = input.chats.map((c) => ({
    kind: "chat",
    id: `chat:${c.id}`,
    title: c.name ?? NEW_CHAT_NAME,
    trail: spaceLabel(c.space && known.has(c.space) ? c.space : GLOBAL_KEY),
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
      dot: bySession.get(s.id),
      target: topic
        ? { topic, session: s.id }
        : { session: s.id, folder: s.home.folder, ...(s.home.branch && { branch: s.home.branch }), select: true },
    };
  });

  return [...spaces, ...projects, ...units, ...topicRows, ...members, ...chatRows, ...sessionRows];
}

const [tree, setTree] = createSignal<readonly NavSpace[]>([]);
const [overview, setOverview] = createSignal<readonly OverviewSession[]>([]);

/** Every space, Global included, as the sidebar resolved it. */
export function noteNavTree(spaces: readonly NavSpace[]) {
  setTree(spaces);
}

function livePr(projectPath: string, branch: string | null): PlacePr | undefined {
  const status = unitStatus(projectPath, branch);
  const pr = status?.pullRequest;
  if (!status || !pr) return undefined;
  const asked = pr.state === "open" && (requestedReviews(projectPath)?.includes(pr.number) ?? false);
  const release = branch !== null && branch === defaultBranchOf(projectPath);
  return { number: pr.number, title: pr.title, tone: prLineTone(status, forgeViewer(projectPath), asked, release) };
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
  setOverview([]);
  seq = 0;
}
