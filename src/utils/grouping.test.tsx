import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { MIXED } from "./grouping.fixture";

const calls = vi.hoisted(() => [] as { cmd: string; args: Record<string, unknown> }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "move_into_space") return Promise.resolve({ moves: [] });
    return Promise.resolve({});
  },
}));

const { applyPlan, hiddenAfter, initialPlan, rowProblems } = await import("./grouping");

describe("grouping", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("starts each project in its suggested space, or Home without one", () => {
    const plan = initialPlan(MIXED);
    expect(plan.rows.map((r) => [r.relative, r.space])).toEqual([
      ["office/x/repo", "office"],
      ["site", "fonngroup"],
      ["scratch", null],
    ]);
  });

  it("refuses two projects landing on one name, and one landing on a folder already there", () => {
    const plan = initialPlan(MIXED);
    plan.rows[1] = { ...plan.rows[1], space: "work", name: "api" };
    plan.rows[2] = { ...plan.rows[2], space: "work", name: "API" };
    let problems = rowProblems(MIXED, plan);
    expect(problems.get("/u/P/site")).toContain("already has a folder named api");
    expect(problems.get("/u/P/scratch")).toBeTruthy();

    plan.rows[1] = { ...plan.rows[1], space: "personal", name: "one" };
    plan.rows[2] = { ...plan.rows[2], space: "personal", name: "ONE" };
    problems = rowProblems(MIXED, plan);
    expect(problems.get("/u/P/site")).toContain("same name");
    expect(problems.get("/u/P/scratch")).toContain("same name");
  });

  it("hides folders left without a project, never one it could not read", () => {
    const plan = initialPlan(MIXED);
    expect(hiddenAfter(MIXED, plan)).toEqual(["screenshots"]);
    plan.rows[0] = { ...plan.rows[0], space: null };
    expect(hiddenAfter(MIXED, plan)).toEqual(["office", "screenshots"]);
    expect(hiddenAfter({ ...MIXED, folders: [...MIXED.folders, { name: "photos", entries: [] }] }, plan)).not.toContain(
      "photos",
    );
    expect(hiddenAfter(MIXED, { ...plan, keepEmpty: ["screenshots"] })).toEqual(["office"]);
  });

  it("applies in order: root, new spaces, moves, Home, then hidden folders", async () => {
    const plan = initialPlan(MIXED);
    await applyPlan(MIXED, plan, { setRoot: true });
    expect(calls.map((c) => c.cmd)).toEqual([
      "set_root",
      "add_space",
      "move_into_space",
      "attach_folder",
      "hide_spaces",
    ]);
    expect(calls[1].args.name).toBe("fonngroup");
    expect(calls[2].args.moves).toEqual([
      { space: "office", name: "repo", path: "/u/P/office/x/repo" },
      { space: "fonngroup", name: "site", path: "/u/P/site" },
    ]);
    expect(calls[3].args).toEqual({ path: "/u/P/scratch", name: "scratch" });
    expect(calls[4].args).toEqual({ names: ["screenshots"] });
  });
});
