// The forge polls the active space only, so after a restart every other space
// has no pull requests until it is opened. This keeps the last answer per
// branch so the navigator can still find a branch by its pull request number.
import { createLiveSignal } from "../lib/liveState";
import type { PrState, UnitStatus } from "./forgeTypes";
import { onForgeReport, projectStatuses } from "./forgeStatus";

const LS_PR_MEMORY = "tori.prMemory";
const CAP = 500;

export type RememberedPr = { number: number; title: string; state: PrState; url: string; changedAt: number };

type Store = Record<string, Record<string, RememberedPr>>;

function valid(v: unknown): v is RememberedPr {
  const r = v as RememberedPr;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.number === "number" &&
    typeof r.title === "string" &&
    typeof r.state === "string" &&
    typeof r.url === "string" &&
    typeof r.changedAt === "number"
  );
}

function load(): Store {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_PR_MEMORY) ?? "{}");
    const out: Store = {};
    for (const [project, branches] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof branches !== "object" || branches === null) continue;
      const kept = Object.fromEntries(Object.entries(branches).filter(([, pr]) => valid(pr)));
      if (Object.keys(kept).length) out[project] = kept as Record<string, RememberedPr>;
    }
    return out;
  } catch {
    return {};
  }
}

function capped(store: Store): Store {
  const all = Object.entries(store).flatMap(([project, branches]) =>
    Object.entries(branches).map(([branch, pr]) => ({ project, branch, at: pr.changedAt })),
  );
  if (all.length <= CAP) return store;
  const out: Store = {};
  for (const { project, branch } of all.sort((a, b) => b.at - a.at).slice(0, CAP)) {
    (out[project] ??= {})[branch] = store[project][branch];
  }
  return out;
}

const [memory, setMemory] = createLiveSignal<Store>(load());

const same = (a: RememberedPr | undefined, b: Omit<RememberedPr, "changedAt">) =>
  !!a && a.number === b.number && a.title === b.title && a.state === b.state && a.url === b.url;

/** Fold in what one tick said about a project's branches: a branch with a pull
 *  request is remembered, a branch the forge says has none is forgotten. */
export function rememberPrs(project: string, statuses: Record<string, UnitStatus>, now = Date.now()) {
  const before = memory()[project] ?? {};
  const branches = { ...before };
  let changed = false;
  for (const [branch, status] of Object.entries(statuses)) {
    const pr = status.pullRequest;
    if (!pr) {
      changed ||= branch in branches;
      delete branches[branch];
      continue;
    }
    const next = { number: pr.number, title: pr.title, state: pr.state, url: pr.url };
    if (same(branches[branch], next)) continue;
    branches[branch] = { ...next, changedAt: now };
    changed = true;
  }
  if (!changed) return;
  const store = capped({ ...memory(), [project]: branches });
  setMemory(store);
  try {
    localStorage.setItem(LS_PR_MEMORY, JSON.stringify(store));
  } catch {
    // Quota or private mode: other spaces' numbers wait for their first poll.
  }
}

/** The pull request a branch last had, as the forge last told it. Reactive. */
export function rememberedPr(project: string, branch: string): RememberedPr | null {
  return memory()[project]?.[branch] ?? null;
}

/** Keep every forge answer from now on, until the returned function is called. */
export function startPrMemory(): () => void {
  return onForgeReport((project) => rememberPrs(project, projectStatuses(project)));
}
