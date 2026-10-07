import { describe, expect, it } from "vite-plus/test";
import { keyed, navLevel, type NavProject, type NavSpace, type NavUnit } from "./mentionNavigator";

const unit = (folderPath: string, over: Partial<NavUnit> = {}): NavUnit => ({
  label: folderPath.split("/").pop()!,
  folderPath,
  branch: "main",
  kind: "worktree",
  isCurrent: false,
  ...over,
});
const project = (path: string, units: NavUnit[] = []): NavProject => ({
  name: path.split("/").pop()!,
  path,
  branchUnits: units,
});
const TORI = project("/code/tori", [unit("/code/tori/main"), unit("/code/tori/feat")]);
const SPACES: NavSpace[] = [
  { name: "Client Work", path: "/spaces/client-work", projects: [TORI, project("/other/tori")] },
  { name: "Home", path: "/spaces/home", projects: [project("/code/notes")] },
];

describe("keyed", () => {
  it("keys by the path's basename and numbers a repeat in order", () => {
    expect(keyed(SPACES[0].projects, (p) => p.path).map((k) => k.key)).toEqual(["tori", "tori-2"]);
  });
});

describe("navLevel", () => {
  it("lists spaces, then a space's projects, by path key", () => {
    expect(navLevel("spaces", "cli", SPACES, null)).toMatchObject({ level: "spaces", query: "cli" });
    expect(navLevel("spaces", "client-work/", SPACES, null)).toMatchObject({
      level: "projects",
      space: SPACES[0],
      query: "",
    });
  });

  it("drills a space, a project and a unit down to a file query, slashes kept", () => {
    expect(navLevel("spaces", "client-work/tori/main/src/ut", SPACES, null)).toMatchObject({
      level: "files",
      project: TORI,
      unit: TORI.branchUnits[0],
      query: "src/ut",
    });
  });

  it("starts @projects/ in the chat's own space", () => {
    expect(navLevel("projects", "tori-2/", SPACES, SPACES[0])).toMatchObject({
      level: "project",
      project: SPACES[0].projects[1],
    });
    expect(navLevel("projects", "", SPACES, null)).toBeNull();
  });

  it("is null when a segment names nothing", () => {
    expect(navLevel("spaces", "Client Work/", SPACES, null)).toBeNull();
    expect(navLevel("projects", "tori/nope/x", SPACES, SPACES[0])).toBeNull();
  });
});
