import { describe, it, expect } from "vite-plus/test";
import { buildPlaces, type PlaceInputs } from "./navIndex";
import type { Topic } from "./topics";

const REPO = "/root/work/tori";
const WT = "/root/work/tori-wt/side-panel";

const topic: Topic = {
  id: "side-1",
  name: "side-panel-rollout",
  branch: "side-panel",
  createdAt: 0,
  space: "work",
  home: "/cfg/topics/side-1",
  issue: { key: "92", display: "#92", url: "https://example.test/92", title: "Browser side panel" },
  members: [
    {
      repoPath: REPO,
      displayName: "tori",
      mode: "worktree",
      worktreePath: `${REPO}/.tori/worktrees/side-panel`,
      state: { kind: "present" },
      order: 0,
    },
    {
      repoPath: "/root/work/relay",
      displayName: "relay",
      mode: "worktree",
      worktreePath: "/root/work/relay/.tori/worktrees/side-panel",
      state: { kind: "worktree-missing" },
      order: 1,
    },
  ],
};

function inputs(over: Partial<PlaceInputs> = {}): PlaceInputs {
  return {
    spaces: [
      {
        name: "work",
        icon: "Briefcase",
        projects: [
          {
            name: "tori",
            path: REPO,
            branchUnits: [
              { folderPath: REPO, branch: "main", label: "main", kind: "plain" },
              {
                folderPath: WT,
                branch: "side-panel",
                label: "side-panel",
                kind: "worktree",
                issue: { key: "92", display: "#92", url: "https://example.test/92", title: "Browser side panel" },
              },
              { folderPath: `${REPO}/.tori/worktrees/side-panel`, branch: "side-panel", label: "x", kind: "worktree" },
            ],
          },
        ],
      },
      { name: "/global", projects: [] },
    ],
    topics: [topic],
    chats: [{ id: "c1", space: null, folder: "/chats/.home/c1", sessions: [], name: "Release notes", updated: 0 }],
    sessions: [
      {
        id: "s1",
        title: "Wire chat into side panel",
        name: null,
        agent: "claude",
        profile_label: null,
        last_active: 2,
        home: { project: REPO, folder: WT, branch: "side-panel" },
      },
      {
        id: "s2",
        title: "t",
        name: "Topic chat",
        agent: "claude",
        profile_label: "Work",
        last_active: 1,
        home: { project: "side-panel-rollout", folder: "/cfg/topics/side-1", branch: "side-panel", topic: "side-1" },
      },
    ],
    statuses: [],
    prOf: (_project, branch) =>
      branch === "side-panel"
        ? { number: 214, title: "Side panel", url: "https://example.test/pull/214", tone: "approved" }
        : undefined,
    originOf: () => null,
    reviews: () => [],
    mentionsOf: () => [],
    ...over,
  };
}

const byId = (id: string) => buildPlaces(inputs()).find((p) => p.id === id);

describe("the navigator's places", () => {
  it("lists every kind, spaces first and sessions last", () => {
    const kinds = buildPlaces(inputs()).map((p) => p.kind);
    expect([...new Set(kinds)]).toEqual(["space", "project", "unit", "topic", "member", "chat", "session"]);
  });

  it("names a space and Home, and a project by the space it sits in", () => {
    expect(byId("space:work")).toMatchObject({ title: "work", trail: "1 project", target: { space: "work" } });
    expect(byId("space:/global")).toMatchObject({ title: "Home", trail: "0 projects", target: { space: "Home" } });
    expect(byId(`project:${REPO}`)).toMatchObject({ title: "tori", trail: "work", target: { project: REPO } });
  });

  it("gives a unit its branch, trail, ticket, pull request and a target that selects it", () => {
    expect(byId(`unit:${WT} side-panel`)).toMatchObject({
      title: "side-panel",
      trail: "work / tori",
      ticket: { label: "#92" },
      pr: { number: 214, tone: "approved" },
      target: { folder: WT, branch: "side-panel", select: true },
    });
  });

  it("leaves a Topic's own worktree to the Topic rather than listing it twice", () => {
    expect(byId(`unit:${REPO}/.tori/worktrees/side-panel side-panel`)).toBeUndefined();
  });

  it("lists a Topic with its members, one of them with its worktree missing", () => {
    expect(byId("topic:side-1")).toMatchObject({ trail: "tori, relay", ticket: { label: "#92" } });
    expect(byId(`member:side-1:${REPO}`)).toMatchObject({
      title: "tori",
      trail: "side-panel-rollout",
      target: { topic: "side-1", root: `${REPO}/.tori/worktrees/side-panel` },
    });
    const missing = byId("member:side-1:/root/work/relay");
    expect(missing).toMatchObject({ title: "relay", target: { topic: "side-1" } });
    expect(missing).not.toHaveProperty("target.root");
  });

  it("lists a chat under its space, Home when it has none", () => {
    expect(byId("chat:c1")).toMatchObject({ title: "Release notes", trail: "Home", target: { chat: "c1" } });
  });

  it("opens a unit's session in its unit and a Topic's session in the Topic", () => {
    expect(byId("session:s1")).toMatchObject({
      title: "Wire chat into side panel",
      trail: "tori / side-panel",
      target: { session: "s1", folder: WT, branch: "side-panel", select: true },
    });
    expect(byId("session:s2")).toMatchObject({
      title: "Topic chat",
      trail: "side-panel-rollout, Work",
      target: { topic: "side-1", session: "s2" },
    });
  });

  it("marks what is waiting on you over what is working, up to the project", () => {
    const places = buildPlaces(
      inputs({
        statuses: [
          {
            sessionId: "s1",
            status: "executing",
            folderPath: WT,
            home: { project: REPO, folder: WT, branch: "side-panel" },
          },
          {
            sessionId: "s9",
            status: "waitingForApproval",
            folderPath: WT,
            home: { project: REPO, folder: WT, branch: "side-panel" },
          },
        ],
      }),
    );
    const dot = (id: string) => places.find((p) => p.id === id)?.dot;
    expect(dot("session:s1")).toBe("working");
    expect(dot(`unit:${WT} side-panel`)).toBe("needsYou");
    expect(dot(`project:${REPO}`)).toBe("needsYou");
    expect(dot(`unit:${REPO} main`)).toBeUndefined();
  });
});
